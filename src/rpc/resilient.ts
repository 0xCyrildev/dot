import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { AccountInfo, SolanaClient } from './client.js';
import { DotError, isDotError } from '../errors.js';

/**
 * Multi-endpoint reads for the handful of values a report cannot be wrong about.
 *
 * The premise of a security tool is that its inputs are true. Every number Dot
 * prints is what *one RPC node chose to return*, and a provider can cache, filter,
 * lag, or serve a node that is behind — so a quiet blast radius can mean a quiet
 * node. This wrapper does not solve that; it makes the failure visible on the one
 * read that triggers everything else: the `ProgramData` account whose hash decides
 * whether an upgrade happened.
 *
 * The comparison is deliberately narrow, because a naive "the two nodes disagree"
 * check fires constantly and would train everyone to ignore it:
 *
 *  - Nodes at different slots are **not** in disagreement. Two endpoints 40 slots
 *    apart legitimately hold different bytes for a program that was just upgraded.
 *    That is reported `slot_mismatch` / inconclusive, not as an integrity failure.
 *  - Same slot, different lamports / owner / data hash → real disagreement, and the
 *    run halts. One of those endpoints is lying or broken and no conclusion drawn
 *    from either is trustworthy.
 *  - One endpoint answers and the other fails → proceed, but the report says
 *    `single_source`: the claim is only as good as an unverified node.
 */

export type Agreement = 'agreed' | 'disagreed' | 'slot_mismatch' | 'single_source' | 'both_failed' | 'not_checked';

export type EndpointVerdict = {
  url: string;
  ok: boolean;
  slot: number | null;
  error?: string;
};

export type QuorumRead = {
  agreement: Agreement;
  /** The account to continue with, when continuing is defensible at all. */
  account: AccountInfo | null;
  /** Redacted endpoint labels — never the query string, which carries the API key. */
  endpoints: EndpointVerdict[];
  reason: string;
  /** True only when the halt is an integrity halt, not a data-availability halt. */
  halt: boolean;
};

export type ResilientOptions = {
  /** Redact credentials in endpoint labels for the report. */
  label?: (url: string) => string;
};

export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return [...u.searchParams.keys()].length > 0 ? `${u.origin}${u.pathname}?<redacted>` : `${u.origin}${u.pathname}`;
  } catch {
    return '<unparseable-endpoint>';
  }
}

export class ResilientClient {
  private readonly label: (url: string) => string;

  /**
   * `clients` must be peers, not one client's retries: each needs its own
   * `Budget`, otherwise spending on endpoint A silently decrements endpoint B and
   * the reported call count stops meaning anything.
   */
  constructor(
    private readonly clients: Array<{ client: SolanaClient; url: string }>,
    opts: ResilientOptions = {},
  ) {
    this.label = opts.label ?? redactUrl;
    if (clients.length === 0) throw new DotError('RPC_TRANSPORT', 'ResilientClient needs at least one endpoint', {});
  }

  endpointCount(): number {
    return this.clients.length;
  }

  /**
   * Read one account from every endpoint and judge whether they agree.
   *
   * Reads run in parallel: sequential quorum reads double the latency of the
   * perceive step, which is the step that is supposed to stay cheap enough to run
   * on every event.
   */
  async getAccountInfoQuorum(address: string): Promise<QuorumRead> {
    const settled = await Promise.allSettled(
      this.clients.map(async ({ client, url }) => {
        const raw = await client.getRawAccountInfo(address);
        return { url, ...raw };
      }),
    );

    const verdicts: EndpointVerdict[] = [];
    const ok: Array<{ url: string; slot: number; account: AccountInfo; digest: string }> = [];
    settled.forEach((res, i) => {
      const url = this.clients[i]!.url;
      if (res.status === 'fulfilled') {
        verdicts.push({ url: this.label(url), ok: true, slot: res.value.slot });
        if (res.value.account) {
          ok.push({
            url,
            slot: res.value.slot,
            account: res.value.account,
            digest: digestAccount(res.value.account),
          });
        } else {
          ok.push({ url, slot: res.value.slot, account: emptyAccount(address), digest: 'ABSENT' });
        }
      } else {
        const e = res.reason;
        verdicts.push({
          url: this.label(url),
          ok: false,
          slot: null,
          error: isDotError(e) ? `${e.code}: ${e.message}` : String((e as Error)?.message ?? e),
        });
      }
    });

    if (this.clients.length === 1) {
      return {
        agreement: 'not_checked',
        account: ok[0]?.account ?? null,
        endpoints: verdicts,
        reason: 'a single endpoint cannot corroborate anything; every figure in this report is one node’s word',
        halt: false,
      };
    }

    if (ok.length === 0) {
      return {
        agreement: 'both_failed',
        account: null,
        endpoints: verdicts,
        reason: 'no endpoint would serve this account — Dot has no basis for a conclusion, so it declines to draw one',
        halt: true,
      };
    }

    if (ok.length === 1) {
      return {
        agreement: 'single_source',
        account: ok[0]!.account,
        endpoints: verdicts,
        reason: `${this.clients.length - 1} of ${this.clients.length} endpoints failed; the upgrade hash here is uncorroborated`,
        halt: false,
      };
    }

    const slots = new Set(ok.map((o) => o.slot));
    if (slots.size > 1) {
      return {
        agreement: 'slot_mismatch',
        account: ok[0]!.account,
        endpoints: verdicts,
        reason: `endpoints answered at different slots (${[...slots].join(', ')}); different bytes there is chain progress, not a contradiction, so the comparison is inconclusive`,
        halt: false,
      };
    }

    const digests = new Set(ok.map((o) => o.digest));
    if (digests.size > 1) {
      return {
        agreement: 'disagreed',
        account: null,
        endpoints: verdicts,
        reason: `endpoints agree on slot ${ok[0]!.slot} but disagree on the account bytes/digest (${[...digests].map((d) => d.slice(0, 12)).join(' vs ')}). At least one is lying, cached, or broken; nothing downstream of this read is trustworthy`,
        halt: true,
      };
    }

    return {
      agreement: 'agreed',
      account: ok[0]!.account,
      endpoints: verdicts,
      reason: `${ok.length} endpoints independently returned the same bytes at slot ${ok[0]!.slot}`,
      halt: false,
    };
  }
}

function emptyAccount(address: string): AccountInfo {
  return { address, lamports: 0, owner: '', executable: false, data: Buffer.alloc(0) };
}

/** Order matters: `ABSENT` for a null account is a real disagreement signal too —
 *  one node serving a deleted ProgramData while another serves it is exactly the
 *  kind of thing a watcher must not average away. */
function digestAccount(a: AccountInfo): string {
  const h = createHash('sha256');
  h.update(a.owner);
  h.update(':');
  h.update(String(a.lamports));
  h.update(':');
  h.update(String(a.executable));
  h.update(':');
  h.update(a.data);
  return h.digest('hex');
}

import { createHash } from 'node:crypto';
import { Budget } from '../agent/budget.js';
import { DotError, isDotError } from '../errors.js';
import { redactUrl } from './resilient.js';
import type { SolanaClient, TxFetchResult } from './client.js';
import type { WireGetTransactionResult, WireSignatureStatus } from './wire.js';

/**
 * "Are you sure?" asked of the chain, with the chain's own answers.
 *
 * Everything else in Dot is one node's word about a program. `ResilientClient` already
 * halts when two nodes contradict each other about the *upgradeable account*; this module
 * goes one step further and asks the second node about the things the *report* rests on —
 * the account whose bytes produced the diff, and the transactions whose instructions
 * produced the edges. `chain_verified: true` is a claim about those, and nothing else.
 *
 * What it cannot be, stated where the flag is printed:
 *
 * - **not a consensus proof.** Core RPC exposes no inclusion proof and no slot-hashes
 *   read, so Dot cannot show a transaction is in the canonical ledger — only that two
 *   endpoints describe it identically. A node can serve a finalized-looking transaction
 *   that never landed; two nodes from the same provider can agree because they are the
 *   same source.
 * - **not provider independence.** A hostname is the only handle Dot has, and hostnames
 *   lie about ownership (farms, resellers, cached proxies). The endpoints asked are
 *   printed so a reviewer can judge the pair, not so Dot can claim the pair is
 *   independent.
 * - **not a substitute for `agreement`.** It never overrides a halt; a run that halted on
 *   an integrity disagreement has no report to verify.
 */

export type CheckCoverage = 'corroborated' | 'single_source' | 'unavailable';

/**
 * What a check concluded, kept separate from whether it had two sources.
 *
 * `inconclusive` exists because the two failures are different animals and a reader has to
 * be able to tell them apart: endpoints that answered at *different slots* are not
 * contradicting each other — the chain moved between the reads, and no honest comparison
 * exists — while endpoints that answer the same slot with different bytes are saying
 * incompatible things about the ledger. Calling the first one a contradiction would train
 * a reviewer to ignore the second.
 */
export type CheckVerdict = 'agree' | 'contradict' | 'inconclusive' | 'unconfirmed';

export type VerificationCheck = {
  name: string;
  /** What was compared, in one line, with the numbers a reader can re-derive. */
  detail: string;
  /** `passed` is `verdict === 'agree'`; kept because every existing consumer reads it. */
  passed: boolean;
  verdict: CheckVerdict;
  coverage: CheckCoverage;
  rpcCalls: number;
};

export type ChainVerification = {
  /** True only when a second endpoint exists AND every check was corroborated and passed. */
  verified: boolean;
  /** Why it is false. Absent only when verified is true. */
  reason: string | null;
  /** Redacted — the query string carries the provider key. */
  endpoints: string[];
  /** The slot the account reads were pinned to, so agreement is about one moment. */
  slot: number | null;
  checks: VerificationCheck[];
  /** Sampled transaction signatures the edges were built from, or none if nothing was sampled. */
  sampledSignatures: number;
  cannotProve: string;
};

export const CANNOT_PROVE =
  'Two endpoints describing the same bytes and the same transactions is corroboration, not proof. Core RPC exposes no inclusion proof and no slot-hashes read, so nothing here shows a sampled transaction is in the canonical ledger, and no check can tell whether the two endpoints are genuinely independent sources or one provider answering twice. Measured on mainnet 2026-10-21: two public endpoints asked concurrently still answered the same getAccountInfo 9 slots apart, and `minContextSlot` is a lower bound rather than a fix — so a *mutable* account cannot be compared at one moment over plain RPC at all. Finalized transactions can be, because they do not change.';

/** Canonical JSON: key order is not part of the value, so it must not be part of the digest either. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

export function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex').slice(0, 16);
}

/** Bytes of an account, as read. `null` account digests as ABSENT, which is a value, not a gap. */
function digestAccountBytes(account: { lamports: number; owner: string; executable: boolean; data: Buffer } | null): string {
  if (!account) return 'ABSENT';
  return createHash('sha256').update(account.data).digest('hex').slice(0, 16);
}

/**
 * The part of a transaction Dot's edges are built from, hashed as one value.
 *
 * `logMessages` is excluded on purpose: nodes cap logs differently, so a mismatch there is
 * usually a provider setting rather than a contradiction about the chain — and a check that
 * cries wolf on every log-truncated transaction teaches the reader to ignore it. Balances
 * are included: two nodes disagreeing about a balance delta is exactly the lie worth
 * catching, and it is the number the value-routed proxy is derived from.
 */
export function transactionFingerprint(tx: WireGetTransactionResult): { hex: string; slot: number; instructionCount: number } {
  const outer = tx.transaction?.message?.instructions ?? [];
  const body = {
    slot: tx.slot,
    err: tx.meta?.err ?? null,
    accountKeys: tx.transaction?.message?.accountKeys ?? null,
    instructions: outer.map((i) => ({
      programId: i.programId ?? null,
      accounts: i.accounts ?? null,
      data: i.data ?? null,
    })),
    inner: (tx.meta?.innerInstructions ?? []).map((g) => ({
      index: g.index,
      instructions: (g.instructions ?? []).map((i) => ({
        programId: i.programId ?? null,
        accounts: i.accounts ?? null,
        data: i.data ?? null,
      })),
    })),
    preBalances: tx.meta?.preBalances ?? null,
    postBalances: tx.meta?.postBalances ?? null,
  };
  return { hex: digest(body), slot: tx.slot, instructionCount: outer.length };
}

export type VerifierOptions = {
  /** Signatures cross-checked. Each costs one call per endpoint, so this is the price of the flag. */
  sample?: number;
  label?: (url: string) => string;
};

type Endpoint = { client: SolanaClient; url: string };

export class ChainVerifier {
  private readonly label: (url: string) => string;
  private readonly sample: number;

  constructor(
    private readonly endpoints: Endpoint[],
    private readonly budget: Budget,
    opts: VerifierOptions = {},
  ) {
    this.label = opts.label ?? redactUrl;
    this.sample = Math.max(0, opts.sample ?? 3);
  }

  /** The floor: two account reads and one status batch per endpoint, before any transaction. */
  static minCost(endpoints: number): number {
    return endpoints * 3;
  }

  static cost(endpoints: number, sample: number): number {
    return endpoints * (2 + sample + 1);
  }

  private get corroborationPossible(): boolean {
    return this.endpoints.length >= 2;
  }

  /**
   * One method, every endpoint, same arguments. Settled rather than awaited so one dead
   * node cannot throw the verification away — it becomes `single_source`, which is a
   * statement about Dot's visibility, not about the chain.
   */
  private async ask<T>(name: string, fn: (client: SolanaClient) => Promise<T>): Promise<Array<{ url: string; ok: boolean; value?: T; error?: string }>> {
    const settled = await Promise.allSettled(this.endpoints.map((e) => fn(e.client)));
    return settled.map((res, i) =>
      res.status === 'fulfilled'
        ? { url: this.label(this.endpoints[i]!.url), ok: true, value: res.value }
        : { url: this.label(this.endpoints[i]!.url), ok: false, error: isDotError(res.reason) ? `${res.reason.code}: ${res.reason.message}` : String((res.reason as Error)?.message ?? res.reason) },
    );
  }

  async verify(input: { program: string; programData: string; signatures: string[] }): Promise<ChainVerification> {
    const checks: VerificationCheck[] = [];
    const endpoints = this.endpoints.map((e) => this.label(e.url));

    if (!this.corroborationPossible) {
      return {
        verified: false,
        reason: `only ${this.endpoints.length} endpoint${this.endpoints.length === 1 ? '' : 's'} configured — verification needs a second source, and a single node cannot corroborate itself`,
        endpoints,
        slot: null,
        checks,
        sampledSignatures: 0,
        cannotProve: CANNOT_PROVE,
      };
    }

    // Price it before spending: a run that has 4 calls left must not discover mid-check
    // that the third endpoint read is refused, and report a half-done verification as one
    // that passed.
    const wanted = Math.min(this.sample, input.signatures.length);
    const cost = ChainVerifier.cost(this.endpoints.length, wanted);
    const remaining = this.budget.snapshot().remaining.rpcCalls;
    if (remaining < ChainVerifier.minCost(this.endpoints.length)) {
      return {
        verified: false,
        reason: `verification refused: ${remaining} RPC call(s) left, ${ChainVerifier.minCost(this.endpoints.length)} needed for the two account reads alone`,
        endpoints,
        slot: null,
        checks,
        sampledSignatures: 0,
        cannotProve: CANNOT_PROVE,
      };
    }
    const priced = wanted > 0 && remaining < cost ? Math.max(0, Math.floor(remaining / this.endpoints.length) - 3) : wanted;

    const c = (name: string, verdict: CheckVerdict, coverage: CheckCoverage, detail: string, rpcCalls: number): VerificationCheck => ({
      name,
      verdict,
      coverage,
      detail,
      passed: verdict === 'agree',
      rpcCalls,
    });

    // 1. The ProgramData bytes — the account the bytecode diff and the tier are built from.
    const pd = await this.ask('getAccountInfo', (x) => x.getRawAccountInfo(input.programData));
    const pdOk = pd.filter((x) => x.ok);
    const pdSlots = [...new Set(pdOk.map((x) => x.value!.slot))];
    const pdDigests = [...new Set(pdOk.map((x) => digestAccountBytes(x.value!.account)))];
    checks.push(
      pdOk.length < 2
        ? c(
            'programdata_bytes',
            'unconfirmed',
            pdOk.length === 1 ? 'single_source' : 'unavailable',
            `${pdOk.length} of ${this.endpoints.length} endpoints answered: ${pd.map((x) => `${x.url}${x.ok ? ` digest=${digestAccountBytes(x.value!.account)}` : ` ${x.error}`}`).join(' | ')}`,
            this.endpoints.length,
          )
        : pdSlots.length > 1
          ? c(
              'programdata_bytes',
              'inconclusive',
              'corroborated',
              `endpoints answered at different slots (${pdSlots.join(', ')}) — the chain moved between the reads, so differing bytes here are progress, not a contradiction, and nothing is concluded`,
              this.endpoints.length,
            )
          : c(
              'programdata_bytes',
              pdDigests.length === 1 ? 'agree' : 'contradict',
              'corroborated',
              `slot ${pdSlots[0]}, ${input.programData}: ${pdDigests.length === 1 ? `identical bytes (${pdDigests[0]}) on ${pdOk.length} endpoints` : `CONTRADICTION — digests ${pdDigests.join(' vs ')} at the same slot`}`,
              this.endpoints.length,
            ),
    );

    // 2. The Program account — the pointer that says this ProgramData is the one executed.
    const pr = await this.ask('getAccountInfo', (x) => x.getRawAccountInfo(input.program));
    const prOk = pr.filter((x) => x.ok);
    const prSlots = [...new Set(prOk.map((x) => x.value!.slot))];
    const prDigests = [...new Set(prOk.map((x) => digestAccountBytes(x.value!.account)))];
    checks.push(
      prOk.length < 2
        ? c('program_pointer', 'unconfirmed', prOk.length === 1 ? 'single_source' : 'unavailable', `${prOk.length} of ${this.endpoints.length} endpoints answered the Program account`, this.endpoints.length)
        : prSlots.length > 1
          ? c('program_pointer', 'inconclusive', 'corroborated', `endpoints answered at different slots (${prSlots.join(', ')}); the pointer bytes were not comparable`, this.endpoints.length)
          : c(
              'program_pointer',
              prDigests.length === 1 ? 'agree' : 'contradict',
              'corroborated',
              `${input.program}: ${prDigests.length === 1 ? `identical (${prDigests[0]}) on ${prOk.length} endpoints at slot ${prSlots[0]}` : `CONTRADICTION — digests ${prDigests.join(' vs ')} at the same slot`}`,
              this.endpoints.length,
            ),
    );

    // 3. The transactions the edges were built from. A graph from traces only one node
    //    will show is not a corroborated graph.
    const sample = input.signatures.slice(0, priced);
    if (sample.length === 0) {
      checks.push(
        c('transaction_roundtrip', 'unconfirmed', 'unavailable', 'no signature was available to cross-check — this run built no edges, so there is nothing for a second node to agree with', 0),
      );
    } else {
      const perEndpoint = await this.ask('getTransaction', async (x) => {
        const out: Record<string, string | null> = {};
        for (const sig of sample) {
          const r: TxFetchResult = await x.getTransaction(sig);
          out[sig] = r.status === 'found' ? transactionFingerprint(r.tx!).hex : r.status;
        }
        return out;
      });
      const txCalls = sample.length * this.endpoints.length;
      const okE = perEndpoint.filter((x) => x.ok);
      if (okE.length < 2) {
        checks.push(
          c(
            'transaction_roundtrip',
            'unconfirmed',
            okE.length === 1 ? 'single_source' : 'unavailable',
            `${okE.length} of ${this.endpoints.length} endpoints completed the sample: ${perEndpoint.map((x) => `${x.url}${x.ok ? '' : ` ${x.error}`}`).join(' | ')}`,
            txCalls,
          ),
        );
      } else {
        const agree = sample.every((sig) => {
          const vals = okE.map((x) => x.value![sig] ?? 'MISSING');
          return new Set(vals).size === 1 && vals[0] !== 'pruned' && vals[0] !== 'error';
        });
        const refused = sample.filter((sig) => okE.some((x) => x.value![sig] === 'pruned' || x.value![sig] === 'error'));
        const contradicted = sample.filter((sig) => {
          const vals = okE.map((x) => x.value![sig] ?? 'MISSING');
          return new Set(vals).size > 1 && !vals.includes('pruned') && !vals.includes('error');
        });
        checks.push(
          c(
            'transaction_roundtrip',
            agree ? 'agree' : contradicted.length > 0 ? 'contradict' : 'inconclusive',
            'corroborated',
            agree
              ? `${sample.length} sampled transaction(s) carry the same instructions, accounts, slot and balance deltas on ${okE.length} endpoints`
              : contradicted.length > 0
                ? `CONTRADICTION at the same slot on ${contradicted.length} sampled transaction(s): ${contradicted.map((s) => `${s.slice(0, 8)}…[${okE.map((x) => x.value![s] ?? 'missing').join(' vs ')}]`).join(' ')}`
                : `${refused.length}/${sample.length} sampled transaction(s) could not be compared — ${refused.map((s) => `${s.slice(0, 8)}…[${okE.map((x) => x.value![s] ?? 'missing').join('/')}]`).join(' ')}: pruned or refused history is not corroboration`,
            txCalls,
          ),
        );
      }

      // 4. Finality as the nodes report it. This is the nodes' own claim about their
      //    ledger, which is why it is a check and not a proof.
      const statusCalls = this.endpoints.length;
      try {
        const st = await this.ask('getSignatureStatuses', (x) => x.getSignatureStatuses(sample));
        const stOk = st.filter((x) => x.ok);
        const norm = (s: WireSignatureStatus | null) => (s ? `${s.slot}:${s.confirmationStatus ?? 'unknown'}:${s.err === null || s.err === undefined ? 'ok' : 'err'}` : 'unknown');
        // Three outcomes per signature, and they are not the same thing:
        // every node that can see it says the same → agreement; a node that cannot see it
        // at all → a retention gap, which proves nothing; two nodes that both see it and
        // describe it differently → a contradiction about the ledger.
        const perSig = sample.map((_, i) => {
          const vals = stOk.map((x) => norm(x.value![i] ?? null));
          const seen = vals.filter((v) => v !== 'unknown');
          const gaps = vals.filter((v) => v === 'unknown').length;
          if (new Set(seen).size > 1) return { kind: 'contradict' as const, vals };
          if (seen.length === 0) return { kind: 'gap' as const, vals };
          if (gaps > 0) return { kind: 'gap' as const, vals };
          return { kind: 'agree' as const, vals };
        });
        const contradicted = perSig.filter((p) => p.kind === 'contradict');
        const gaps = perSig.filter((p) => p.kind === 'gap');
        const notFinal = perSig.filter((p) => p.kind === 'agree' && !p.vals.every((v) => v.endsWith(':finalized:ok')));
        const verdict: CheckVerdict =
          stOk.length < 2 ? 'unconfirmed' : contradicted.length > 0 ? 'contradict' : gaps.length > 0 || notFinal.length > 0 ? 'inconclusive' : 'agree';
        checks.push(
          c(
            'signature_finality',
            verdict,
            stOk.length >= 2 ? 'corroborated' : stOk.length === 1 ? 'single_source' : 'unavailable',
            stOk.length < 2
              ? `${stOk.length} of ${this.endpoints.length} endpoints answered getSignatureStatuses`
              : `${perSig.length - gaps.length - contradicted.length}/${perSig.length} sampled signature(s) described identically by every endpoint that could see them` +
                (gaps.length > 0 ? `; ${gaps.length} not visible to at least one endpoint (retention differs between providers, which is a gap in what can be compared, not a disagreement)` : '') +
                (contradicted.length > 0 ? `; CONTRADICTION on ${contradicted.length}: ${contradicted.map((p) => p.vals.join(' vs ')).join(' | ')}` : '') +
                (notFinal.length > 0 ? `; ${notFinal.length} agreed but not finalized-and-clean, which is a statement about the sample, not the program` : ''),
            statusCalls,
          ),
        );
      } catch (e) {
        checks.push(c('signature_finality', 'unconfirmed', 'unavailable', `check not run: ${e instanceof DotError ? `${e.code}: ${e.message}` : String(e)}`, statusCalls));
      }
    }

    const corroborated = checks.every((x) => x.coverage === 'corroborated');
    const agreed = checks.every((x) => x.verdict === 'agree');
    const contradictions = checks.filter((x) => x.verdict === 'contradict');
    const inconclusive = checks.filter((x) => x.verdict === 'inconclusive');
    const unconfirmed = checks.filter((x) => x.coverage !== 'corroborated');
    const verified = corroborated && agreed;
    return {
      verified,
      reason: verified
        ? null
        : !corroborated
          ? `not every check had two sources: ${unconfirmed.map((x) => `${x.name}=${x.coverage}`).join(', ')}`
          : contradictions.length > 0
            ? `endpoints contradict each other about the same slot on: ${contradictions.map((x) => x.name).join(', ')}`
            : `every check had two sources, but ${inconclusive.map((x) => x.name).join(', ')} could not be compared — absence of a contradiction is not agreement`,
      endpoints,
      slot: pdOk[0]?.value?.slot ?? null,
      checks,
      sampledSignatures: sample.length,
      cannotProve: CANNOT_PROVE,
    };
  }
}

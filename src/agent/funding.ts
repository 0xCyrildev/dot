import type { SolanaClient } from '../rpc/client.js';
import { resolveAccountKeys } from '../graph/keys.js';
import type { FundingEvidence } from '../score/danger.js';

/**
 * Authority funding provenance — the one malice axis that needs a chain read.
 *
 * What it can honestly establish, and what it cannot:
 *
 * - **A named suspect counterparty.** If an address the operator put on the list sent SOL to the
 *   authority inside the fetched window, that is a direct observation, and it is the strongest thing
 *   this probe returns. Dot ships **no** mixer or obfuscation list of its own: an allowlist invented
 *   here would be a claim about the world with no source, so the set comes from the operator and the
 *   axis is simply unmeasured without it.
 * - **A young wallet.** Provable only as far as the node's history reaches. `getSignaturesForAddress`
 *   returning fewer entries than asked means *this node* has nothing older, which is also what a node
 *   with a trimmed retention window says — `HISTORY_RETENTION` — so `retentionBounded` is set whenever
 *   the walk did not demonstrably reach the account's first transaction, and the scoring axis withholds
 *   its top band while it is true. A missing check is not a clean check, and a truncated history is
 *   not a genesis.
 * - **Nothing at all**, when the node refuses or the authority has no listed signatures. That is
 *   `unverified`, never `established`.
 */
export type FundingProbeInput = {
  authority: string;
  /** Operator-supplied suspect addresses (`--suspect`). Empty by default, and then no `flagged_source` result is possible. */
  suspectAddresses: ReadonlySet<string>;
  /** Signatures to ask the node for. Costs one call. */
  limit?: number;
  /** How many of those transactions to fetch, looking for the funding leg. Each costs a call. */
  maxTxReads?: number;
  /** Injected clock, so the age arithmetic is testable without a wall clock. */
  nowMs?: number;
};

export type FundingProbeResult = {
  evidence: FundingEvidence;
  callsSpent: number;
  signaturesSeen: number;
  /** How far the signature walk reached relative to what was asked. */
  walkReachedBeginning: boolean;
};

const HOUR = 3_600_000;

export async function probeAuthorityFunding(client: SolanaClient, input: FundingProbeInput): Promise<FundingProbeResult> {
  const limit = Math.max(1, input.limit ?? 10);
  const maxTxReads = Math.max(0, input.maxTxReads ?? 3);
  const now = input.nowMs ?? Date.now();
  let calls = 0;

  const unverified = (detail: string): FundingProbeResult => ({
    evidence: { state: 'unverified', detail },
    callsSpent: calls,
    signaturesSeen: 0,
    walkReachedBeginning: false,
  });

  let signatures: Awaited<ReturnType<SolanaClient['getSignaturesForAddress']>>;
  try {
    calls++;
    signatures = await client.getSignaturesForAddress(input.authority, { limit });
  } catch (e) {
    // Refusal is a state of the *node*, not a statement about the wallet. Report it as such.
    return unverified(`getSignaturesForAddress failed for the authority: ${(e as Error)?.message ?? 'unknown error'}`);
  }

  if (signatures.length === 0) {
    return unverified('the node listed no signatures at all for this authority — indistinguishable from a wallet with no history and a wallet whose history was dropped');
  }

  const oldest = signatures[signatures.length - 1]!;
  const newest = signatures[0]!;
  const walkReachedBeginning = signatures.length < limit;
  const blockTimes = signatures.map((s) => s.blockTime).filter((t): t is number => typeof t === 'number');
  const spanMs = blockTimes.length >= 2 ? (Math.max(...blockTimes) - Math.min(...blockTimes)) * 1000 : null;
  const ageMs = typeof oldest.blockTime === 'number' ? now - oldest.blockTime * 1000 : null;

  // Look for a leg in which the authority's balance rose, and who it rose from.
  let flaggedFrom: string | null = null;
  let fundingSeen: { from: string | null; ageMs: number } | null = null;
  const toRead = signatures.slice(0, maxTxReads);
  for (const sig of toRead) {
    calls++;
    const res = await client.getTransaction(sig.signature);
    if (res.status !== 'found') continue;
    const meta = res.tx.meta;
    const keys = resolveAccountKeys(res.tx).keys;
    if (!meta?.preBalances || !meta?.postBalances) continue;
    const authorityIndex = keys.indexOf(input.authority);
    if (authorityIndex < 0) continue;
    const before = meta.preBalances[authorityIndex];
    const after = meta.postBalances[authorityIndex];
    if (before === undefined || after === undefined || after <= before) continue;
    // Something raised this account's SOL. The counterparty is whichever account fell by roughly that
    // much; ties and fee effects are resolved toward the largest decrease, and an unattributable
    // inflow is reported as unattributable rather than guessed.
    let donor: string | null = null;
    let worst = 0;
    for (let i = 0; i < keys.length; i++) {
      const drop = (meta.preBalances[i] ?? 0) - (meta.postBalances[i] ?? 0);
      if (i !== authorityIndex && drop > worst) {
        worst = drop;
        donor = keys[i]!;
      }
    }
    const at = typeof sig.blockTime === 'number' ? sig.blockTime * 1000 : null;
    if (at === null) continue;
    fundingSeen = { from: donor, ageMs: now - at };
    if (donor && input.suspectAddresses.has(donor)) {
      flaggedFrom = donor;
      break;
    }
  }

  if (flaggedFrom) {
    return {
      evidence: {
        state: 'flagged_source',
        fromAddress: flaggedFrom,
        detail: `received SOL from ${flaggedFrom}, an address the operator named as suspect`,
      },
      callsSpent: calls,
      signaturesSeen: signatures.length,
      walkReachedBeginning,
    };
  }

  if (fundingSeen && fundingSeen.ageMs <= 24 * HOUR && walkReachedBeginning) {
    return {
      evidence: {
        state: 'recent_funding_observed',
        ageMs: fundingSeen.ageMs,
        retentionBounded: false,
        detail: `first funded ${Math.max(1, Math.round(fundingSeen.ageMs / HOUR))} hour(s) ago by ${fundingSeen.from ?? 'an unattributed sender'}, and the node returned the whole visible history of the account (${signatures.length} signature(s), fewer than the ${limit} asked for)`,
      },
      callsSpent: calls,
      signaturesSeen: signatures.length,
      walkReachedBeginning,
    };
  }

  if (fundingSeen && fundingSeen.ageMs <= 24 * HOUR) {
    return {
      evidence: {
        state: 'recent_funding_observed',
        ageMs: fundingSeen.ageMs,
        retentionBounded: true,
        detail: `funded ${Math.max(1, Math.round(fundingSeen.ageMs / HOUR))} hour(s) ago, but the walk hit ${limit} signatures${spanMs !== null ? ` spanning ${Math.round(spanMs / HOUR)} hour(s)` : ''}, so older history may exist on a node that keeps more`,
      },
      callsSpent: calls,
      signaturesSeen: signatures.length,
      walkReachedBeginning,
    };
  }

  return {
    evidence: {
      state: 'established',
      detail: `${signatures.length} signature(s) listed for the authority, oldest ${(ageMs ?? 0) / 86_400_000 >= 1 ? Math.round((ageMs ?? 0) / 86_400_000) + ' day(s)' : Math.round((ageMs ?? 0) / HOUR) + ' hour(s)'} back and none of them a fresh funding event${newest.blockTime ? '' : ' (no block times reported)'}`,
    },
    callsSpent: calls,
    signaturesSeen: signatures.length,
    walkReachedBeginning,
  };
}

/**
 * How long a signer set can go without any signer appearing in a transaction before Dot calls it stale.
 * A chosen constant, not a measured one, and it is printed in the report rather than hidden in the score:
 * a quorum whose members have not transacted in two years is worth a human's attention whether or not
 * the threshold is 2-of-3, because the keys may be cold, lost, or held by people who left.
 */
export const STALE_SIGNER_SET_MS = 180 * 86_400_000;

export type SignerActivity =
  | {
      state: 'stale';
      newestMs: number;
      idleMs: number;
      detail: string;
      probed: number;
      of: number;
    }
  | { state: 'active'; newestMs: number; idleMs: number; detail: string; probed: number; of: number }
  | { state: 'unverified'; detail: string; probed: number; of: number };

/**
 * The last time any signer of this multisig was seen in a transaction the node will still list.
 *
 * One `getSignaturesForAddress` per signer, so this is opt-in (`--check-signers`) and capped: eleven
 * signers is eleven calls, and a run that quietly spends them on every event is a run nobody can budget.
 * The cap is reported, not silently applied.
 *
 * Absence points *away* from suspicion here, which is the opposite of the funding axis and the reason for
 * the shape: a node that refuses the reads, or a truncated list, yields `unverified` and never the stale
 * band. A check that did not run cannot mint ten points of malice.
 */
export async function probeSignerActivity(
  client: SolanaClient,
  input: { signers: string[]; maxSigners?: number; limit?: number; nowMs?: number },
): Promise<SignerActivity> {
  const of = input.signers.length;
  const max = Math.max(1, input.maxSigners ?? 5);
  const limit = Math.max(1, input.limit ?? 1);
  const now = input.nowMs ?? Date.now();
  const probed = input.signers.slice(0, Math.min(of, max));

  let newestMs: number | null = null;
  let failures = 0;
  for (const signer of probed) {
    try {
      const sigs = await client.getSignaturesForAddress(signer, { limit });
      const times = sigs.map((s) => s.blockTime).filter((t): t is number => typeof t === 'number');
      if (times.length === 0) {
        // No listed signature is not "never used": it is also what a retention-trimmed or fresh account
        // says. Counted as a failure of the read, not as evidence of idleness.
        failures++;
        continue;
      }
      const at = Math.max(...times) * 1000;
      newestMs = newestMs === null ? at : Math.max(newestMs, at);
    } catch {
      failures++;
    }
  }

  const truncation = of > probed.length ? ` ${probed.length} of ${of} signers were probed (--check-signers caps at ${probed.length})` : '';
  if (newestMs === null) {
    return {
      state: 'unverified',
      detail: `no signer activity could be read (${failures} of ${probed.length} probes returned nothing or failed), so idleness is unknown rather than long${truncation}`,
      probed: probed.length,
      of,
    };
  }
  const idleMs = now - newestMs;
  const days = Math.round(idleMs / 86_400_000);
  const detail = `the most recent transaction any probed signer appears in is ${days} day(s) old${truncation}`;
  return idleMs > STALE_SIGNER_SET_MS
    ? { state: 'stale', newestMs, idleMs, detail, probed: probed.length, of }
    : { state: 'active', newestMs, idleMs, detail, probed: probed.length, of };
}

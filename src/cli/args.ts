/**
 * The operator-declared inputs, split out of `src/cli/index.ts` for one structural reason: that module
 * calls `program.parseAsync(process.argv)` at import time, so importing anything from it runs the CLI.
 * These two functions decide what a report is allowed to *assume* about an authority, which is exactly
 * the kind of thing that needs a test rather than a read-through.
 */

/**
 * `--threshold 2-of-3`. A multisig's quorum lives inside the multisig account, which Dot does not
 * decode, so the only way this number reaches a report is an operator declaring it. Anything that
 * does not parse is refused loudly rather than defaulted: a guessed threshold is a guessed accusation.
 */
export function parseThreshold(value: string): { m: number; n: number } {
  // The dash after "of" is optional but must be allowed: `--threshold 2-of-3` is the form this
  // function's own error message, the CLI help text and the README all tell an operator to type, and
  // a grammar that rejects its own example turns documented usage into a refusal that quotes the
  // example back at them.
  const hit = /^(\d+)\s*(?:-?of-?|-)\s*(\d+)$/i.exec(value.trim());
  if (!hit) throw new Error(`--threshold wants "m-of-n" (e.g. 2-of-3), got "${value}"`);
  const m = Number(hit[1]);
  const n = Number(hit[2]);
  if (!(m >= 1 && n >= m && n <= 11)) throw new Error(`--threshold "${value}" is not a valid Ed25519 multisig (need 1 <= m <= n <= 11)`);
  return { m, n };
}

/**
 * `--incident-at 2026-10-22T09:00Z`, or a unix time. Operator-declared: Dot fetches no incident feed,
 * so an upgrade is never "near an incident" unless somebody says when one happened.
 *
 * Bare digits are accepted as seconds or milliseconds, separated at 1e11 — the same rule the rest of
 * the tooling uses, because a 10-digit number is a timestamp in seconds and 13 is one in ms, and
 * guessing wrong is a 1000x error in the only direction that matters for "+10, this landed during an
 * incident". A value too short to be either is refused rather than scaled.
 */
export function parseIncidentAt(value: string): number {
  const v = value.trim();
  if (/^\d{9,13}$/.test(v)) {
    const n = Number(v);
    return n < 1e11 ? n * 1000 : n;
  }
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`--incident-at wants an ISO timestamp or a unix time, got "${v}"`);
  return t;
}

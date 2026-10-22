import { describe, expect, it } from 'vitest';
import { parseIncidentAt, parseThreshold } from '../src/cli/args.js';

/**
 * The operator-declared inputs behind two malice axes. These are worth a suite precisely because they
 * decide what a report is permitted to *assume*: a wrong `--threshold` moves an authority between the
 * 0-point and the 10-point band, and a wrong `--incident-at` turns a scale mistake into a +10 timing
 * anomaly. Both are refusals rather than defaults, and a refusal that is not tested is a refusal that
 * quietly became a default.
 *
 * They live in `src/cli/args.ts` rather than beside the CLI they serve because `src/cli/index.ts` runs
 * `program.parseAsync(process.argv)` on import — importing it to test it would execute the program.
 */

describe('parseThreshold — the declared multisig quorum', () => {
  it('accepts the shapes an operator actually types, and normalizes the case', () => {
    for (const input of ['2-of-3', '2of3', '2 of 3', '2-3', '2-OF-3', '  2-of-3  ']) {
      expect(parseThreshold(input), input).toEqual({ m: 2, n: 3 });
    }
    expect(parseThreshold('1-of-1')).toEqual({ m: 1, n: 1 });
    expect(parseThreshold('11-of-11')).toEqual({ m: 11, n: 11 });
  });

  it('refuses a quorum the Ed25519 multisig program cannot hold, rather than clamping it', () => {
    // A clamp here would be an accusation with a rounded number under it: 12-of-12 scored as 11-of-11
    // is still "high threshold", and 3-of-2 scored as 2-of-2 is still "low threshold".
    for (const bad of ['3-of-2', '0-of-3', '12-of-12', '2-of-0', '3of2', '12of12']) {
      expect(() => parseThreshold(bad), bad).toThrow(/Ed25519 multisig/);
    }
  });

  it('refuses anything that is not m-of-n rather than guessing which number the operator meant', () => {
    for (const bad of ['two-of-three', '2', '2/3', '', 'of', '2-of-3-of-4', '2-of-', '-1-of-3']) {
      expect(() => parseThreshold(bad), JSON.stringify(bad)).toThrow(/wants "m-of-n"/);
    }
  });
});

describe('parseIncidentAt — the declared incident clock', () => {
  it('reads an ISO timestamp as wall time, with or without an explicit zone', () => {
    expect(parseIncidentAt('2026-10-22T09:00:00Z')).toBe(Date.parse('2026-10-22T09:00:00Z'));
    expect(parseIncidentAt(' 2026-10-22T09:00Z ')).toBe(Date.parse('2026-10-22T09:00Z'));
  });

  it('treats 10 digits as seconds and 13 as milliseconds, because that is the only safe reading', () => {
    // A 1000x error here is the difference between "this upgrade landed during the incident" and
    // "it landed 55 years after it", and both look like a number that parsed fine.
    expect(parseIncidentAt('1760000000')).toBe(1_760_000_000_000);
    expect(parseIncidentAt('1760000000000')).toBe(1_760_000_000_000);
    // The boundary itself: 1e11 seconds is year 5138, so anything at or above it is already milliseconds.
    expect(parseIncidentAt('100000000000')).toBe(100_000_000_000);
  });

  it('refuses a bare number too short to be a timestamp, instead of scaling it into the 1970s', () => {
    expect(() => parseIncidentAt('12345678')).toThrow(/wants an ISO timestamp or a unix time/);
    expect(() => parseIncidentAt('yesterday')).toThrow(/wants an ISO timestamp or a unix time/);
    expect(() => parseIncidentAt('')).toThrow(/wants an ISO timestamp or a unix time/);
  });
});

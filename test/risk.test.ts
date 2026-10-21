import { describe, expect, it } from 'vitest';
import { scoreRisk, tierFor } from '../src/score/risk.js';
import type { UpgradeContext } from '../src/agent/decision.js';
import type { EvidenceSignals, ExposureSignals } from '../src/score/risk.js';

const ctx = (over: Partial<UpgradeContext> = {}): UpgradeContext => ({
  program: 'P',
  programData: 'PD',
  kind: 'upgrade',
  change: { bytecodeChanged: true, authorityChanged: false, sizeChanged: true, beforeBytes: 1_000_000, afterBytes: 1_100_000 },
  authority: { before: 'A', after: 'A', posture: 'eoa' },
  history: { signaturesAvailable: null, lastAnalysisAt: null, knownDependents: null, lamportsRoutedLast: null },
  idl: { available: false },
  ...over,
});

const exposure = (over: Partial<ExposureSignals> = {}): ExposureSignals => ({
  directCallers: 40,
  transitiveCallers: 90,
  edges: 130,
  cpiOccurrences: 5_000,
  failedCpiOccurrences: 0,
  distinctTransactions: 100,
  lamportsRouted: 5_000_000_000,
  mintsTouched: 6,
  selfCpi: false,
  ...over,
});

const evidence = (over: Partial<EvidenceSignals> = {}): EvidenceSignals => ({
  signaturesPlanned: 100,
  signaturesFound: 100,
  signaturesPruned: 0,
  fetchErrors: 0,
  duplicateSignatures: 0,
  sampleCoverage: 1,
  attributionQuality: 'stackHeight',
  flattenedFrames: 0,
  logTruncated: false,
  historySpanDays: 2,
  ...over,
});

describe('triage scoring', () => {
  it('ranks an EOA-authority upgrade on a widely-used program above a multisig upgrade on an unused one', () => {
    const hot = scoreRisk(ctx(), exposure(), evidence());
    const cold = scoreRisk(
      ctx({ authority: { before: 'M', after: 'M', posture: 'multisig' }, change: { bytecodeChanged: true, authorityChanged: false, sizeChanged: false, beforeBytes: 1_000_000, afterBytes: 1_000_010 } }),
      exposure({ directCallers: 0, transitiveCallers: 0, edges: 1, cpiOccurrences: 1, lamportsRouted: 0, mintsTouched: 0 }),
      evidence(),
    );
    expect(hot.score).toBeGreaterThan(cold.score);
    expect(hot.tier).not.toBe(cold.tier);
  });

  it('never lets low confidence mint a P0', () => {
    const r = scoreRisk(ctx(), exposure(), evidence({ sampleCoverage: 0.1, attributionQuality: 'flat', flattenedFrames: 500, signaturesPruned: 90 }));
    expect(r.confidence).toBe('low');
    expect(r.tier).not.toBe('P0');
    expect(r.cappedBy).toContain('flattened');
  });

  it('keeps severity and likelihood separate: a renounced authority scores lower on posture', () => {
    const eoa = scoreRisk(ctx(), exposure(), evidence());
    const renounced = scoreRisk(ctx({ authority: { before: null, after: null, posture: 'renounced' } }), exposure(), evidence());
    const eoaPosture = eoa.components.find((c) => c.name === 'authority_posture')!.points;
    const renouncedPosture = renounced.components.find((c) => c.name === 'authority_posture')!.points;
    expect(renouncedPosture).toBeLessThan(eoaPosture);
  });

  it('scores an authority rotation as a change-magnitude event, not just a code change', () => {
    const rotated = scoreRisk(
      ctx({ kind: 'authority_change', change: { bytecodeChanged: false, authorityChanged: true, sizeChanged: false, beforeBytes: 1_000_000, afterBytes: 1_000_000 }, authority: { before: 'A', after: 'B', posture: 'eoa' } }),
      exposure(),
      evidence(),
    );
    expect(rotated.components.find((c) => c.name === 'change_magnitude')!.points).toBeGreaterThanOrEqual(20);
  });

  it('compresses whale exposure with a log scale so one DEX cannot pin the meter', () => {
    const a = scoreRisk(ctx(), exposure({ directCallers: 10, transitiveCallers: 10 }), evidence()).components.find((c) => c.name === 'dependents')!;
    const b = scoreRisk(ctx(), exposure({ directCallers: 10_000, transitiveCallers: 10_000 }), evidence()).components.find((c) => c.name === 'dependents')!;
    expect(b.points).toBe(a.max);
    expect(a.points).toBeLessThan(a.max);
  });

  it('tier thresholds are monotonic in score', () => {
    expect(tierFor(90, 'high')).toBe('P0');
    expect(tierFor(60, 'high')).toBe('P1');
    expect(tierFor(30, 'high')).toBe('P2');
    expect(tierFor(5, 'high')).toBe('P3');
    expect(tierFor(90, 'medium')).toBe('P0');
    expect(tierFor(90, 'low')).toBe('P1');
  });
});

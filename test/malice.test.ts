import { describe, expect, it } from 'vitest';
import { renderMarkdown, maliceAlarm, type DotReport } from '../src/report.js';
import { renderDanger, scoreDanger, type DangerInputs } from '../src/score/danger.js';

/**
 * The malice heuristic, and the constraint that governs it: **a scream must be rare.**
 *
 * Two halves. The extreme case must fire — single key, funding evidence an operator named, a selector
 * the published interface denies. And a corpus of *ordinary* upgrades — different authorities, an
 * unscannable image, a widened account set, first sighting, a live-shaped PDA program — must not,
 * because a flag that fires on one run in ten is not information, it is noise that teaches people to
 * ignore the one case where it means something.
 *
 * The property the corpus tests is not "few fire" but *why* few fire: the flag needs positive evidence
 * of a kind Dot can observe, and every ordinary case here has plenty of reason to be scary
 * (unverifiable bytecode, fresh sighting, big blast radius) and none of the evidence.
 */
const EOA = 'FnSCQX1CYdGkGgd7RSScZzVij7nfKhYK5VcjaAozv3d5';
const HOUR = 3_600_000;

const base = (over: Partial<DangerInputs> = {}): DangerInputs => ({
  program: 'Pg11111111111111111111111111111111111111',
  authority: { posture: 'eoa', address: EOA },
  delta: { confidence: 'structural', addedEntrypoints: [], undeclaredEntrypoints: [], accountChanges: [] },
  radius: { direct: 14, transitive: 34, lamportsRouted: 40_000_000, usdPerSol: null, mintsTouched: 0 },
  behavior: { priorDigestAt: null, stateFileUsed: true },
  integrity: { funding: { state: 'established', detail: 'years of signatures' }, declaredThreshold: null, timelockDeclared: false, fundingProbe: { callsSpent: 2, signaturesSeen: 10 } },
  timing: { priorUpgradeTimesMs: [Date.now() - 200 * 86_400_000, Date.now() - 150 * 86_400_000, Date.now() - 100 * 86_400_000], upgradeTimeMs: Date.now() - 99 * 86_400_000, governanceGapMs: null, incidentGapMs: null },
  ...over,
});

const flagged = (i: DangerInputs) => scoreDanger(i).malice.flagged;

describe('malice verdict — the extreme case', () => {
  const attack = scoreDanger(base({
    delta: { confidence: 'structural', addedEntrypoints: ['drain'], undeclaredEntrypoints: ['drain'], accountChanges: [{ instruction: 'drain', addedSigner: [], addedWritable: ['vault'], existing: false }] },
    integrity: { funding: { state: 'flagged_source', fromAddress: 'Tornadocash…declared-by-operator', detail: 'received SOL from an address the operator named as suspect, 2 hours ago' }, declaredThreshold: null, timelockDeclared: false, fundingProbe: { callsSpent: 2, signaturesSeen: 1 } },
    behavior: { priorDigestAt: null, stateFileUsed: true },
    timing: { priorUpgradeTimesMs: [Date.now() - 200 * 86_400_000, Date.now() - 150 * 86_400_000, Date.now() - 100 * 86_400_000], upgradeTimeMs: Date.now(), governanceGapMs: 20 * 60_000, incidentGapMs: null },
  }));

  it('fires on single key + observed fresh funding + an undeclared selector', () => {
    expect(attack.malice.flagged).toBe(true);
    expect(attack.score).toBeGreaterThanOrEqual(90);
    expect(attack.malice.gate.positiveEvidence).toBe(true);
    expect(attack.malice.maliceScore).toBe(30 + 20 + 10);
  });

  it('states the evidence in the sentence, not just the label', () => {
    expect(attack.malice.evidence).toMatch(/Authority integrity 30\/30/);
    expect(attack.malice.evidence).toMatch(/`drain`/);
    expect(attack.malice.evidence).toMatch(/Score: \d+\/100( \(raw \d+\/180 before the clamp\))?\.$/);
    const out = renderDanger(attack);
    expect(out).toMatch(/MALICE HEURISTIC: \*\*SUSPECTED_MALICIOUS\*\* — a scream, not a proof/);
    expect(out).toMatch(/signature axes: authorityIntegrity 30\/30, codeAnomaly 20\/20, timingAnomaly 10\/10 = 60\/60/);
    expect(out).toMatch(/gate: overall score \d+ >= 90/);
  });

  it('says in the same breath that it is not a finding about intent', () => {
    expect(attack.malice.disclaimer).toMatch(/heuristic/i);
    expect(attack.malice.disclaimer).toMatch(/not a judgement about intent/i);
    expect(attack.malice.disclaimer).toMatch(/NO_MALICE_DETECTION/);
    // And the word "malicious" never appears without the heuristic label in front of it.
    expect(renderDanger(attack)).toMatch(/SUSPECTED_MALICIOUS\*\* — a scream, not a proof/);
  });

  it('fires equally on observed freshness with no suspect list, because that is a separate observation', () => {
    expect(flagged(base({
      delta: { confidence: 'structural', addedEntrypoints: [], undeclaredEntrypoints: ['hidden'], accountChanges: [] },
      integrity: { funding: { state: 'recent_funding_observed', ageMs: 2 * HOUR, retentionBounded: false, detail: 'first funded 2 hours ago' }, declaredThreshold: null, timelockDeclared: false, fundingProbe: { callsSpent: 2, signaturesSeen: 1 } },
      timing: null,
    }))).toBe(true);
  });
});

describe('malice verdict — the ordinary corpus does not fire', () => {
  const ordinary: Array<[string, DangerInputs]> = [
    ['additive upgrade by a long-established single key', base({ delta: { confidence: 'structural', addedEntrypoints: ['depositV2'], undeclaredEntrypoints: [], accountChanges: [] } })],
    ['unscannable bytecode, nothing else', base({ delta: { confidence: 'unscannable', addedEntrypoints: [], undeclaredEntrypoints: [], accountChanges: [] } })],
    ['permission widening on an existing instruction', base({ delta: { confidence: 'structural', addedEntrypoints: [], undeclaredEntrypoints: [], accountChanges: [{ instruction: 'withdraw', addedSigner: [], addedWritable: ['pool'], existing: true }] } })],
    ['authority renounced — immutable', base({ authority: { posture: 'renounced', address: null }, delta: { confidence: 'structural', addedEntrypoints: [], undeclaredEntrypoints: [], accountChanges: [] } })],
    ['multisig whose threshold nobody declared', base({ authority: { posture: 'multisig', address: EOA }, integrity: { funding: null, declaredThreshold: null, timelockDeclared: false, fundingProbe: null } })],
    ['PDA authority (the shape of today’s live Token-2021 run)', base({ authority: { posture: 'program_derived', address: 'JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd' }, integrity: { funding: null, declaredThreshold: null, timelockDeclared: false, fundingProbe: null } })],
    ['no diff, no graph, no state — a thin first run', base({ delta: null, radius: null, behavior: null, integrity: null, timing: null })],
    ['funding refused by the node', base({ integrity: { funding: { state: 'unverified', detail: 'getSignaturesForAddress refused' }, declaredThreshold: null, timelockDeclared: false, fundingProbe: { callsSpent: 1, signaturesSeen: 0 } }, delta: { confidence: 'partial', addedEntrypoints: [], undeclaredEntrypoints: [], accountChanges: [] } })],
    ['fresh sighting plus an unscannable image and no callers', base({ delta: { confidence: 'unscannable', addedEntrypoints: [], undeclaredEntrypoints: [], accountChanges: [] }, radius: { direct: 0, transitive: 0, lamportsRouted: 0, usdPerSol: null, mintsTouched: 0 }, integrity: { funding: { state: 'recent_funding_observed', ageMs: 2 * HOUR, retentionBounded: true, detail: 'funded 2 hours ago; older history may exist' }, declaredThreshold: null, timelockDeclared: false, fundingProbe: { callsSpent: 2, signaturesSeen: 10 } } })],
  ];

  it('fires on none of the nine ordinary shapes', () => {
    const fired = ordinary.filter(([, i]) => flagged(i)).map(([n]) => n);
    expect(fired, `these ordinary upgrades should not scream: ${fired.join(' | ')}`).toEqual([]);
  });

  it('explains, for each one, that the gate was not the score', () => {
    for (const [name, i] of ordinary) {
      const d = scoreDanger(i);
      if (d.score >= 90) {
        // A single-key program can reach 90 on posture and blast radius alone. What keeps the scream
        // off is the absence of *positive* evidence, not a low score — which is the whole deviation
        // from the brief's literal gate, asserted here rather than explained only in a comment.
        expect(d.malice.gate.authorityIntegrityPositive, `${name}: integrity band is non-zero by design`).toBe(true);
        expect(d.malice.gate.positiveEvidence, name).toBe(false);
        expect(d.malice.flagged, name).toBe(false);
      }
    }
  });

  it('scores a declared 3-of-5 at the same 10 as a 2-of-3, because the 0-point case needs a timelock', () => {
    const threeOfFive = scoreDanger(base({ authority: { posture: 'multisig', address: EOA }, integrity: { funding: null, declaredThreshold: { m: 3, n: 5 }, timelockDeclared: false, fundingProbe: null } }));
    const twoOfThree = scoreDanger(base({ authority: { posture: 'multisig', address: EOA }, integrity: { funding: null, declaredThreshold: { m: 2, n: 3 }, timelockDeclared: false, fundingProbe: null } }));
    expect(threeOfFive.axes.find((a) => a.id === 'authorityIntegrity')!.points).toBe(10);
    expect(twoOfThree.axes.find((a) => a.id === 'authorityIntegrity')!.points).toBe(10);
    const locked = scoreDanger(base({ authority: { posture: 'multisig', address: EOA }, integrity: { funding: null, declaredThreshold: { m: 3, n: 5 }, timelockDeclared: true, fundingProbe: null } }));
    expect(locked.axes.find((a) => a.id === 'authorityIntegrity')!.points).toBe(0);
  });

  it('does scream on an undeclared selector under a multisig, because the anomaly is the evidence', () => {
    // Moving the threshold band does not move this: an entrypoint reachable in the bytecode and
    // denied by the published interface is an observed fact about the program, not a guess about who
    // could have signed. It is *positive* evidence and the gate says so.
    const d = scoreDanger(base({
      authority: { posture: 'multisig', address: EOA },
      integrity: { funding: null, declaredThreshold: { m: 3, n: 5 }, timelockDeclared: false, fundingProbe: null },
      delta: { confidence: 'structural', addedEntrypoints: [], undeclaredEntrypoints: ['ghost'], accountChanges: [] },
    }));
    expect(d.malice.flagged).toBe(true);
    expect(d.malice.gate.positiveEvidence).toBe(true);
  });

  it('does not scream on a permission widening alone, which is what honest upgrades do every week', () => {
    const d = scoreDanger(base({
      delta: { confidence: 'structural', addedEntrypoints: [], undeclaredEntrypoints: [], accountChanges: [{ instruction: 'withdraw', addedSigner: [], addedWritable: ['pool'], existing: true }] },
    }));
    expect(d.axes.find((a) => a.id === 'codeAnomaly')!.points).toBe(20);
    expect(d.malice.gate.positiveEvidence).toBe(false);
    expect(d.malice.flagged).toBe(false);
  });

  it('refuses to guess at all when no signature axis was measured', () => {
    const d = scoreDanger(base({ integrity: null, timing: null, delta: null }));
    expect(d.malice.gate.measured).toBe(false);
    expect(d.malice.flagged).toBe(false);
    expect(renderDanger(d)).toMatch(/MALICE HEURISTIC: not assessed/);
  });
});

describe('malice output — the alarm sentence, and the gaps the axes cannot see', () => {
  // The attack shape the brief describes: one key, freshly funded, new bytecode answering to a
  // selector the published interface denies.
  const attack = scoreDanger(base({
    delta: { confidence: 'structural', addedEntrypoints: ['drain'], undeclaredEntrypoints: ['drain'], accountChanges: [] },
    integrity: { funding: { state: 'recent_funding_observed', ageMs: 2 * HOUR, retentionBounded: false, detail: 'first funded 2 hours ago by a fresh wallet' }, declaredThreshold: null, timelockDeclared: false, fundingProbe: { callsSpent: 2, signaturesSeen: 1 }, suspectAddressesSeen: 0 },
    timing: null,
  }));

  it('prints the verdict sentence the brief specifies, verbatim, with the breakdown under it', () => {
    expect(attack.malice.flagged).toBe(true);
    expect(attack.malice.verdictLine).toBe(
      'VERDICT: SUSPECTED_MALICIOUS — This upgrade has the structural signature of an attack. Immediate human review required. Do not trust the new bytecode.',
    );
    const out = renderDanger(attack);
    expect(out).toContain(attack.malice.verdictLine!);
    // Constraint 3: the label is followed by the evidence, with the score in it. "Authority is a single
    // EOA funded 2 hours ago… Score: N/100" is the shape the brief asked for, so the pieces are pinned
    // rather than the whole sentence, which would make every rewording of a detail line a test failure.
    const at = out.indexOf(attack.malice.verdictLine!);
    const after = out.slice(at, at + 900);
    expect(after).toMatch(/Authority integrity 30\/30/);
    expect(after).toMatch(/funded 2 hours? ago/);
    expect(after).toMatch(/`drain`/);
    expect(after).toMatch(/Score: \d+\/100 \(raw \d+\/180 before the clamp\)\./);
  });

  it('says nothing at all about malice on the safe shape: immutable authority, additive diff', () => {
    const safe = scoreDanger(base({
      authority: { posture: 'renounced', address: null },
      delta: { confidence: 'structural', addedEntrypoints: ['depositV2'], undeclaredEntrypoints: [], accountChanges: [] },
      integrity: { funding: null, declaredThreshold: null, timelockDeclared: false, fundingProbe: null, suspectAddressesSeen: 0 },
      timing: null,
    }));
    expect(safe.malice.flagged).toBe(false);
    expect(safe.malice.verdictLine).toBeNull();
    expect(safe.axes.find((a) => a.id === 'authorityIntegrity')!.points).toBe(0);
    expect(safe.axes.find((a) => a.id === 'codeAnomaly')!.points).toBe(0);
    const out = renderDanger(safe);
    expect(out).not.toMatch(/SUSPECTED_MALICIOUS/);
    expect(out).toMatch(/MALICE HEURISTIC: not flagged/);
    expect(out).toMatch(/Authority Integrity: immutable \(authority renounced\) \[\+0\/30\]/);
  });

  it('names the stale-signer-set band it cannot read, on every multisig shape', () => {
    for (const declared of [null, { m: 2, n: 3 }, { m: 3, n: 5 }]) {
      const d = scoreDanger(base({
        authority: { posture: 'multisig', address: EOA },
        integrity: { funding: null, declaredThreshold: declared, timelockDeclared: declared?.m === 3, fundingProbe: null, suspectAddressesSeen: 0 },
      }));
      const a = d.axes.find((x) => x.id === 'authorityIntegrity')!;
      expect(a.notAssessed.join(' '), `threshold ${declared ? `${declared.m}-of-${declared.n}` : 'undeclared'}`).toMatch(/stale signer set/);
    }
  });

  it('does not let an unscored multisig funding probe pass for a clean authority', () => {
    const d = scoreDanger(base({
      authority: { posture: 'multisig', address: EOA },
      integrity: { funding: { state: 'flagged_source', fromAddress: 'suspect-1', detail: 'received SOL from a named suspect address' }, declaredThreshold: null, timelockDeclared: false, fundingProbe: { callsSpent: 2, signaturesSeen: 1 }, suspectAddressesSeen: 1 },
    }));
    // The axis is null — the brief's +30 is a *single EOA* band — but the operator is told the read
    // happened and what it said, rather than being told there was no data.
    expect(d.axes.find((x) => x.id === 'authorityIntegrity')!.points).toBeNull();
    expect(d.axes.find((x) => x.id === 'authorityIntegrity')!.notAssessed.join(' ')).toMatch(/flagged_source/);
    expect(d.axes.find((x) => x.id === 'authorityIntegrity')!.notAssessed.join(' ')).toMatch(/deliberately not scored/);
  });

  it('refuses to call a single key clean when no suspect list was ever supplied', () => {
    const noList = scoreDanger(base({
      integrity: { funding: { state: 'established', detail: 'years of signatures' }, declaredThreshold: null, timelockDeclared: false, fundingProbe: { callsSpent: 3, signaturesSeen: 10 }, suspectAddressesSeen: 0 },
    }));
    const a = noList.axes.find((x) => x.id === 'authorityIntegrity')!;
    expect(a.points).toBe(20);
    expect(a.notAssessed.join(' ')).toMatch(/flagged-source band was unreachable by construction/);
    expect(a.notAssessed.join(' ')).toMatch(/not mixer-funded/);
    const withList = scoreDanger(base({
      integrity: { funding: { state: 'established', detail: 'years of signatures' }, declaredThreshold: null, timelockDeclared: false, fundingProbe: { callsSpent: 3, signaturesSeen: 10 }, suspectAddressesSeen: 4 },
    }));
    expect(withList.axes.find((x) => x.id === 'authorityIntegrity')!.notAssessed.join(' ')).not.toMatch(/unreachable by construction/);
  });

  it('says which clock the timing axis stood on, and only claims Dot\'s own when that is all it had', () => {
    const mk = (upgradeTimeSource: 'analysis-clock' | 'watcher-detected') =>
      scoreDanger(base({
        timing: { priorUpgradeTimesMs: [], upgradeTimeMs: Date.now(), upgradeTimeSource, governanceGapMs: 5 * 60_000, incidentGapMs: null },
      }));
    expect(mk('analysis-clock').axes.find((a) => a.id === 'timingAnomaly')!.detail.join(' ')).toMatch(/against Dot's own clock/);
    expect(mk('analysis-clock').axes.find((a) => a.id === 'timingAnomaly')!.notAssessed.join(' ')).toMatch(/proximity to \*now\*, not to the upgrade/);
    expect(mk('watcher-detected').axes.find((a) => a.id === 'timingAnomaly')!.detail.join(' ')).not.toMatch(/own clock/);
    // Either way the axis admits it counts signatures, not proposals.
    expect(mk('watcher-detected').axes.find((a) => a.id === 'timingAnomaly')!.notAssessed.join(' ')).toMatch(/cannot tell a governance \*proposal\*/);
  });

  it('names the clamp only when the clamp actually bit', () => {
    // Same gate, raw total under 100: 40 posture + 30 measured funding + 20 undeclared selector, with a
    // previously-observed program and no dependents. Without this the "(raw …)" suffix would be
    // boilerplate, and a reader could not tell a maxed-out score from one that never reached the ceiling.
    const d = scoreDanger(base({
      delta: { confidence: 'structural', addedEntrypoints: [], undeclaredEntrypoints: ['drain'], accountChanges: [] },
      radius: { direct: 0, transitive: 0, lamportsRouted: 0, usdPerSol: null, mintsTouched: 0 },
      behavior: { priorDigestAt: '2026-01-01T00:00:00.000Z', stateFileUsed: true },
      integrity: { funding: { state: 'recent_funding_observed', ageMs: 2 * HOUR, retentionBounded: false, detail: 'first funded 2 hours ago' }, declaredThreshold: null, timelockDeclared: false, fundingProbe: { callsSpent: 2, signaturesSeen: 1 } },
      timing: null,
    }));
    expect(d.malice.flagged).toBe(true);
    expect(d.rawScore).toBeLessThanOrEqual(100);
    expect(d.malice.evidence).toMatch(/Score: \d+\/100\.$/);

    const clamped = scoreDanger(base({
      delta: { confidence: 'structural', addedEntrypoints: [], undeclaredEntrypoints: ['drain'], accountChanges: [] },
      integrity: { funding: { state: 'recent_funding_observed', ageMs: 2 * HOUR, retentionBounded: false, detail: 'first funded 2 hours ago' }, declaredThreshold: null, timelockDeclared: false, fundingProbe: { callsSpent: 2, signaturesSeen: 1 } },
      timing: null,
    }));
    expect(clamped.rawScore).toBeGreaterThan(100);
    expect(clamped.malice.evidence).toMatch(/\(raw \d+\/180 before the clamp\)\.$/);
  });

  it('prints the seven-axis clamp line, not the four-axis one it used to claim', () => {
    const out = renderDanger(attack);
    expect(attack.rawScore).toBeGreaterThan(100);
    expect(out).toMatch(/raw \d+ before the 100 clamp; the seven axes sum to 180, not 100/);
    expect(out).not.toMatch(/four axes sum to 120/);
  });
});

describe('malice in the report', () => {
  const minimal = (over: Partial<DotReport>): DotReport =>
    ({
      schema: 'dot.report.v1',
      generatedAt: '2026-10-22T00:00:00.000Z',
      program: 'Pg11111111111111111111111111111111111111',
      mode: 'rules',
      programData: 'HZcJwcJ2njPDxZtpPoKnF8v2w9QAx2rS7TdJPSRkbEhu',
      event: 'upgrade',
      tier: 'P1',
      tierSource: 'exposure',
      score: 62,
      confidence: 'medium',
      components: [],
      cappedBy: null,
      stoppedAt: 'report',
      stopNote: '',
      stages: [],
      decision: null,
      blastRadius: null,
      graph: null,
      evidence: [],
      limits: [],
      budget: { limits: {}, spent: { rpcCalls: 7, signatures: 2, llmTokens: 0, wallMs: 20 }, remaining: {} },
      rpc: { calls: 7, errors: 0, methodCounts: {}, refused: [], httpErrors: 0, jsonRpcErrors: [], slowestMs: 2 },
      wallMs: 20,
      ...over,
    }) as DotReport;

  it('puts the scream above the fold, not only inside the ranking block', () => {
    const danger = scoreDanger(base({
      delta: { confidence: 'structural', addedEntrypoints: ['drain'], undeclaredEntrypoints: ['drain'], accountChanges: [] },
      integrity: { funding: { state: 'flagged_source', fromAddress: 'declared-suspect', detail: 'received SOL from an address the operator named' }, declaredThreshold: null, timelockDeclared: false, fundingProbe: { callsSpent: 2, signaturesSeen: 1 } },
      timing: null,
    }));
    expect(danger.malice.flagged).toBe(true);
    const md = renderMarkdown(minimal({ danger }));
    const banner = md.indexOf('SUSPECTED_MALICIOUS');
    expect(banner).toBeGreaterThanOrEqual(0);
    expect(banner).toBeLessThan(md.indexOf('## Blast radius'));
    expect(md.slice(banner - 4, banner + 40)).toMatch(/> \*\*SUSPECTED_MALICIOUS/);
    // The alarm sentence itself, quoted as a blockquote above the fold and not only inside the
    // ranking block, and immediately followed by the evidence breakdown.
    expect(md).toContain(`> ${danger.malice.verdictLine}`);
    expect(md.slice(md.indexOf(danger.malice.verdictLine), md.indexOf(danger.malice.verdictLine) + 1200)).toMatch(/Authority integrity 30\/30/);
  });

  it('stays silent when the heuristic did not fire', () => {
    const md = renderMarkdown(minimal({ danger: scoreDanger(base()) }));
    expect(md).not.toMatch(/SUSPECTED_MALICIOUS/);
    expect(md).toMatch(/MALICE HEURISTIC: not flagged/);
  });
});

describe('the dot watch summary line', () => {
  // Both watch paths (poll and yellowstone) print one line per event, and that line is the only thing an
  // operator reads while a stream is running. Two separate call sites in a 1000-line CLI action is
  // exactly where a ranking went missing before by patching one string and not the other, so the
  // derivation is pinned here rather than trusted from a grep.
  const flagged = scoreDanger(base({
    delta: { confidence: 'structural', addedEntrypoints: ['drain'], undeclaredEntrypoints: ['drain'], accountChanges: [] },
    integrity: { funding: { state: 'flagged_source', fromAddress: 'declared-suspect', detail: 'received SOL from an address the operator named' }, declaredThreshold: null, timelockDeclared: false, fundingProbe: { callsSpent: 2, signaturesSeen: 1 } },
    timing: null,
  }));

  it('carries the scream and the alarm sentence when the gate fired', () => {
    expect(flagged.malice.flagged).toBe(true);
    const alarm = maliceAlarm({ danger: flagged });
    expect(alarm.suffix).toBe(' SUSPECTED_MALICIOUS');
    expect(alarm.line).toBe(
      'VERDICT: SUSPECTED_MALICIOUS — This upgrade has the structural signature of an attack. Immediate human review required. Do not trust the new bytecode.',
    );
  });

  it('borrows nothing for a CRITICAL that was not flagged, which is the common case', () => {
    // The same program, the same 100/100 queue position, with the funding evidence replaced by an
    // established history: high score, no positive evidence, no alarm. A suffix keyed off the category
    // would scream on roughly every single-key upgrade there is.
    const loudButUnflagged = scoreDanger(base({
      integrity: { funding: { state: 'established', detail: 'years of signatures' }, declaredThreshold: null, timelockDeclared: false, fundingProbe: { callsSpent: 3, signaturesSeen: 10 } },
      timing: null,
    }));
    expect(loudButUnflagged.category).toBe('CRITICAL');
    expect(loudButUnflagged.malice.flagged).toBe(false);
    expect(maliceAlarm({ danger: loudButUnflagged })).toEqual({ suffix: '', line: null });
  });

  it('says nothing when there is no ranking at all, rather than throwing on a watch tick that never scored', () => {
    expect(maliceAlarm({ danger: undefined })).toEqual({ suffix: '', line: null });
  });
});

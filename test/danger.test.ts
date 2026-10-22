import { describe, expect, it } from 'vitest';
import { categoryFor, renderDanger, scoreDanger, type DangerInputs } from '../src/score/danger.js';

/**
 * The arithmetic the brief specified, and — more importantly — the cases where the brief asks
 * for something Dot cannot measure. Those are asserted as *unassessed*, because the failure mode
 * of a scoring module is not a wrong sum: it is a 0 that reads like a clean bill of health.
 */
const base = (over: Partial<DangerInputs> = {}): DangerInputs => ({
  program: 'PgU11111111111111111111111111111111111111',
  authority: { posture: 'eoa', address: '4e7a1xR1qFkQ7G6zP9nYmV2sT8dLcB3rW6hXkJ9pNmQz' },
  delta: { confidence: 'structural', addedEntrypoints: [], undeclaredEntrypoints: [], accountChanges: [] },
  radius: { direct: 0, transitive: 0, lamportsRouted: 0, usdPerSol: null, mintsTouched: 0 },
  behavior: { priorDigestAt: '2026-09-01T00:00:00.000Z', stateFileUsed: true },
  ...over,
});

const flat = (over: Partial<DangerInputs> = {}) => base(over);
const axis = (d: ReturnType<typeof scoreDanger>, id: string) => d.axes.find((a) => a.id === id)!;
const say = (d: ReturnType<typeof scoreDanger>, id: string) => axis(d, id).detail.join(' ') + ' | ' + axis(d, id).notAssessed.join(' ');

describe('upgrade danger ranking — axes', () => {
  it('maps the score to the four bands exactly as specified', () => {
    expect(categoryFor(0)).toBe('LOW');
    expect(categoryFor(39)).toBe('LOW');
    expect(categoryFor(40)).toBe('MODERATE');
    expect(categoryFor(59)).toBe('MODERATE');
    expect(categoryFor(60)).toBe('HIGH');
    expect(categoryFor(79)).toBe('HIGH');
    expect(categoryFor(80)).toBe('CRITICAL');
    expect(categoryFor(100)).toBe('CRITICAL');
  });

  it('scores a single-key EOA at the full 40 and an immutable program at 0', () => {
    expect(axis(scoreDanger(flat()), 'authority').points).toBe(40);
    const renounced = scoreDanger(flat({ authority: { posture: 'renounced', address: null } }));
    expect(axis(renounced, 'authority').points).toBe(0);
    expect(axis(renounced, 'authority').label).toMatch(/renounced/i);
    const pda = scoreDanger(flat({ authority: { posture: 'program_derived', address: null } }));
    expect(axis(pda, 'authority').points).toBe(10);
  });

  it('scores a multisig at the alarming end and says the threshold is not readable', () => {
    const d = scoreDanger(flat({ authority: { posture: 'multisig', address: 'Msx11111111111111111111111111111111111111' } }));
    expect(axis(d, 'authority').points).toBe(25);
    expect(say(d, 'authority')).toMatch(/threshold not readable/i);
  });

  it('treats an unclassifiable authority as an absence, not as zero points', () => {
    const d = scoreDanger(flat({ authority: { posture: 'unknown', address: null } }));
    expect(axis(d, 'authority').points).toBeNull();
    expect(d.unassessedAxes).toContain('authority');
  });

  it('awards code delta from added entrypoints, account changes and unscannable bytecode', () => {
    const d = scoreDanger(flat({
      delta: {
        confidence: 'unscannable',
        addedEntrypoints: ['emergency_withdraw'],
        undeclaredEntrypoints: [],
        accountChanges: [{ instruction: 'emergency_withdraw', addedSigner: [], addedWritable: ['vault'] }],
      },
    }));
    expect(axis(d, 'codeDelta').points).toBe(30);
    expect(say(d, 'codeDelta')).toMatch(/`emergency_withdraw`/);
    expect(say(d, 'codeDelta')).toMatch(/writable vault/);
    expect(say(d, 'codeDelta')).toMatch(/unscannable/);
  });

  it('does not pay the blindness penalty for a merely partial diff', () => {
    // +5 is for `unscannable` — the scan ran and could not verify. `partial` is a missing prior
    // image, which the report already states in its own limits list.
    const d = scoreDanger(flat({ delta: { confidence: 'partial', addedEntrypoints: [], undeclaredEntrypoints: [], accountChanges: [] } }));
    expect(axis(d, 'codeDelta').points).toBe(0);
  });

  it('caps code delta at its own axis maximum', () => {
    const d = scoreDanger(flat({
      delta: {
        confidence: 'unscannable',
        addedEntrypoints: ['a', 'b', 'c'],
        undeclaredEntrypoints: [],
        accountChanges: [
          { instruction: 'a', addedSigner: ['s1'], addedWritable: [] },
          { instruction: 'b', addedSigner: [], addedWritable: ['w1'] },
          { instruction: 'c', addedSigner: ['s2'], addedWritable: ['w2'] },
        ],
      },
    }));
    expect(axis(d, 'codeDelta').points).toBe(30);
  });

  it('lists undeclared entrypoints without inventing points for them', () => {
    const d = scoreDanger(flat({ delta: { confidence: 'structural', addedEntrypoints: [], undeclaredEntrypoints: ['backdoor'], accountChanges: [] } }));
    expect(axis(d, 'codeDelta').points).toBe(0);
    expect(say(d, 'codeDelta')).toMatch(/backdoor/);
    expect(say(d, 'codeDelta')).toMatch(/no points/i);
  });

  it('caps the blast radius at 20 for direct and 10 for transitive dependents', () => {
    const d = scoreDanger(flat({ radius: { direct: 14, transitive: 34, lamportsRouted: 1_000, usdPerSol: null, mintsTouched: 0 } }));
    expect(axis(d, 'blastRadius').points).toBe(30);
    const one = scoreDanger(flat({ radius: { direct: 1, transitive: 0, lamportsRouted: 0, usdPerSol: null, mintsTouched: 0 } }));
    expect(axis(one, 'blastRadius').points).toBe(10);
  });

  it('doubles the radius over the 10M-lamport floor and still caps at 30', () => {
    const atFloor = scoreDanger(flat({ radius: { direct: 1, transitive: 1, lamportsRouted: 10_000_000, usdPerSol: null, mintsTouched: 0 } }));
    expect(axis(atFloor, 'blastRadius').points).toBe(15);
    const over = scoreDanger(flat({ radius: { direct: 1, transitive: 1, lamportsRouted: 10_000_001, usdPerSol: null, mintsTouched: 0 } }));
    expect(axis(over, 'blastRadius').points).toBe(30);
    expect(say(over, 'blastRadius')).toMatch(/×2/);
  });

  it('refuses to evaluate the multiplier when value routing was never observed', () => {
    const d = scoreDanger(flat({ radius: { direct: 4, transitive: 9, lamportsRouted: null, usdPerSol: null, mintsTouched: 2 } }));
    expect(axis(d, 'blastRadius').points).toBe(30);
    expect(say(d, 'blastRadius')).toMatch(/not observed/i);
    expect(say(d, 'blastRadius')).toMatch(/token mint/i);
    expect(axis(d, 'blastRadius').label).toMatch(/value routing unobserved/);
  });

  it('prints a dollar figure only when the operator supplied a price', () => {
    const r = { direct: 3, transitive: 3, lamportsRouted: 266_666_666_666, usdPerSol: 150, mintsTouched: 0 };
    expect(axis(scoreDanger(flat({ radius: r })), 'blastRadius').label).toMatch(/\(~\$40,000\) in the sample/);
    expect(axis(scoreDanger(flat({ radius: { ...r, usdPerSol: null } })), 'blastRadius').label).not.toMatch(/\$/);
    // An observed zero with a price supplied prints no dollar figure: "~$0 of routing" is a
    // formatting artifact, and it was in the live output until this line existed.
    expect(axis(scoreDanger(flat({ radius: { ...r, lamportsRouted: 0 } })), 'blastRadius').label).toMatch(/routing 0 lamports in the sample/);
  });

  it('calls a first observed upgrade 20 points and names the limit of that claim', () => {
    const d = scoreDanger(flat({ behavior: { priorDigestAt: null, stateFileUsed: true } }));
    expect(axis(d, 'behavior').points).toBe(20);
    expect(say(d, 'behavior')).toMatch(/not a claim that the program has never been upgraded/i);
  });

  it('scores nothing when there is no state file for a first sighting to be missing from', () => {
    const d = scoreDanger(flat({ behavior: { priorDigestAt: null, stateFileUsed: false } }));
    expect(axis(d, 'behavior').points).toBeNull();
    expect(d.unassessedAxes).toContain('behavior');
  });

  it('never awards the ecosystem-event bonus, and says why', () => {
    const d = scoreDanger(flat({ behavior: { priorDigestAt: null, stateFileUsed: true } }));
    expect(say(d, 'behavior')).toMatch(/no event feed/i);
    expect(axis(d, 'behavior').points).toBeLessThanOrEqual(20);
  });
});

describe('upgrade danger ranking — totals, ceilings and output', () => {
  const maxedOut = (over: Partial<DangerInputs> = {}) => scoreDanger(flat({
    delta: { confidence: 'unscannable', addedEntrypoints: ['x'], undeclaredEntrypoints: [], accountChanges: [{ instruction: 'x', addedSigner: ['s'], addedWritable: ['w'] }] },
    radius: { direct: 5, transitive: 5, lamportsRouted: 20_000_000, usdPerSol: null, mintsTouched: 0 },
    behavior: { priorDigestAt: null, stateFileUsed: true },
    ...over,
  }));

  it('keeps the raw total visible because the axes sum to 120, not 100', () => {
    const d = maxedOut();
    expect(d.rawScore).toBe(120);
    expect(d.score).toBe(100);
    expect(d.category).toBe('CRITICAL');
    expect(renderDanger(d)).toMatch(/raw 120 before the 100 clamp/);
  });

  it('treats a missing graph and a missing diff as holes in the total, not as low scores', () => {
    const d = scoreDanger(flat({ delta: null, radius: null, behavior: null }));
    expect(d.unassessedAxes.slice().sort()).toEqual(['behavior', 'blastRadius', 'codeDelta']);
    expect(d.coverage).toEqual({ scored: 40, possible: 40 });
    expect(d.score).toBe(40);
    // MODERATE, not LOW: a single key that can rewrite the program is worth 40 points on its
    // own, and the band table says 40 is the bottom of MODERATE. What the missing axes change is
    // the *ceiling* and the coverage line, not this — the score is a queue position and an
    // unmeasured blast radius does not make an EOA-authority upgrade safe.
    expect(d.category).toBe('MODERATE');
    expect(d.verdict).toMatch(/unknown rather than small/);
    expect(renderDanger(d)).toMatch(/scored on 40 of 40 measurable axis points; no data for: codeDelta, blastRadius, behavior/);
  });

  it('withholds CRITICAL when an axis was not measured, and records the withholding', () => {
    const full = maxedOut();
    expect(full.uncappedCategory).toBe('CRITICAL');
    expect(full.ceiling).toBeNull();
    const noRadius = maxedOut({ radius: null });
    expect(noRadius.rawScore).toBe(90);
    expect(noRadius.category).toBe('HIGH');
    expect(noRadius.ceiling).toMatch(/CRITICAL withheld/);
    expect(noRadius.unassessedAxes).toEqual(['blastRadius']);
    const noDelta = maxedOut({ delta: null });
    expect(noDelta.category).toBe('HIGH');
  });

  it('renders the tree the brief asked for, with one line per axis and a verdict', () => {
    const d = scoreDanger(flat({
      delta: { confidence: 'structural', addedEntrypoints: ['emergency_withdraw'], undeclaredEntrypoints: [], accountChanges: [] },
      radius: { direct: 1, transitive: 34, lamportsRouted: 0, usdPerSol: null, mintsTouched: 0 },
      behavior: { priorDigestAt: null, stateFileUsed: true },
    }));
    expect(d.score).toBe(95);
    const out = renderDanger(d);
    expect(out).toMatch(/^UPGRADE DANGER RANKING: CRITICAL \(Score: 95\/100\)$/m);
    expect(out).toMatch(/├── Authority: Single-key EOA \(4e7a\S+\) \[\+40\/40\]/);
    expect(out).toMatch(/├── Code Delta: added entrypoint `emergency_withdraw` \[\+15\/30\]/);
    expect(out).toMatch(/├── Blast Radius: 1 direct, 34 transitive, routing 0 lamports in the sample \(a per-transaction proxy, not a TVL figure\) \[\+20\/30\]/);
    expect(out).toMatch(/└── Behavior: first upgrade Dot has observed for this program \[\+20\/20\]/);
    expect(out).toMatch(/^VERDICT: /m);
    expect(out.match(/[├└]── /g)?.length).toBe(4);
  });

  it('does not call a new entrypoint a vulnerability anywhere in the output', () => {
    const d = scoreDanger(flat({ delta: { confidence: 'structural', addedEntrypoints: ['emergency_withdraw'], undeclaredEntrypoints: [], accountChanges: [] } }));
    const out = `${renderDanger(d)} ${d.verdict}`.toLowerCase();
    expect(out).not.toMatch(/vulnerab|exploit|malicious|attack surface/);
    expect(out).toMatch(/queue|open it|pass|no immediate action/);
  });
});

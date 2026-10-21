import { describe, expect, it } from 'vitest';
import { analyzeTrace, foldInnerInstructions, treeFromLogs } from '../src/graph/normalize.js';
import { resolveAccountKeys } from '../src/graph/keys.js';
import { txFixture } from './helpers.js';

const A = '5PjDJaGfSPJj4tFzMRCiuuAasKg5n8dJKXKenhuwZexx';
const B = '5TeWSsjg2gbxCyWVniXeCmwM7UtHTCK7svzJr5xYJzHf';
const C = '5XZobBCgcyuBM4m1E1rZVei7Me6V8FzwSLexuU194KcN';
const D = '5bV6jUfhDHCQVA1WfKBUnXUsboJgoKgkzkKcxr3joew5';
const SYSTEM = '11111111111111111111111111111111';

describe('innerInstructions fold', () => {
  it('maps group index onto the OUTER instruction position', () => {
    const tx = txFixture('tx-nested');
    const outer = tx.transaction.message.instructions;
    const { groups, anomalies } = foldInnerInstructions(tx.meta.innerInstructions, outer.length);
    expect(anomalies).toEqual([]);
    // The captured transaction has CPIs under exactly two outer instructions.
    expect([...groups.keys()].sort((a, b) => a - b)).toEqual([2, 4]);
    const outerFor = (i: number) => outer[i]?.programId;
    let selfCpi = 0;
    for (const [idx, list] of groups) {
      expect(outerFor(idx)).toBeDefined();
      for (const ins of list) if (ins.programId === outerFor(idx)) selfCpi++;
    }
    // A program CPI'ing into itself is legal and common (the captured pAMM trace
    // does it). Asserting every callee differs from its caller would be a claim
    // about Solana programs that the chain contradicts.
    expect(selfCpi).toBeGreaterThanOrEqual(0);
    const a = analyzeTrace(tx, resolveAccountKeys(tx));
    expect(a.frames.filter((f) => f.programId === f.parentProgramId).length).toBe(selfCpi);
    expect(groups.get(2)?.length).toBe(4);
    expect(groups.get(4)?.length).toBe(7);
  });

  it('drops and reports a group whose index is out of range instead of misattributing it', () => {
    const { groups, anomalies } = foldInnerInstructions([{ index: 9, instructions: [{ programId: A }] }], 6);
    expect(groups.size).toBe(0);
    expect(anomalies[0]).toMatch(/outside the outer instruction range/);
  });

  it('concatenates and reports a duplicated index', () => {
    const { groups, anomalies } = foldInnerInstructions(
      [
        { index: 1, instructions: [{ programId: A }] },
        { index: 1, instructions: [{ programId: B }] },
      ],
      3,
    );
    expect(groups.get(1)?.length).toBe(2);
    expect(anomalies.some((a) => /appeared twice/.test(a))).toBe(true);
  });
});

describe('call-tree attribution', () => {
  it('attributes a depth-3 callee to its immediate caller, not to the transaction root', () => {
    const tx = txFixture('tx-depth3');
    const resolution = resolveAccountKeys(tx);
    const a = analyzeTrace(tx, resolution);
    expect(a.quality).toBe('stackHeight');
    const byProgram = new Map(a.frames.map((f) => [f.programId, f]));
    expect(byProgram.get(B)?.parentProgramId).toBe(A);
    expect(byProgram.get(C)?.parentProgramId).toBe(B);
    expect(byProgram.get(C)?.depth).toBe(3);
    expect(byProgram.get(D)?.parentProgramId).toBe(A);
    expect(byProgram.get(C)?.establishedBy).toBe('stackHeight');
  });

  it('falls back to the log tree when the node omits stackHeight, keeping depth-3 honest', () => {
    const tx = txFixture('tx-logs-only');
    const a = analyzeTrace(tx, resolveAccountKeys(tx));
    expect(a.quality).toBe('logs');
    const byProgram = new Map(a.frames.map((f) => [f.programId, f]));
    expect(byProgram.get(C)?.parentProgramId).toBe(B);
    expect(byProgram.get(B)?.parentProgramId).toBe(A);
    expect(a.flattenedFrames).toBe(0);
  });

  it('reports flat attribution when neither stackHeight nor logs are available', () => {
    const tx = txFixture('tx-logs-only');
    tx.meta.logMessages = null;
    const a = analyzeTrace(tx, resolveAccountKeys(tx));
    expect(a.quality).toBe('flat');
    const byProgram = new Map(a.frames.map((f) => [f.programId, f]));
    // This is the overcounting a naive analyzer does silently; Dot labels it.
    expect(byProgram.get(C)?.parentProgramId).toBe(A);
    expect(a.flattenedFrames).toBe(4);
  });

  it('marks a nested call that failed as failed, so value is never claimed for it', () => {
    const tx = txFixture('tx-logs-only');
    const a = analyzeTrace(tx, resolveAccountKeys(tx));
    const charlie = a.frames.find((f) => f.programId === C);
    expect(charlie?.outcome).toBe('failed');
  });
});

describe('log tree parsing', () => {
  it('pairs invoke/success/failed and flags truncation', () => {
    const t = treeFromLogs([
      `Program ${A} invoke [1]`,
      `Program log: Instruction: Swap`,
      `Program ${B} invoke [2]`,
      `Program ${B} consumed 179 of 972446 compute units`,
      `Program return: ${B} pQAAAAAAAAA=`,
      `Program ${B} success`,
      `Program ${A} success`,
      'Log truncated',
    ]);
    expect(t.frames.map((f) => `${f.programId}@${f.depth}:${f.outcome}`)).toEqual([`${A}@1:ok`, `${B}@2:ok`]);
    expect(t.truncated).toBe(true);
    expect(t.unbalanced).toBe(0);
  });

  it('leaves an unclosed frame unknown rather than guessing success', () => {
    const t = treeFromLogs([`Program ${A} invoke [1]`, `Program ${B} invoke [2]`]);
    expect(t.frames.map((f) => f.outcome)).toEqual(['unknown', 'unknown']);
  });

  it('counts a pop that does not match the pushed program as unbalanced', () => {
    const t = treeFromLogs([`Program ${A} invoke [1]`, `Program ${B} success`]);
    expect(t.unbalanced).toBe(1);
  });
});

describe('real transaction regression', () => {
  it('produces 11 attributed frames from the captured mainnet transaction', () => {
    const tx = txFixture('tx-nested');
    const a = analyzeTrace(tx, resolveAccountKeys(tx));
    expect(a.frames).toHaveLength(11);
    expect(a.quality).toBe('stackHeight');
    expect(a.attributionDisagreement).toBeNull();
    for (const f of a.frames) expect(f.parentProgramId).toBeTruthy();
  });
});

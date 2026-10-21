import { describe, expect, it } from 'vitest';
import { Budget } from '../src/agent/budget.js';
import { BudgetExhaustedError, DotError } from '../src/errors.js';
import { fakeClock } from './helpers.js';

describe('Budget', () => {
  it('refuses an RPC call before it is issued, not after', () => {
    const b = new Budget({ maxRpcCalls: 2, maxSignatures: 100, maxLlmTokens: 0, maxWallMs: 60_000 });
    b.spendRpc(1, 'getSlot');
    b.spendRpc(1, 'getSlot');
    let thrown: BudgetExhaustedError | undefined;
    try {
      b.spendRpc(1, 'getTransaction');
    } catch (e) {
      thrown = e as BudgetExhaustedError;
    }
    expect(thrown).toBeInstanceOf(BudgetExhaustedError);
    expect(thrown?.kind).toBe('rpc');
    // The charge was refused, so the counter did not move past the limit.
    expect(b.snapshot().spent.rpcCalls).toBe(2);
    expect(b.snapshot().remaining.rpcCalls).toBe(0);
  });

  it('counts a failed call as spent — the node already did the work', () => {
    const b = new Budget({ maxRpcCalls: 1 });
    b.spendRpc(1, 'getTransaction');
    expect(() => b.spendRpc(1, 'getTransaction')).toThrow(BudgetExhaustedError);
  });

  it('stops on the wall clock and reports which budget broke', () => {
    const clock = fakeClock(10_000);
    const b = new Budget({ maxRpcCalls: 500, maxWallMs: 5_000, maxSignatures: 500, maxLlmTokens: 500 }, clock);
    clock.advance(4_999);
    expect(() => b.spendRpc(1, 'x')).not.toThrow();
    clock.advance(10);
    let thrown: BudgetExhaustedError | undefined;
    try {
      b.spendRpc(1, 'x');
    } catch (e) {
      thrown = e as BudgetExhaustedError;
    }
    expect(thrown?.kind).toBe('wall');
    expect(b.elapsedMs).toBe(5_009);
  });

  it('settles LLM tokens against the reservation and surfaces an overrun', () => {
    const b = new Budget({ maxLlmTokens: 1000, maxRpcCalls: 10, maxSignatures: 10, maxWallMs: 60_000 });
    b.reserveTokens(400);
    expect(b.snapshot().spent.llmTokensReserved).toBe(400);
    b.settleTokens(1200);
    expect(b.snapshot().spent.llmTokensSettled).toBe(1200);
    expect(b.overrun).toBe(200);
    expect(() => b.reserveTokens(1)).toThrow(BudgetExhaustedError);
  });

  it('refuses a reservation that would cross the token cap instead of overcommitting', () => {
    const b = new Budget({ maxLlmTokens: 1000 });
    b.reserveTokens(900);
    let code = '';
    try {
      b.reserveTokens(200);
    } catch (e) {
      code = (e as DotError).code;
    }
    expect(code).toBe('BUDGET_EXHAUSTED_TOKENS');
    expect(b.snapshot().spent.llmTokensReserved).toBe(900);
  });

  it('derives how many signatures are still affordable from both caps', () => {
    const b = new Budget({ maxRpcCalls: 10, maxSignatures: 3 });
    expect(b.affordableSignatures(1)).toBe(3);
    b.spendSignatures(2);
    expect(b.affordableSignatures(1)).toBe(1);
    b.spendSignatures(1);
    expect(b.affordableSignatures(1)).toBe(0);
    expect(() => b.spendSignatures(1)).toThrow(/signature/);
  });

  it('enforces the signature cap independently of the call cap', () => {
    const b = new Budget({ maxRpcCalls: 1000, maxSignatures: 2 });
    b.spendSignatures(1);
    b.spendSignatures(1);
    expect(() => b.spendSignatures(1)).toThrow(BudgetExhaustedError);
    expect(b.snapshot().spent.rpcCalls).toBe(0);
  });

  it('freezes elapsed time once stopped so a serialized report is stable', () => {
    const clock = fakeClock(0);
    const b = new Budget({ maxWallMs: 100_000 }, clock);
    clock.advance(300);
    b.stop('planned stop');
    const a = b.elapsedMs;
    clock.advance(5_000);
    expect(b.elapsedMs).toBe(a);
    expect(b.snapshot().stoppedBy).toBe('planned stop');
  });
});

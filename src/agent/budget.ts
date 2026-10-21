import { BudgetExhaustedError } from '../errors.js';

export type BudgetLimits = {
  /** Every JSON-RPC round trip counts as one call, including failed and retried ones. */
  maxRpcCalls: number;
  maxLlmTokens: number;
  maxWallMs: number;
  /** Cap on transaction signatures pulled into the trace, independent of RPC calls. */
  maxSignatures: number;
};

export type BudgetSnapshot = {
  limits: BudgetLimits;
  spent: {
    rpcCalls: number;
    llmTokensSettled: number;
    llmTokensReserved: number;
    signatures: number;
  };
  remaining: {
    rpcCalls: number;
    llmTokens: number;
    signatures: number;
    wallMs: number;
  };
  elapsedMs: number;
  /** What the last refused spend was, if anything refused. */
  stoppedBy?: string;
};

export type Clock = { now(): number };
export const systemClock: Clock = { now: () => Date.now() };

/**
 * A hard spend ceiling owned by one agent run and shared by everything that
 * can consume it — the RPC client, the signature sampler and the LLM.
 *
 * Three properties that make it a budget rather than a counter:
 *
 *  - **Reserve before act.** Every guarded call checks *before* the request
 *    goes out. A refused call is still a decision the agent made, and shows up
 *    in the trace.
 *  - **A failed call is a spent call.** `spendRpc` is charged up front and is
 *    never refunded, because the RPC node already did the work and the wall
 *    clock already moved.
 *  - **Tokens are estimated, then settled.** You cannot know an LLM's usage
 *    before paying for it, so the reservation is an upper bound and the real
 *    figure reconciles afterwards. Overdraft past `maxLlmTokens` is allowed
 *    exactly once — the in-flight request cannot be un-billed — and is reported.
 */
export class Budget {
  readonly limits: BudgetLimits;
  private readonly clock: Clock;
  private readonly startedAt: number;
  private stoppedAt: number | null = null;

  private rpcCalls = 0;
  private llmTokensSettled = 0;
  private llmTokensReserved = 0;
  private signatures = 0;
  private stoppedBy: string | undefined;

  constructor(limits: Partial<BudgetLimits> = {}, clock: Clock = systemClock) {
    this.limits = { ...Budget.defaultLimits(), ...limits };
    this.clock = clock;
    this.startedAt = clock.now();
  }

  static defaultLimits(): BudgetLimits {
    return { maxRpcCalls: 250, maxLlmTokens: 20_000, maxWallMs: 120_000, maxSignatures: 400 };
  }

  /** A budget with no meaningful ceilings, for `dot analyze --unbounded`. */
  static unlimited(clock: Clock = systemClock): Budget {
    return new Budget(
      {
        maxRpcCalls: Number.MAX_SAFE_INTEGER,
        maxLlmTokens: Number.MAX_SAFE_INTEGER,
        maxWallMs: Number.MAX_SAFE_INTEGER,
        maxSignatures: Number.MAX_SAFE_INTEGER,
      },
      clock,
    );
  }

  get elapsedMs(): number {
    return (this.stoppedAt ?? this.clock.now()) - this.startedAt;
  }

  /** Stops the wall clock so a serialized report keeps a stable number. */
  stop(reason?: string): void {
    if (this.stoppedAt === null) this.stoppedAt = this.clock.now();
    if (reason) this.stoppedBy = reason;
  }

  private assertWall(): void {
    if (this.elapsedMs > this.limits.maxWallMs) {
      throw new BudgetExhaustedError('wall', this.limits.maxWallMs, this.elapsedMs, 0);
    }
  }

  /** Charge `calls` RPC round trips. Throws before the request is issued. */
  spendRpc(calls: number, purpose: string): void {
    this.assertWall();
    const next = this.rpcCalls + calls;
    if (next > this.limits.maxRpcCalls) {
      throw new BudgetExhaustedError('rpc', this.limits.maxRpcCalls, this.rpcCalls, calls);
    }
    this.rpcCalls = next;
    this.lastPurpose = purpose;
  }

  /** Non-throwing probe used by the Decide step to plan remaining work. */
  canAffordRpc(calls: number): boolean {
    return (
      this.rpcCalls + calls <= this.limits.maxRpcCalls &&
      this.elapsedMs <= this.limits.maxWallMs
    );
  }

  /** How many signatures may still be pulled without busting the RPC budget. */
  affordableSignatures(batchSize: number): number {
    if (batchSize <= 0) return 0;
    const byRpc = Math.max(0, this.limits.maxRpcCalls - this.rpcCalls) * batchSize;
    return Math.min(byRpc, Math.max(0, this.limits.maxSignatures - this.signatures));
  }

  spendSignatures(n: number): void {
    this.assertWall();
    const next = this.signatures + n;
    if (next > this.limits.maxSignatures) {
      throw new BudgetExhaustedError('signatures', this.limits.maxSignatures, this.signatures, n);
    }
    this.signatures = next;
  }

  /** Upper-bound reservation for an LLM call. Refuses if it would cross the cap. */
  reserveTokens(estimate: number): void {
    this.assertWall();
    const next = this.llmTokensSettled + this.llmTokensReserved + estimate;
    if (next > this.limits.maxLlmTokens) {
      throw new BudgetExhaustedError('tokens', this.limits.maxLlmTokens, this.llmTokensSettled, estimate);
    }
    this.llmTokensReserved += estimate;
  }

  /** Reconcile a reservation with billed usage. `actual > estimate` is recorded, not hidden. */
  settleTokens(actual: number): void {
    const released = Math.min(this.llmTokensReserved, actual);
    this.llmTokensReserved -= released;
    this.llmTokensSettled += actual;
    this.overrun = Math.max(0, this.llmTokensSettled - this.limits.maxLlmTokens);
  }

  /** Tokens billed past the cap because an estimate was low. Non-zero means "report it". */
  overrun = 0;

  private lastPurpose = '';

  lastRpcPurpose(): string {
    return this.lastPurpose;
  }

  snapshot(): BudgetSnapshot {
    const { maxRpcCalls, maxLlmTokens, maxWallMs, maxSignatures } = this.limits;
    return {
      limits: this.limits,
      spent: {
        rpcCalls: this.rpcCalls,
        llmTokensSettled: this.llmTokensSettled,
        llmTokensReserved: this.llmTokensReserved,
        signatures: this.signatures,
      },
      remaining: {
        rpcCalls: Math.max(0, maxRpcCalls - this.rpcCalls),
        llmTokens: Math.max(0, maxLlmTokens - this.llmTokensSettled - this.llmTokensReserved),
        signatures: Math.max(0, maxSignatures - this.signatures),
        wallMs: Math.max(0, maxWallMs - this.elapsedMs),
      },
      elapsedMs: this.elapsedMs,
      ...(this.stoppedBy ? { stoppedBy: this.stoppedBy } : {}),
    };
  }
}

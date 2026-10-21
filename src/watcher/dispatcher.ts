import type { BudgetLimits } from '../agent/budget.js';
import type { UpgradeEvent } from './watcher.js';
import { isDotError } from '../errors.js';

/**
 * Fair-share budgeting across a stream of upgrades.
 *
 * The chain-wide feed changes the failure mode. With a hand-typed target list you
 * worry about one program's history. With every `ProgramData` write on mainnet, a
 * single deploy storm — one team shipping twelve programs, or one attacker
 * triggering an upgrade loop — can consume the entire day's RPC allowance on the
 * first interesting-looking event, and every later event silently gets nothing.
 *
 * So two ceilings apply, and they do different jobs:
 *
 *   - `maxPerEvent` bounds one investigation. No analysis gets the whole pool.
 *   - `dailyRpcTotal` bounds the daemon. When it runs out, events are **dropped and
 *     counted**, never queued into an unbounded backlog and never analysed with an
 *     8-call budget that would only produce a report that looks thin.
 *
 * Drops are the honest part: `dropped` is per-reason and the queue drains one at a
 * time so a busy hour cannot turn into a concurrent thundering herd on one endpoint.
 */

export type DispatcherLimits = {
  /** RPC calls one upgrade investigation may spend. */
  maxPerEvent: number;
  /** RPC calls the daemon may spend before it starts dropping. */
  dailyRpcTotal: number;
  /** Analyses buffered while one is running. */
  maxQueue: number;
  /** An analysis below this cannot read state *and* sample a trace, so it is refused. */
  minViable: number;
};

export const DEFAULT_DISPATCHER_LIMITS: DispatcherLimits = {
  maxPerEvent: 50,
  dailyRpcTotal: 5_000,
  maxQueue: 64,
  minViable: 12,
};

export type DispatchOutcome = 'running' | 'queued' | 'dropped:queue_full' | 'dropped:daily_pool' | 'dropped:below_minimum' | 'failed';

export type DispatchStats = {
  offered: number;
  started: number;
  completed: number;
  failed: number;
  dropped: { queue_full: number; daily_pool: number; below_minimum: number };
  rpcSpentToday: number;
  rpcRemainingToday: number;
  perEventCap: number;
  queueDepth: number;
  lastOutcome: DispatchOutcome | null;
};


export type EventResult = { program: string; tier: string; stoppedAt: string; rpcCalls: number };

type QueueItem = { event: UpgradeEvent; priority: number; seq: number };

export class UpgradeDispatcher {
  private readonly limits: DispatcherLimits;
  private readonly queue: QueueItem[] = [];
  private seq = 0;
  private pumping = false;
  private rpcSpentToday = 0;
  private lastOutcome: DispatchOutcome | null = null;
  private readonly dayStart: number;
  private readonly clock: () => number;

  constructor(
    private readonly analyze: (event: UpgradeEvent, budgetLimits: BudgetLimits) => Promise<EventResult>,
    limits: Partial<DispatcherLimits> = {},
    clock: () => number = () => Date.now(),
  ) {
    this.limits = { ...DEFAULT_DISPATCHER_LIMITS, ...limits };
    this.clock = clock;
    this.dayStart = clock();
  }

  /**
   * Routine bytecode upgrades on programs Dot already characterised go last. An
   * authority handover or a vanished ProgramData goes first: those are the two
   * events where the delay between noticing and knowing is the exposure.
   */
  static priority(event: UpgradeEvent): number {
    if (event.kind === 'authority_change' || event.kind === 'program_data_closed' || event.kind === 'program_data_reopened') return 0;
    if (event.before?.authority === null && event.after?.authority !== null) return 0;
    if (event.changed.size && Math.abs(event.after!.bytecodeLen - event.before!.bytecodeLen) / Math.max(1, event.before!.bytecodeLen) > 0.15) return 1;
    return 2;
  }

  offer(event: UpgradeEvent): DispatchOutcome {
    this.offered++;
    const remaining = this.remainingToday();
    if (remaining < this.limits.minViable) {
      this.dropped.daily_pool++;
      this.lastOutcome = 'dropped:daily_pool';
      return this.lastOutcome;
    }
    if (Math.min(this.limits.maxPerEvent, remaining) < this.limits.minViable) {
      this.dropped.below_minimum++;
      this.lastOutcome = 'dropped:below_minimum';
      return this.lastOutcome;
    }
    if (this.queue.length >= this.limits.maxQueue) {
      this.dropped.queue_full++;
      this.lastOutcome = 'dropped:queue_full';
      return this.lastOutcome;
    }
    this.queue.push({ event, priority: UpgradeDispatcher.priority(event), seq: ++this.seq });
    this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    this.lastOutcome = this.pumping ? 'queued' : 'running';
    void this.pump();
    return this.lastOutcome;
  }

  private remainingToday(): number {
    return Math.max(0, this.limits.dailyRpcTotal - this.rpcSpentToday);
  }

  /**
   * Strictly serial. Concurrency here would multiply the endpoint's rate limiting
   * into the middle of an incident, which is the worst possible moment to discover
   * the node you depend on has a burst ceiling.
   */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        const cap = Math.min(this.limits.maxPerEvent, this.remainingToday());
        if (cap < this.limits.minViable) {
          this.dropped.daily_pool++;
          this.lastOutcome = 'dropped:daily_pool';
          continue;
        }
        this.started++;
        try {
          const res = await this.analyze(item.event, {
            maxRpcCalls: cap,
            maxSignatures: cap,
            maxLlmTokens: 0,
            maxWallMs: 120_000,
          });
          this.rpcSpentToday += res.rpcCalls;
          this.completed++;
        } catch (e) {
          this.failed++;
          // A budget stop means the ceiling worked. Anything else is an outage or a
          // bug, and must not take the daemon down with it.
          if (!isDotError(e) || !e.code.startsWith('BUDGET')) {
            this.lastError = e instanceof Error ? e.message : String(e);
          }
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  stats(): DispatchStats {
    return {
      offered: this.offered,
      started: this.started,
      completed: this.completed,
      failed: this.failed,
      dropped: { ...this.dropped },
      rpcSpentToday: this.rpcSpentToday,
      rpcRemainingToday: this.remainingToday(),
      perEventCap: this.limits.maxPerEvent,
      queueDepth: this.queue.length,
      lastOutcome: this.lastOutcome,
    };
  }

  private offered = 0;
  private started = 0;
  private completed = 0;
  private failed = 0;
  private dropped = { queue_full: 0, daily_pool: 0, below_minimum: 0 };
  private lastError: string | null = null;

  /** Waits for the queue to drain. Used by `--once` and by tests. */
  async idle(): Promise<void> {
    while (this.pumping || this.queue.length > 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  dayAgeMs(): number {
    return this.clock() - this.dayStart;
  }
}

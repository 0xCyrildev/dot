import { EventEmitter } from 'node:events';
import { SolanaClient } from '../rpc/client.js';
import { deriveProgramData, decodeProgramData, readProgramPointer, type ProgramDataState } from '../state/programdata.js';
import { DotError, describeError, isDotError } from '../errors.js';

export type WatchTarget = {
  program: string;
  label?: string;
  /** Operator-maintained: RPC cannot tell you whether an authority is a multisig. */
  knownMultisigs?: string[];
};

export type ObservedState = {
  programData: string;
  bytecodeHash: string;
  fullAccountHash: string;
  authority: string | null;
  bytecodeLen: number;
  accountLen: number;
  /** First u64 in the ProgramData header. In the layouts measured here this tracks an upgrade slot, but Dot does not rely on that. */
  headerU64: number;
  observedAt: number;
  /** Account was absent when last read. */
  closed: boolean;
};

export type UpgradeEvent = {
  kind: 'upgrade' | 'authority_change' | 'program_data_closed' | 'program_data_reopened';
  program: string;
  label?: string;
  programData: string;
  before: ObservedState | null;
  after: ObservedState | null;
  /** Which of the three signals moved. Bytecode-only changes are the common case. */
  changed: { bytecode: boolean; authority: boolean; size: boolean };
  detectedAt: number;
  source: 'baseline' | 'poll' | 'ws';
};

export type WatchStatus = {
  mode: 'poll' | 'ws';
  network: string;
  targets: number;
  observed: number;
  ticks: number;
  lastTickAt: number | null;
  lastReadSlot: number;
  eventsEmitted: number;
  consecutiveFailures: number;
  running: boolean;
  cursorPersisted: boolean;
  note: string;
  feed?: unknown;
  dispatcher?: unknown;
};

export type WatcherOptions = {
  /** Emit an event for the very first observation of each target. Default false. */
  fireOnBaseline?: boolean;
  /** ms between polls. Ignored in websocket mode except as a safety resync. */
  intervalMs?: number;
  mode?: 'poll' | 'ws';
  /** Resync interval for ws mode: a dropped subscription with no reconnect is a silent outage. */
  resyncMs?: number;
};

/**
 * Detects bytecode changes on `BPFLoaderUpgradeable` `ProgramData` accounts.
 *
 * Two deliberate choices:
 *
 *  1. **Change detection hashes the whole account, not a window.** The offset of
 *     the executable region is layout-dependent, and Dot has measured that the
 *     layouts in the wild do not match the constants in the SDK docs. A hash over
 *     `data.slice(guessedOffset)` produces a false negative the moment the offset
 *     is wrong — the worst possible failure for a watcher, because it looks like
 *     an all-clear. `fullAccountHash` never misses; `bytecodeHash` is computed
 *     only after the ELF magic has been *found*, and is what answers "did the
 *     code change" versus "did only the header move".
 *  2. **The daemon is not budgeted; the analysis is.** One `getAccountInfo` per
 *     target per tick is the whole cost of watching. When an event fires, the
 *     Scout run that follows gets a fresh `Budget`, so a busy day of upgrades
 *     cannot spend tomorrow's history window.
 */
export class UpgradeWatcher extends EventEmitter {
  private readonly client: SolanaClient;
  private readonly targets: WatchTarget[];
  private readonly state = new Map<string, ObservedState>();
  private readonly opts: Required<Pick<WatcherOptions, 'fireOnBaseline' | 'intervalMs' | 'mode' | 'resyncMs'>>;
  private timer: NodeJS.Timeout | null = null;
  private resyncTimer: NodeJS.Timeout | null = null;
  private ws: WebSocket | null = null;
  private subIds = new Map<string, number>();
  private running = false;
  private consecutiveFailures = 0;
  private ticks = 0;
  private lastTickAt = 0;
  private eventsEmitted = 0;
  /**
   * Highest account slot this daemon has read. That is the cursor: a polling watcher
   * has no ledger position of its own, and pretending otherwise would let a report
   * claim continuity across restarts it does not have.
   */
  private lastReadSlot = 0;

  constructor(client: SolanaClient, targets: WatchTarget[], opts: WatcherOptions = {}) {
    super();
    this.client = client;
    this.targets = targets;
    this.opts = {
      fireOnBaseline: opts.fireOnBaseline ?? false,
      intervalMs: opts.intervalMs ?? 30_000,
      mode: opts.mode ?? 'poll',
      resyncMs: opts.resyncMs ?? 300_000,
    };
    if (targets.length === 0) throw new DotError('NOT_UPGRADEABLE', 'no watch targets supplied', {});
  }

  snapshot(): ObservedState[] {
    return [...this.state.values()];
  }

  /**
   * The watcher's own position. `cursorPersisted` is false unless a caller writes
   * this out, because a daemon that restarts and reports a cursor it never restored
   * is reporting a gap as a sweep.
   */
  status(): WatchStatus {
    return {
      mode: this.opts.mode,
      network: 'unknown',
      targets: this.targets.length,
      observed: this.state.size,
      ticks: this.ticks,
      lastTickAt: this.lastTickAt || null,
      lastReadSlot: this.lastReadSlot,
      eventsEmitted: this.eventsEmitted,
      consecutiveFailures: this.consecutiveFailures,
      running: this.running,
      cursorPersisted: false,
      note:
        'a polling watcher has no ledger cursor; lastReadSlot is the highest account slot this process read, and nothing observed before the process started',
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.tick('baseline');
    if (this.opts.mode === 'ws') {
      this.connectWs().catch((e) => this.emit('error', e));
      this.resyncTimer = setInterval(() => {
        void this.tick('poll').catch((e) => this.emit('error', e));
      }, this.opts.resyncMs);
    } else {
      this.timer = setInterval(() => {
        void this.tick('poll').catch((e) => this.emit('error', e));
      }, this.opts.intervalMs);
    }
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    if (this.resyncTimer) clearInterval(this.resyncTimer);
    this.timer = null;
    this.resyncTimer = null;
    for (const id of this.subIds.values()) {
      this.ws?.send(JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'accountUnsubscribe', params: [id] }));
    }
    this.subIds.clear();
    this.ws?.close();
    this.ws = null;
  }

  /** One read of every target. Returns the events produced, for tests and for `--once`. */
  async tick(source: UpgradeEvent['source']): Promise<UpgradeEvent[]> {
    const events: UpgradeEvent[] = [];
    this.ticks++;
    this.lastTickAt = Date.now();
    for (const target of this.targets) {
      try {
        const ev = await this.observe(target, source);
        if (ev) events.push(ev);
        this.consecutiveFailures = 0;
      } catch (e) {
        // A budget stop must end the run; a transport blip must not kill the daemon.
        if (isDotError(e) && e.code.startsWith('BUDGET')) throw e;
        this.consecutiveFailures++;
        this.emit('error', e);
        if (this.consecutiveFailures === 20) {
          this.emit('degraded', {
            reason: '20 consecutive read failures — Dot is no longer observing these accounts',
            ...(describeError(e) as object),
          });
        }
      }
    }
    events.forEach((e) => this.emit('upgrade', e));
    this.eventsEmitted += events.length;
    return events;
  }

  private async observe(target: WatchTarget, source: UpgradeEvent['source']): Promise<UpgradeEvent | null> {
    const programData = deriveProgramData(target.program);
    const raw = await this.client.getRawAccountInfo(programData);
    const account = raw.account;
    if (raw.slot > this.lastReadSlot) this.lastReadSlot = raw.slot;
    const previous = this.state.get(target.program) ?? null;

    if (account === null) {
      const now: ObservedState = {
        programData,
        bytecodeHash: '',
        fullAccountHash: '',
        authority: null,
        bytecodeLen: 0,
        accountLen: 0,
        headerU64: 0,
        observedAt: Date.now(),
        closed: true,
      };
      // A ProgramData account can be closed by its authority: the program becomes
      // unupgradable and, if the Program account goes too, calls fail. This is an
      // event, not a gap in our data.
      const ev = previous && !previous.closed
        ? this.event('program_data_closed', target, programData, previous, now, source)
        : null;
      this.state.set(target.program, now);
      return ev;
    }

    const decoded = decodeProgramData(
      { address: programData, lamports: account.lamports, owner: account.owner, data: account.data },
      target.program,
    );
    const now = toObservedState(programData, decoded);
    const firstLook = previous === null;
    this.state.set(target.program, now);

    if (firstLook) {
      if (!this.opts.fireOnBaseline || source === 'baseline') return null;
      return this.event('upgrade', target, programData, null, now, source);
    }
    if (previous.closed) return this.event('program_data_reopened', target, programData, previous, now, source);

    const changed = {
      bytecode: previous.bytecodeHash !== now.bytecodeHash,
      authority: previous.authority !== now.authority,
      size: previous.bytecodeLen !== now.bytecodeLen || previous.accountLen !== now.accountLen,
    };
    if (!changed.bytecode && !changed.authority) return null;
    if (previous.fullAccountHash === now.fullAccountHash) return null;

    return this.event(changed.bytecode ? 'upgrade' : 'authority_change', target, programData, previous, now, source, changed);
  }

  private event(
    kind: UpgradeEvent['kind'],
    target: WatchTarget,
    programData: string,
    before: ObservedState | null,
    after: ObservedState | null,
    source: UpgradeEvent['source'],
    changed?: UpgradeEvent['changed'],
  ): UpgradeEvent {
    return {
      kind,
      program: target.program,
      ...(target.label ? { label: target.label } : {}),
      programData,
      before,
      after,
      changed: changed ?? { bytecode: kind === 'upgrade', authority: kind === 'authority_change', size: true },
      detectedAt: Date.now(),
      source,
    };
  }

  /**
   * `accountSubscribe` per target. There is no chain-wide "every ProgramData that
   * moved" subscription in core JSON-RPC, so watching the whole loader requires
   * either a Yellowstone gRPC `subscribe` on `owner = BPFLoaderUpgradeable` or a
   * provider-side transaction filter. See `src/limits.ts`.
   */
  private async connectWs(): Promise<void> {
    const wsUrl = this.client.transport.endpoint.replace(/^http/, 'ws');
    if (typeof WebSocket === 'undefined') {
      throw new DotError('RPC_TRANSPORT', 'this node build has no global WebSocket; run Node >= 22 or use --mode poll', {});
    }
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    ws.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.method === 'accountNotification') {
        const sub = msg.params?.subscription as number | undefined;
        const program = [...this.subIds.entries()].find(([, id]) => id === sub)?.[0];
        if (program) void this.refresh(program).catch((e) => this.emit('error', e));
      } else if (typeof msg.result === 'number' && typeof msg.id === 'number') {
        // subscribe reply: map request id -> subscription id
        const pending = this.pendingSubs.get(msg.id);
        if (pending) {
          this.subIds.set(pending, msg.result);
          this.pendingSubs.delete(msg.id);
        }
      }
    };
    ws.onopen = () => {
      for (const target of this.targets) {
        this.subscribe(target.program, ws);
      }
    };
    ws.onerror = (e) => this.emit('error', new DotError('RPC_TRANSPORT', `websocket error on ${wsUrl}`, { event: String(e?.type ?? 'unknown') }));
    ws.onclose = () => {
      this.subIds.clear();
      if (this.running) {
        this.emit('degraded', { reason: 'websocket closed; relying on resync polls' });
        setTimeout(() => void this.connectWs().catch((e) => this.emit('error', e)), 5_000);
      }
    };
  }

  private pendingSubs = new Map<number, string>();
  private reqId = 10_000;

  private subscribe(program: string, ws: WebSocket): void {
    const id = ++this.reqId;
    this.pendingSubs.set(id, program);
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'accountSubscribe',
        params: [
          deriveProgramData(program),
          { encoding: 'base64', commitment: 'finalized' },
        ],
      }),
    );
  }

  private async refresh(program: string): Promise<void> {
    const target = this.targets.find((t) => t.program === program);
    if (!target) return;
    const ev = await this.observe(target, 'ws');
    if (ev) this.emit('upgrade', ev);
  }
}

function toObservedState(programData: string, d: ProgramDataState): ObservedState {
  return {
    programData,
    bytecodeHash: d.bytecodeHash,
    fullAccountHash: d.fullAccountHash,
    authority: d.authority,
    bytecodeLen: d.bytecodeLen,
    accountLen: d.accountLen,
    headerU64: d.headerU64,
    observedAt: Date.now(),
    closed: false,
  };
}

/** Cross-check the PDA derivation against the Program account's own pointer. */
export async function verifyProgramPointer(client: SolanaClient, program: string): Promise<{ ok: boolean; pointer: string | null; derived: string }> {
  const derived = deriveProgramData(program);
  const acct = await client.getAccountInfo(program);
  if (!acct) return { ok: false, pointer: null, derived };
  const pointer = readProgramPointer(acct.data);
  return { ok: pointer === derived, pointer, derived };
}

#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import { Budget, type BudgetLimits } from '../agent/budget.js';
import { EvidenceLedger } from '../agent/evidence.js';
import { RuleBasedDecision } from '../agent/rules.js';
import type { UpgradeContext } from '../agent/decision.js';
import { advisoryToNarrative, RealLlmDecision, llmConfigFromEnv, narrateBlastRadius } from '../agent/llm.js';
import { Scout, type PriorDigest } from '../agent/scout.js';
import { HttpTransport } from '../rpc/transport.js';
import { SolanaClient } from '../rpc/client.js';
import { UpgradeWatcher, type WatchTarget, type UpgradeEvent } from '../watcher/watcher.js';
import { UpgradeDispatcher } from '../watcher/dispatcher.js';
import { ProgramIndex } from '../state/programIndex.js';
import { decodeProgramData, type ProgramDataState } from '../state/programdata.js';
import { BPF_LOADER_UPGRADEABLE } from '../ids.js';
import type { AccountUpdate } from '../rpc/yellowstone.js';
import type { ObservedState as ObservedStateLike } from '../watcher/watcher.js';
import { YellowstoneUpgradeFeed } from '../rpc/yellowstone.js';
import { StagedUpgradeDetector } from '../state/preDeploy.js';
import { ResilientClient } from '../rpc/resilient.js';
import { BlockBatcher, loadCostModel, UNVERIFIED_DEFAULTS, type CostModel } from '../graph/batcher.js';
import { renderReplay, replayTransaction } from '../commands/replay.js';
import { resolveIdl } from '../idl.js';
import { loadSeedFile, renderHoldings, sumHoldings } from '../state/seeds.js';
import { formatEscalation, renderMarkdown, type DotReport } from '../report.js';
import { BlastRadiusScanner, renderBlastRadius, loadProgramList, loadAuthorityMap } from '../commands/blastRadius.js';
import { LIMIT_NOTES } from '../limits.js';
import { LIMIT_STATUS, auditCoverage, countStates, renderLimitStatus, verifyTestClaims, type LimitState } from '../commands/limits.js';
import { TIER_MEANING } from '../score/risk.js';
import { isDotError } from '../errors.js';
import { isWellFormedPubkey } from '../ids.js';

const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';
const program = new Command();

/**
 * This tool's bin is `dot`, and `/usr/bin/dot` is graphviz — measured on this box,
 * where a linked `dot` was silently shadowed by it and `dot limits` produced
 * "can't open limits". The unambiguous aliases dispatch on the invoked name, so an
 * install that lands after graphviz on PATH still reaches the right program.
 */
const ALIAS_COMMANDS: Record<string, string> = {
  'dot-analyze': 'analyze',
  'dot-watch': 'watch',
  'dot-mcp': 'mcp',
  'dot-limits': 'limits',
  'dot-calibrate': 'calibrate',
};

const invokedAs = (process.argv[1] ?? '').split('/').pop() ?? '';
const alias = ALIAS_COMMANDS[invokedAs];
if (alias && process.argv[2] !== alias) {
  process.argv.splice(2, 0, alias);
}

type GlobalOpts = {
  rpc?: string;
  secondaryRpc?: string;
  ingest: string;
  costModel?: string;
  depth: string;
  solUsd?: string;
  mode: string;
  budgetRpc: string;
  budgetTokens: string;
  budgetWall: string;
  sample: string;
  unbounded: boolean;
  idl?: string;
  priorIdl?: string;
  tryOnchainIdl: boolean;
  multisig: string[];
  commitment: string;
  format: string;
  out?: string;
};

function parseBudgetFrom(limits: { maxRpcCalls: number; maxSignatures: number; maxLlmTokens: number; maxWallMs: number }, _o: GlobalOpts): Budget {
  return new Budget(limits);
}

function parseBudget(o: GlobalOpts): Budget {
  if (o.unbounded) return Budget.unlimited();
  return new Budget({
    maxRpcCalls: Number(o.budgetRpc),
    maxLlmTokens: Number(o.budgetTokens),
    maxWallMs: Number(o.budgetWall),
    maxSignatures: Number(o.sample),
  });
}

async function build(o: GlobalOpts) {
  void o.solUsd;
  const rpc = o.rpc ?? process.env.DOT_RPC_URL ?? DEFAULT_RPC;
  if (rpc === DEFAULT_RPC) {
    process.stderr.write(
      'note: using the public mainnet endpoint. History retention and rate limits are not under your control; see the SINGLE_NODE_TRUST limit note.\n',
    );
  }
  const transport = new HttpTransport(rpc);
  const budget = parseBudget(o);
  const client = new SolanaClient({ transport, budget, commitment: o.commitment as 'processed' | 'confirmed' | 'finalized' });
  const rules = new RuleBasedDecision({});
  const cfg = llmConfigFromEnv();
  const wantsReal = o.mode === 'real';
  if (wantsReal && !cfg) {
    process.stderr.write('warning: --mode real requested but DOT_LLM_API_KEY is unset; running the rule engine and saying so in the report.\n');
  }
  const decision = wantsReal && cfg ? new RealLlmDecision(cfg, rules, budget) : rules;
  const mode: 'rules' | 'real' = wantsReal && cfg ? 'real' : 'rules';

  const endpoints: Array<{ client: SolanaClient; url: string }> = [{ client, url: rpc }];
  if (o.secondaryRpc) {
    const secondTransport = new HttpTransport(o.secondaryRpc);
    endpoints.push({
      client: new SolanaClient({
        transport: secondTransport,
        // Its own budget: sharing one would make the reported call count a fiction.
        budget: new Budget({ ...budget.limits }),
        commitment: o.commitment as 'finalized',
      }),
      url: o.secondaryRpc,
    });
  } else {
    process.stderr.write(
      'note: no --secondary-rpc. Nothing here is corroborated; see SINGLE_NODE_TRUST.\n',
    );
  }
  const quorum = new ResilientClient(endpoints);
  const model = await loadCostModel(o.costModel);
  const batcher = o.ingest === 'signatures' ? undefined : new BlockBatcher(client, model, budget);

  const scout = new Scout({
    client,
    budget,
    decision,
    mode,
    knownMultisigs: o.multisig,
    maxDepth: Number(o.depth),
    idlResolver: (p) => resolveIdl(p, { idl: o.idl, priorIdl: o.priorIdl, tryOnchain: o.tryOnchainIdl }, client),
    ...(o.secondaryRpc ? { resilient: { quorum: (a: string) => quorum.getAccountInfoQuorum(a) } } : {}),
    ...(batcher ? { batcher, ingest: o.ingest as 'auto' | 'blocks' | 'signatures' } : {}),
  });
  return { client, budget, scout, mode };
}

program
  .name('dot')
  .description('Agentic Solana blast-radius analyzer for BPFLoaderUpgradeable upgrades.')
  .version('0.1.0');

program
  .command('analyze')
  .argument('<program_id>', 'the program whose blast radius you want')
  .option('--rpc <url>', 'JSON-RPC endpoint (or DOT_RPC_URL)')
  .option('--mode <mode>', 'rules | real', 'rules')
  .option('--sample <n>', 'signatures to pull at most', '60')
  .option('--budget-rpc <n>', 'max RPC calls', '250')
  .option('--budget-tokens <n>', 'max LLM tokens', '20000')
  .option('--budget-wall <ms>', 'max wall clock', '120000')
  .option('--unbounded', 'remove the ceilings (not recommended: this is the script mode Dot is arguing against)')
  .option('--idl <path|url>', 'current interface definition')
  .option('--prior-idl <path|url>', 'the same interface before the upgrade')
  .option('--try-onchain-idl', 'attempt the legacy anchor:idl PDA read')
  .option('--multisig <authority>', 'declare an authority you know to be a multisig (repeatable)', collect, [])
  .option('--force-full-trace', 'ignore the early-exit rule and pull traces anyway')
  .option('--commitment <c>', 'processed | confirmed | finalized', 'finalized')
  .option('--secondary-rpc <url>', 'second endpoint; the upgrade hash is read from both and a same-slot contradiction halts the run')
  .option('--ingest <mode>', 'auto | blocks | signatures (block batching trades RPC calls for bandwidth)', 'auto')
  .option('--cost-model <file>', 'calibration JSON from `dot calibrate`')
  .option('--depth <n>', 'transitive dependent hops to report', '3')
  .option('--sol-usd <price>', 'operator-supplied SOL price; Dot has no price oracle and will not invent a USD figure')
  .option('--seeds <file>', 'JSON list of {program_id, seed_template, account_type} to sum custody from derived PDAs')
  .option('--label <label>', 'human name for reports')
  .option('--format <fmt>', 'json | md | both', 'both')
  .option('--out <dir>', 'write report files into this directory instead of stdout')
  .action(async (programId: string, opts: GlobalOpts & { label?: string; forceFullTrace?: boolean; seeds?: string }) => {
    if (!isWellFormedPubkey(programId)) {
      process.stderr.write(`error: ${programId} is not a 32-byte base58 address\n`);
      process.exitCode = 2;
      return;
    }
    const { client, scout, budget } = await build(opts);
    let report: DotReport;
    try {
      report = await scout.run({
        program: programId,
        ...(opts.label ? { label: opts.label } : {}),
        ...(opts.forceFullTrace ? { forceFullTrace: true } : {}),
      });
    } catch (e) {
      if (isDotError(e)) {
        process.stderr.write(`stopped: ${e.code} — ${e.message}\n`);
        process.stderr.write(`budget at stop: ${JSON.stringify(budget.snapshot().spent)}\n`);
        process.exitCode = 3;
        return;
      }
      throw e;
    }
    if (opts.seeds) {
      const specs = await loadSeedFile(opts.seeds);
      const holdings = await sumHoldings(client, specs);
      report.holdings = { ...holdings, observedTokenRaw: Object.fromEntries([...holdings.observedTokenRaw].map(([k, v]) => [k, v.toString()])), source: opts.seeds };
      process.stdout.write(`${renderHoldings(programId, holdings)}\n`);
    }
    await emit(report, opts);
    const escalation = formatEscalation(report);
    if (escalation) {
      // Exit 4 is "the agent asked for resources", distinct from 3 ("a stop was
      // reached") and 1 ("it broke"). A wrapper script can branch on it and a human
      // reading the terminal gets the number to raise.
      process.stderr.write(`${escalation}\n`);
      process.exitCode = 4;
    }
  });

program
  .command('watch')
  .description('watch ProgramData accounts for upgrades and analyze each one within budget')
  .requiredOption('--targets <file>', 'JSON array of { program, label?, knownMultisigs? }')
  .option('--rpc <url>', 'JSON-RPC endpoint (or DOT_RPC_URL)')
  .option('--mode <mode>', 'rules | real', 'rules')
  .option('--interval <ms>', 'poll interval', '30000')
  .option('--transport <t>', 'poll | ws', 'poll')
  .option('--once', 'single tick, then exit (cron-friendly)')
  .option('--fire-on-baseline', 'emit an event for the first observation of each target')
  .option('--sample <n>', 'signatures to pull per upgrade', '60')
  .option('--budget-rpc <n>', 'max RPC calls per upgrade analysis', '250')
  .option('--budget-tokens <n>', 'max LLM tokens per analysis', '20000')
  .option('--budget-wall <ms>', 'max wall clock per analysis', '120000')
  .option('--unbounded', 'remove the ceilings')
  .option('--idl <path|url>', 'current interface definition')
  .option('--prior-idl <path|url>', 'previous interface definition')
  .option('--try-onchain-idl', 'attempt the legacy anchor:idl PDA read')
  .option('--multisig <authority>', 'declare a known multisig (repeatable)', collect, [])
  .option('--commitment <c>', 'processed | confirmed | finalized', 'finalized')
  .option('--format <fmt>', 'json | md | both', 'both')
  .option('--out <dir>', 'write report files into this directory')
  .option('--state <file>', 'persist prior digests here so repeated runs get real Decide inputs')
  .option('--status-file <file>', 'write the daemon cursor/status so `dot_watch_status` can read it')
  .option('--yellowstone <url>', 'chain-wide feed from a Yellowstone/Geyser endpoint instead of polling the target list')
  .option('--yellowstone-token <token>', 'auth token for the gRPC endpoint (or DOT_YELLOWSTONE_TOKEN); never echoed')
  .option('--authority <pubkey>', 'server-side filter to one upgrade authority (memcmp at the measured offset)')
  .option('--timelock-ms <ms>', 'declare a governance delay; Dot cannot read one off chain and will not invent one')
  .option('--per-event-rpc <n>', 'max RPC calls for any single upgrade investigation', '50')
  .option('--daily-rpc <n>', 'max RPC calls the daemon may spend before it starts dropping events', '5000')
  .action(async (opts: GlobalOpts & { targets: string; interval: string; transport: string; once?: boolean; fireOnBaseline?: boolean; state?: string; statusFile?: string; yellowstone?: string; yellowstoneToken?: string; authority?: string; timelockMs?: string; perEventRpc: string; dailyRpc: string }) => {
    const targets: WatchTarget[] = JSON.parse(await readFile(opts.targets, 'utf8'));
    if (!Array.isArray(targets) || targets.length === 0) {
      process.stderr.write('error: targets file must be a non-empty JSON array\n');
      process.exitCode = 2;
      return;
    }
    const bad = targets.filter((t) => !isWellFormedPubkey(t.program));
    if (bad.length > 0) {
      process.stderr.write(`error: ${bad.length} target(s) are not 32-byte base58 addresses\n`);
      process.exitCode = 2;
      return;
    }

    const { client, mode } = await build(opts);
    const daemonBudget = new Budget({ maxRpcCalls: Number.MAX_SAFE_INTEGER, maxLlmTokens: Number.MAX_SAFE_INTEGER, maxWallMs: Number.MAX_SAFE_INTEGER, maxSignatures: Number.MAX_SAFE_INTEGER });
    const daemonClient = new SolanaClient({ transport: client.transport, budget: daemonBudget, commitment: opts.commitment as 'finalized' });
    const prior = new Map<string, PriorDigest>();
    if (opts.state) {
      try {
        const loaded = JSON.parse(await readFile(opts.state, 'utf8')) as Record<string, PriorDigest>;
        for (const [k, v] of Object.entries(loaded)) prior.set(k, v);
      } catch {
        process.stderr.write('note: state file unreadable; starting with no prior graph (Decide will treat dependents as unobserved)\n');
      }
    }

    const watcher = new UpgradeWatcher(daemonClient, targets, {
      mode: opts.transport as 'poll' | 'ws',
      intervalMs: Number(opts.interval),
      ...(opts.fireOnBaseline ? { fireOnBaseline: true } : {}),
    });

    const secondary = opts.secondaryRpc;
    const costModel = await loadCostModel(opts.costModel);
    // ---- Chain-wide mode. The target list becomes a fallback, not the design.
    if (opts.yellowstone) {
      const index = new ProgramIndex(daemonClient, daemonBudget);
      const stagedDetector = new StagedUpgradeDetector({
        declaredDelayMs: opts.timelockMs ? Number(opts.timelockMs) : null,
      });
      const lastSeen = new Map<string, ObservedStateLike>();
      let unresolved = 0;
      let decoded = 0;

      const analyzeWith = async (event: UpgradeEvent, limits: BudgetLimits) => {
        const perUpgrade = parseBudgetFrom(limits, opts);
        const rules = new RuleBasedDecision({});
        const cfg = llmConfigFromEnv();
        const useReal = opts.mode === 'real' && Boolean(cfg);
        const analysisClient = new SolanaClient({
          transport: client.transport,
          budget: perUpgrade,
          commitment: opts.commitment as 'finalized',
        });
        const analysisScout = new Scout({
          client: analysisClient,
          budget: perUpgrade,
          decision: useReal && cfg ? new RealLlmDecision(cfg, rules, perUpgrade) : rules,
          mode: useReal ? 'real' : 'rules',
          knownMultisigs: [...opts.multisig],
          idlResolver: (p) => resolveIdl(p, { idl: opts.idl, priorIdl: opts.priorIdl, tryOnchain: opts.tryOnchainIdl }, analysisClient),
          prior,
          maxDepth: Number(opts.depth),
          ...(secondary
            ? {
                resilient: {
                  quorum: (a: string) =>
                    new ResilientClient([
                      { client: analysisClient, url: opts.rpc ?? DEFAULT_RPC },
                      {
                        client: new SolanaClient({
                          transport: new HttpTransport(secondary),
                          budget: new Budget({ ...perUpgrade.limits }),
                          commitment: 'finalized',
                        }),
                        url: secondary,
                      },
                    ]).getAccountInfoQuorum(a),
                },
              }
            : {}),
        });
        const rep = await analysisScout.run({ program: event.program, event });
        prior.set(event.program, {
          at: Date.now(),
          knownDependents: rep.blastRadius?.directCallers ?? 0,
          lamportsRouted: rep.blastRadius?.lamportsRouted ?? 0,
          tier: rep.tier,
        });
        if (opts.state) await writeFile(opts.state, JSON.stringify(priorToObj(prior), null, 2));
        process.stdout.write(
          `${rep.tier}${rep.tierSource === 'integrity' ? ' [integrity]' : ''} score=${rep.score} conf=${rep.confidence} stopped=${rep.stoppedAt} rpc=${rep.budget.spent.rpcCalls} deps=${rep.blastRadius?.directCallers ?? 'n/a'} ${rep.program}\n`,
        );
        await emit(rep, opts);
        return { program: event.program, tier: rep.tier, stoppedAt: rep.stoppedAt, rpcCalls: rep.budget.spent.rpcCalls };
      };

      const dispatcher = new UpgradeDispatcher(
        (event, limits) => analyzeWith(event, limits),
        { maxPerEvent: Number(opts.perEventRpc), dailyRpcTotal: Number(opts.dailyRpc) },
      );

      const feed = new YellowstoneUpgradeFeed({
        endpoint: opts.yellowstone,
        ...(opts.yellowstoneToken ? { xToken: opts.yellowstoneToken } : process.env.DOT_YELLOWSTONE_TOKEN ? { xToken: process.env.DOT_YELLOWSTONE_TOKEN } : {}),
        commitment: 'finalized',
        ...(opts.authority ? { authorityPubkey: opts.authority } : {}),
      });
      feed.on('pointer', (p: { programData: string; program: string }) => index.observePointer(p.programData, p.program));
      feed.on('buffer', (u: AccountUpdate) => {
        // A Buffer write is the only moment before a change is live that an operator
        // can still react. Dot reports that an image exists; it does not claim to know
        // what the image does.
        const ev = stagedDetector.observeStaged(u);
        if (ev === null) {
          process.stdout.write(`STAGED-NOOP ${u.address} slot=${u.slot} (staged image is byte-identical to what is live)\n`);
          return;
        }
        const eta = ev.finalizeEta;
        process.stdout.write(
          `STAGED_UPGRADE buffer=${u.address} slot=${u.slot} image=${ev.staged.bytecodeLen}B ` +
            `sha256=${ev.staged.bytecodeHash.slice(0, 16)}… authority=${ev.staged.authority ?? 'none'} ` +
            `program=${ev.program ?? 'UNATTRIBUTED'} eta=${eta.status}${eta.delayMs !== null ? ` (${eta.delayMs}ms)` : ''}\n`,
        );
      });
      feed.on('account', async (u: AccountUpdate) => {
        const resolved = await index.resolve(u.address, u.txnSignature);
        if (!resolved.program) {
          unresolved++;
          process.stderr.write(`unresolved ProgramData ${u.address} (${resolved.how}); dropped with a count, not silently\n`);
          return;
        }
        let state;
        try {
          state = decodeProgramData({ address: u.address, lamports: Number(u.lamports), owner: BPF_LOADER_UPGRADEABLE, data: u.data }, resolved.program);
        } catch (e) {
          process.stderr.write(`layout refusal for ${resolved.program}: ${(e as Error).message}\n`);
          return;
        }
        decoded++;
        stagedDetector.observeDeployed(u.address, state.bytecodeHash, state.bytecodeLen);
        const attributed = stagedDetector.attributeByLanding(state.bytecodeHash, resolved.program);
        if (attributed) {
          process.stdout.write(
            `LANDED staged buffer=${attributed.bufferAddress} -> program=${resolved.program} ` +
              `(attribution by bytecode-hash match; the Buffer account itself names no program)\n`,
          );
        }
        const before = lastSeen.get(u.address) ?? null;
        const now: ObservedStateLike = {
          programData: u.address,
          bytecodeHash: state.bytecodeHash,
          fullAccountHash: state.fullAccountHash,
          authority: state.authority,
          bytecodeLen: state.bytecodeLen,
          accountLen: state.accountLen,
          headerU64: state.headerU64,
          observedAt: Date.now(),
          closed: false,
        };
        lastSeen.set(u.address, now);
        if (!before) {
          // A Geyser write notification with no prior observation is still an
          // upgrade signal (the account moved), but Dot cannot say what moved.
          dispatcher.offer({
            kind: 'upgrade',
            program: resolved.program,
            programData: u.address,
            before: null,
            after: now,
            changed: { bytecode: true, authority: false, size: false },
            detectedAt: Date.now(),
            source: 'ws',
          });
          return;
        }
        if (before.fullAccountHash === now.fullAccountHash) return;
        const kind = before.bytecodeHash !== now.bytecodeHash ? 'upgrade' : before.authority !== now.authority ? 'authority_change' : 'upgrade';
        dispatcher.offer({
          kind,
          program: resolved.program,
          programData: u.address,
          before,
          after: now,
          changed: {
            bytecode: before.bytecodeHash !== now.bytecodeHash,
            authority: before.authority !== now.authority,
            size: before.bytecodeLen !== now.bytecodeLen,
          },
          detectedAt: Date.now(),
          source: 'ws',
        });
      });
      feed.on('error', (e: Error) => process.stderr.write(`yellowstone: ${e.message}\n`));
      feed.on('degraded', (d: unknown) => process.stderr.write(`DEGRADED ${JSON.stringify(d)}\n`));

      await feed.start();
      process.stderr.write(
        `chain-wide feed active: ${opts.yellowstone}${opts.authority ? ` authority-filtered ${opts.authority}` : ''}; ` +
          `per-event cap ${opts.perEventRpc} RPC, daily pool ${opts.dailyRpc}. Poll mode disabled.\n`,
      );
      const shutdown = () => {
        feed.stop();
        process.stderr.write(`feed stats ${JSON.stringify(feed.statsView())} unresolved=${unresolved} decoded=${decoded} dispatch ${JSON.stringify(dispatcher.stats())}\n`);
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      return;
    }

    const runFor = async (eventName: string, event?: UpgradeEvent) => {
      const perUpgrade = parseBudget(opts);
      const rules = new RuleBasedDecision({});
      const cfg = llmConfigFromEnv();
      const useReal = opts.mode === 'real' && cfg;
      const decision = useReal && cfg ? new RealLlmDecision(cfg, rules, perUpgrade) : rules;
      const perEventClient = new SolanaClient({ transport: client.transport, budget: perUpgrade, commitment: opts.commitment as 'finalized' });
      const analysisScout = new Scout({
        client: perEventClient,
        budget: perUpgrade,
        decision,
        mode: useReal ? 'real' : 'rules',
        knownMultisigs: [...opts.multisig, ...(event ? (targets.find((t) => t.program === event.program)?.knownMultisigs ?? []) : [])],
        idlResolver: (p) => resolveIdl(p, { idl: opts.idl, priorIdl: opts.priorIdl, tryOnchain: opts.tryOnchainIdl }, daemonClient),
        prior,
        maxDepth: Number(opts.depth),
        ...(perUpgrade.limits.maxRpcCalls > 20 && opts.ingest !== 'signatures'
          ? { batcher: new BlockBatcher(perEventClient, costModel, perUpgrade), ingest: opts.ingest as 'auto' | 'blocks' | 'signatures' }
          : {}),
        ...(secondary
          ? {
              resilient: {
                quorum: (a: string) =>
                  new ResilientClient([
                    { client: perEventClient, url: opts.rpc ?? DEFAULT_RPC },
                    {
                      client: new SolanaClient({ transport: new HttpTransport(secondary), budget: new Budget({ ...perUpgrade.limits }), commitment: 'finalized' }),
                      url: secondary,
                    },
                  ]).getAccountInfoQuorum(a),
              },
            }
          : {}),
        ...(useReal && cfg
          ? {
              narrate: async (ctx: UpgradeContext, graph: Parameters<typeof narrateBlastRadius>[4], led: EvidenceLedger) =>
                advisoryToNarrative(await narrateBlastRadius(cfg, perUpgrade, led, ctx, graph)),
            }
          : {}),
      });
      const rep = await analysisScout.run({
        program: event!.program,
        ...(targets.find((t) => t.program === event!.program)?.label ? { label: targets.find((t) => t.program === event!.program)!.label } : {}),
        event,
      });
      prior.set(event!.program, {
        at: Date.now(),
        knownDependents: rep.blastRadius?.directCallers ?? 0,
        lamportsRouted: rep.blastRadius?.lamportsRouted ?? 0,
        tier: rep.tier,
      });
      if (opts.state) await writeFile(opts.state, JSON.stringify(priorToObj(prior), null, 2));
      process.stdout.write(
        `${eventName} ${rep.tier} (score ${rep.score}, ${rep.confidence}) ${rep.label ?? rep.program} — stopped at ${rep.stoppedAt}, ${rep.budget.spent.rpcCalls} RPC, ${rep.blastRadius?.directCallers ?? 'n/a'} dependents\n`,
      );
      await emit(rep, opts);
    };

    watcher.on('upgrade', (event) => {
      void runFor('upgrade', event).catch((e) => process.stderr.write(`analysis failed for ${event.program}: ${(e as Error).message}\n`));
    });
    watcher.on('error', (e) => process.stderr.write(`watch: ${(e as Error).message}\n`));
    watcher.on('degraded', (d) => process.stderr.write(`watch DEGRADED: ${JSON.stringify(d)}\n`));

    const writeStatus = () => {
      if (!opts.statusFile) return;
      const payload = {
        network: opts.rpc ?? process.env.DOT_RPC_URL ?? DEFAULT_RPC,
        writtenAt: Date.now(),
        watcher: { ...watcher.status(), network: 'mainnet' },
        ...(feedStatsForStatus ? { feed: feedStatsForStatus } : {}),
        mode,
      };
      void writeFile(opts.statusFile, JSON.stringify(payload, null, 2)).catch((e) =>
        process.stderr.write(`status file write failed: ${(e as Error).message}\n`),
      );
    };
    let feedStatsForStatus: unknown = null;

    if (opts.once) {
      const events = await watcher.tick('poll');
      writeStatus();
      for (const ev of events) await runFor('upgrade', ev);
      if (events.length === 0) process.stdout.write(`no changes across ${targets.length} target(s)\n`);
      watcher.stop();
      return;
    }

    await watcher.start();
    writeStatus();
    setInterval(writeStatus, Math.max(5_000, Number(opts.interval))).unref?.();
    process.stderr.write(`watching ${targets.length} target(s) via ${opts.transport} every ${opts.interval}ms (mode ${mode === 'real' ? 'real' : 'rules'})\n`);
    const shutdown = () => {
      watcher.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program
  .command('replay')
  .description('run the real parser over a captured getTransaction JSON, offline')
  .requiredOption('--fixture <file>', 'a saved getTransaction response (jsonParsed)')
  .requiredOption('--target <program_id>', 'the program to treat as the graph centre')
  .option('--provenance <note>', 'where the capture came from; printed with every number')
  .option('--format <fmt>', 'md | json', 'md')
  .action(async (opts: { fixture: string; target: string; provenance?: string; format: string }) => {
    const result = await replayTransaction(opts.fixture, opts.target, opts.provenance);
    process.stdout.write(opts.format === 'json' ? `${JSON.stringify(result, null, 2)}\n` : `${renderReplay(result)}\n`);
  });

program
  .command('calibrate')
  .description('measure the block/transaction sizes your endpoint actually serves, and write a cost model Dot will trust')
  .option('--rpc <url>', 'JSON-RPC endpoint (or DOT_RPC_URL)')
  .option('--out <file>', 'where to write the calibration', 'dot-cost-model.json')
  .option('--blocks <n>', 'how many produced blocks to sample', '3')
  .option('--commitment <c>', 'processed | confirmed | finalized', 'finalized')
  .action(async (opts: { rpc?: string; out: string; blocks: string; commitment: string }) => {
    const url = opts.rpc ?? process.env.DOT_RPC_URL ?? DEFAULT_RPC;
    const budget = new Budget({ maxRpcCalls: 60, maxSignatures: 60, maxLlmTokens: 0, maxWallMs: 180_000 });
    const transport = new HttpTransport(url);
    const client = new SolanaClient({ transport, budget, commitment: opts.commitment as 'finalized' });
    const slot = await client.getSlot();
    const blockCounts: number[] = [];
    let sampledSlots = 0;
    for (let probe = slot; probe > slot - 20 && blockCounts.length < Number(opts.blocks); probe--) {
      const b = await client.getBlock(probe, { transactionDetails: 'signatures' }).catch(() => null);
      if (!b) continue;
      sampledSlots++;
      blockCounts.push((b.signatures ?? []).length);
    }
    const avgTxnBytes = await measureTxnBytes(client);
    if (blockCounts.length === 0) {
      process.stderr.write('calibration FAILED: no produced block could be read. Nothing written; Dot will keep using labelled defaults.\n');
      process.exitCode = 4;
      return;
    }
    const avgBlockTransactions = Math.round(blockCounts.reduce((a, b) => a + b, 0) / blockCounts.length);
    const model = {
      avgBlockTransactions,
      avgTxnBytes: avgTxnBytes ?? UNVERIFIED_DEFAULTS.avgTxnBytes,
      maxBlockBytes: 32_000_000,
      densityFloor: UNVERIFIED_DEFAULTS.densityFloor,
      source: opts.out,
      measuredAt: Date.now(),
      note: `avgTxnBytes ${avgTxnBytes === null ? 'NOT MEASURED (kept default)' : 'measured'}; blocks sampled ${blockCounts.length}/${sampledSlots} at ${new URL(url).host}`,
    };
    await writeFile(opts.out, JSON.stringify(model, null, 2));
    process.stdout.write(`${JSON.stringify(model, null, 2)}\nwrote ${opts.out}\n`);
  });

program
  .command('blast-radius')
  .description('ecosystem query: which upgrades in a window deserve a human, and who to notify')
  .option('--rpc <url>', 'JSON-RPC endpoint (or DOT_RPC_URL)')
  .option('--since <date>', 'ISO date; bounded by node retention and reported as such')
  .option('--min-value <lamports>', 'ignore upgrades below this attributed value', '0')
  .option('--min-dependents <n>', 'ignore upgrades with fewer dependents than this', '0')
  .option('--programs <file>', 'restrict to a JSON array of program ids instead of discovering')
  .option('--max-records <n>', 'loader transactions to examine', '40')
  .option('--per-program-rpc <n>', 'RPC calls each program analysis may spend', '40')
  .option('--daily-rpc <n>', 'total ceiling for the whole query', '1200')
  .option('--authority-map <file>', 'JSON {authority: {label} or {m,n}}; threshold structure is not readable from chain data')
  .option('--sol-usd <price>', 'operator-supplied price; no oracle, no invented USD')
  .option('--seeds <file>', 'JSON seed list; custody summed from derived PDAs for whatever it covers')
  .option('--depth <n>', 'transitive hops', '2')
  .option('--format <fmt>', 'json | md | both', 'both')
  .option('--out <dir>', 'write report files here')
  .action(async (opts: { since?: string; minValue: string; minDependents: string; programs?: string; maxRecords: string; perProgramRpc: string; dailyRpc: string; authorityMap?: string; solUsd?: string; seeds?: string; depth: string; format: string; out?: string; rpc?: string; commitment?: string }) => {
    const o = opts as GlobalOpts & typeof opts;
    const { client } = await build({ ...o, commitment: o.commitment ?? 'finalized', sample: o.perProgramRpc });
    const spent = { total: 0 };
    const analyze: (program: string) => Promise<any> = async (program) => {
      const remaining = Number(opts.dailyRpc) - spent.total;
      if (remaining < 8) throw new Error(`fair-share pool exhausted after ${spent.total} call(s)`);
      const perProgram = new Budget({
        maxRpcCalls: Math.min(Number(opts.perProgramRpc), remaining),
        maxSignatures: Math.min(Number(opts.perProgramRpc), remaining),
        maxLlmTokens: 0,
        maxWallMs: 120_000,
      });
      const transport = new HttpTransport(opts.rpc ?? process.env.DOT_RPC_URL ?? DEFAULT_RPC);
      const perClient = new SolanaClient({ transport, budget: perProgram, commitment: 'finalized' });
      const rep = await new Scout({
        client: perClient,
        budget: perProgram,
        decision: new RuleBasedDecision({}),
        mode: 'rules',
        maxDepth: Number(opts.depth),
        ingest: 'signatures',
      }).run({ program, forceFullTrace: true });
      spent.total += rep.budget.spent.rpcCalls;
      const deps = (rep.graph?.detailedEdges ?? [])
        .filter((e) => e.to === program)
        .slice(0, 8)
        .map((e) => ({ program: e.from, authority: null as string | null, lamportsRouted: e.lamportsRouted }));
      // The posture line is the only place Dot records the authority; parsing it back
      // out is fragile, so keep the fragile part in one place and name it.
      const posture = rep.evidence.find((e) => e.kind === 'posture')?.summary ?? '';
      const authority = posture.match(/authority=(\S+)\s/)?.[1] ?? null;
      return {
        dependents: rep.blastRadius?.directCallers ?? 0,
        transitiveDependents: rep.blastRadius?.transitiveCallers ?? 0,
        lamportsRouted: rep.blastRadius?.lamportsRouted ?? 0,
        mintsTouched: rep.blastRadius?.mintsTouched ?? 0,
        authority: authority === 'RENOUNCED' ? null : authority,
        detail: { dependents: deps, stoppedAt: rep.stoppedAt, attribution: rep.blastRadius?.attributionQuality ?? null },
      };
    };
    const scanner = new BlastRadiusScanner(client, analyze);
    const since = opts.since ? Math.floor(new Date(opts.since).getTime() / 1000) : null;
    if (opts.since && Number.isNaN(since)) {
      process.stderr.write(`error: --since "${opts.since}" is not a parseable date\n`);
      process.exitCode = 2;
      return;
    }
    const authorityMap = opts.authorityMap ? await loadAuthorityMap(opts.authorityMap) : undefined;
    const programs = opts.programs ? await loadProgramList(opts.programs) : undefined;
    const result = await scanner.run({
      maxRecords: Number(opts.maxRecords),
      minValueLamports: Number(opts.minValue),
      minDependents: Number(opts.minDependents),
      ...(since ? { since } : {}),
      ...(programs ? { programs } : {}),
      ...(authorityMap ? { authorityMap } : {}),
      solUsd: opts.solUsd ? Number(opts.solUsd) : null,
    });
    const md = renderBlastRadius(result);
    if (opts.format === 'json') process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else if (opts.out) {
      const base = `${opts.out}/blast-radius-${new Date().toISOString().slice(0, 10)}`;
      await writeFile(`${base}.json`, JSON.stringify(result, null, 2));
      await writeFile(`${base}.md`, md);
      process.stdout.write(`wrote ${base}.json and ${base}.md\n`);
    } else {
      process.stdout.write(`${md}\n${JSON.stringify({ programs: result.ranked.length, ranked: result.ranked.map((r) => r.program), spent: spent.total })}\n`);
    }
  });

program
  .command('limits')
  .description('print what Dot cannot see, as data')
  .option('--status', 'three-state view: RESOLVED / NARROWED / UNRESOLVABLE_IN_CODE, with the test behind each claim')
  .option('--state <state>', 'with --status: filter to one state', undefined)
  .option('--format <fmt>', 'with --status: md | json', 'md')
  .action(async (opts: { status?: boolean; state?: string; format: string }) => {
    if (opts.status) {
      const verification = await verifyTestClaims(process.cwd());
      if (opts.format === 'json') {
        process.stdout.write(`${JSON.stringify({ counts: countStates(), coverage: auditCoverage(), verification, status: LIMIT_STATUS }, null, 2)}\n`);
        if (!verification.ok) process.exitCode = 5;
        return;
      }
      process.stdout.write(renderLimitStatus(opts.state ? { state: opts.state as LimitState } : {}));
      process.stdout.write(`RESOLVED claims verified against existing test files: ${verification.ok ? 'yes' : 'NO'}\n`);
      for (const p of verification.problems) process.stdout.write(`  problem: ${p}\n`);
      // A RESOLVED label with a missing test is not a resolved limit; exit nonzero so
      // a CI run cannot print a green table over a broken claim.
      if (!verification.ok) process.exitCode = 5;
      return;
    }
    for (const l of LIMIT_NOTES) {
      process.stdout.write(`${l.code}  (${l.always ? 'always' : 'when triggered'})\n  ${l.title}\n  blind: ${l.blind}\n  out:   ${l.mitigation}\n\n`);
    }
    for (const [tier, meaning] of Object.entries(TIER_MEANING)) process.stdout.write(`${tier}: ${meaning}\n`);
  });

program
  .command('mcp')
  .description('serve the Dot tools over MCP stdio')
  .option('--rpc <url>', 'JSON-RPC endpoint (or DOT_RPC_URL)')
  .option('--mode <mode>', 'rules | real', 'rules')
  .action(async (opts: { rpc?: string; mode: string }) => {
    const { startMcpServer } = await import('../mcp/server.js');
    await startMcpServer({ ...(opts.rpc ? { rpc: opts.rpc } : {}), mode: opts.mode });
  });

async function measureTxnBytes(client: SolanaClient): Promise<number | null> {
  const sigs = await client
    .getSignaturesForAddress('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', { limit: 8 })
    .catch(() => []);
  const sizes: number[] = [];
  for (const sig of sigs.slice(0, 8)) {
    client.resetByteCounter();
    const res = await client.getTransaction(sig.signature);
    if (res.status === 'found') sizes.push(client.statsView().bytes);
  }
  if (sizes.length === 0) return null;
  return Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length);
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function priorToObj(m: Map<string, PriorDigest>): Record<string, PriorDigest> {
  return Object.fromEntries(m.entries());
}

async function emit(report: DotReport, opts: { format: string; out?: string }): Promise<void> {
  const wantJson = opts.format === 'json' || opts.format === 'both';
  const wantMd = opts.format === 'md' || opts.format === 'both';
  if (opts.out) {
    const base = `${opts.out}/${report.program.slice(0, 8)}-${report.generatedAt.replace(/[:.]/g, '-')}`;
    if (wantJson) await writeFile(`${base}.json`, JSON.stringify(report, null, 2));
    if (wantMd) await writeFile(`${base}.md`, renderMarkdown(report));
    process.stdout.write(`wrote ${wantJson ? `${base}.json ` : ''}${wantMd ? `${base}.md` : ''}\n`);
    return;
  }
  if (wantJson && opts.format === 'json') process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else if (wantMd) process.stdout.write(`${renderMarkdown(report)}\n`);
  if (opts.format === 'both') process.stdout.write(`${JSON.stringify({ tier: report.tier, score: report.score, stoppedAt: report.stoppedAt, rpcCalls: report.budget.spent.rpcCalls })}\n`);
}

program.parseAsync(process.argv).catch((e) => {
  process.stderr.write(`fatal: ${(e as Error).message}\n`);
  process.exitCode = 1;
});

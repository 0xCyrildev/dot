#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import { Budget } from '../agent/budget.js';
import { EvidenceLedger } from '../agent/evidence.js';
import { RuleBasedDecision } from '../agent/rules.js';
import { RealLlmDecision, llmConfigFromEnv, narrateIdlDiff } from '../agent/llm.js';
import { Scout, type PriorDigest } from '../agent/scout.js';
import { HttpTransport } from '../rpc/transport.js';
import { SolanaClient } from '../rpc/client.js';
import { UpgradeWatcher, type WatchTarget, type UpgradeEvent } from '../watcher/watcher.js';
import { resolveIdl } from '../idl.js';
import { renderMarkdown, type DotReport } from '../report.js';
import { LIMIT_NOTES } from '../limits.js';
import { TIER_MEANING } from '../score/risk.js';
import { isDotError } from '../errors.js';
import { isWellFormedPubkey } from '../ids.js';

const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';
const program = new Command();

type GlobalOpts = {
  rpc?: string;
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

  const scout = new Scout({
    client,
    budget,
    decision,
    mode,
    knownMultisigs: o.multisig,
    idlResolver: (p) => resolveIdl(p, { idl: o.idl, priorIdl: o.priorIdl, tryOnchain: o.tryOnchainIdl }, client),
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
  .option('--label <label>', 'human name for reports')
  .option('--format <fmt>', 'json | md | both', 'both')
  .option('--out <dir>', 'write report files into this directory instead of stdout')
  .action(async (programId: string, opts: GlobalOpts & { label?: string; forceFullTrace?: boolean }) => {
    if (!isWellFormedPubkey(programId)) {
      process.stderr.write(`error: ${programId} is not a 32-byte base58 address\n`);
      process.exitCode = 2;
      return;
    }
    const { scout, budget } = await build(opts);
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
    await emit(report, opts);
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
  .action(async (opts: GlobalOpts & { targets: string; interval: string; transport: string; once?: boolean; fireOnBaseline?: boolean; state?: string }) => {
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

    const runFor = async (eventName: string, event?: UpgradeEvent) => {
      const perUpgrade = parseBudget(opts);
      const rules = new RuleBasedDecision({});
      const cfg = llmConfigFromEnv();
      const useReal = opts.mode === 'real' && cfg;
      const decision = useReal && cfg ? new RealLlmDecision(cfg, rules, perUpgrade) : rules;
      const analysisScout = new Scout({
        client: new SolanaClient({ transport: client.transport, budget: perUpgrade, commitment: opts.commitment as 'finalized' }),
        budget: perUpgrade,
        decision,
        mode: useReal ? 'real' : 'rules',
        knownMultisigs: [...opts.multisig, ...(event ? (targets.find((t) => t.program === event.program)?.knownMultisigs ?? []) : [])],
        idlResolver: (p) => resolveIdl(p, { idl: opts.idl, priorIdl: opts.priorIdl, tryOnchain: opts.tryOnchainIdl }, daemonClient),
        prior,
        ...(useReal && cfg
          ? {
              narrate: async (ctx: Parameters<typeof narrateIdlDiff>[3], graph: string, led: EvidenceLedger) =>
                narrateIdlDiff(cfg, perUpgrade, led, ctx, graph),
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

    if (opts.once) {
      const events = await watcher.tick('poll');
      for (const ev of events) await runFor('upgrade', ev);
      if (events.length === 0) process.stdout.write(`no changes across ${targets.length} target(s)\n`);
      watcher.stop();
      return;
    }

    await watcher.start();
    process.stderr.write(`watching ${targets.length} target(s) via ${opts.transport} every ${opts.interval}ms (mode ${mode === 'real' ? 'real' : 'rules'})\n`);
    const shutdown = () => {
      watcher.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program
  .command('limits')
  .description('print what Dot cannot see, as data')
  .action(() => {
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

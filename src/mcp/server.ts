import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Budget } from '../agent/budget.js';
import { RuleBasedDecision } from '../agent/rules.js';
import { advisoryToNarrative, RealLlmDecision, llmConfigFromEnv, narrateBlastRadius } from '../agent/llm.js';
import { EvidenceLedger } from '../agent/evidence.js';
import type { UpgradeContext } from '../agent/decision.js';
import { Scout } from '../agent/scout.js';
import { HttpTransport } from '../rpc/transport.js';
import { SolanaClient } from '../rpc/client.js';
import { resolveIdl } from '../idl.js';
import { renderMarkdown, type DotReport } from '../report.js';
import { LIMIT_NOTES } from '../limits.js';
import { LIMIT_STATUS, auditCoverage, countStates, verifyTestClaims, type LimitState } from '../commands/limits.js';
import { isWellFormedPubkey } from '../ids.js';
import { isDotError } from '../errors.js';
import type { WatchStatus } from '../watcher/watcher.js';

const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';

export type McpOptions = { rpc?: string; mode?: string; statusFile?: string };

const toolSchema = z.object({
  program: z.string().min(32).max(44).describe('the program whose blast radius is being asked about'),
  budget: z
    .object({
      maxRpcCalls: z.number().int().min(1).max(2000).describe('hard ceiling on JSON-RPC round trips, retries included'),
      maxSignatures: z.number().int().min(1).max(1000).describe('hard ceiling on transactions pulled into the graph'),
      maxLlmTokens: z.number().int().min(0).max(200000).describe('hard ceiling on model spend for this call'),
      maxWallMs: z.number().int().min(1000).max(600000).describe('hard ceiling on wall clock for this call'),
    })
    .describe('Dot stops mid-analysis rather than exceed these'),
  commitment: z.enum(['processed', 'confirmed', 'finalized']).default('finalized'),
  idl: z.string().optional().describe('path or URL to the current interface definition'),
  priorIdl: z.string().optional().describe('path or URL to the pre-upgrade interface definition'),
  tryOnchainIdl: z.boolean().default(false).describe('best-effort legacy anchor:idl PDA read'),
  knownMultisigs: z
    .array(z.string().min(32).max(44))
    .default([])
    .describe('authorities the caller knows to be multisigs; RPC cannot establish this'),
  rpc: z.string().url().optional().describe('override the endpoint for this call'),
  forceFullTrace: z.boolean().default(false).describe('disable the early-exit rule'),
});

const eventSchema = z
  .object({
    kind: z.enum(['upgrade', 'authority_change', 'program_data_closed', 'program_data_reopened']),
    beforeBytes: z.number().int().nonnegative().nullable().optional(),
    afterBytes: z.number().int().nonnegative().nullable().optional(),
    beforeAuthority: z.string().nullable().optional(),
    afterAuthority: z.string().nullable().optional(),
  })
  .optional();

type ToolArgs = z.infer<typeof toolSchema>;

function makeScout(opts: ToolArgs, mode: 'rules' | 'real') {
  const budget = new Budget(opts.budget);
  const transport = new HttpTransport(opts.rpc ?? process.env.DOT_RPC_URL ?? DEFAULT_RPC);
  const client = new SolanaClient({ transport, budget, commitment: opts.commitment });
  const rules = new RuleBasedDecision({});
  const cfg = llmConfigFromEnv();
  const decision = mode === 'real' && cfg ? new RealLlmDecision(cfg, rules, budget) : rules;
  const scout = new Scout({
    client,
    budget,
    decision,
    mode,
    ...(opts.knownMultisigs.length > 0 ? { knownMultisigs: opts.knownMultisigs } : {}),
    idlResolver: (p) =>
      resolveIdl(
        p,
        { ...(opts.idl ? { idl: opts.idl } : {}), ...(opts.priorIdl ? { priorIdl: opts.priorIdl } : {}), tryOnchain: opts.tryOnchainIdl },
        client,
      ),
    ...(mode === 'real' && cfg
      ? {
          narrate: async (ctx: UpgradeContext, graph: Parameters<typeof narrateBlastRadius>[4], led: EvidenceLedger) =>
            advisoryToNarrative(await narrateBlastRadius(cfg, budget, led, ctx, graph)),
        }
      : {}),
  });
  return { scout, budget };
}

function reportContent(report: DotReport, format: 'json' | 'md', extra: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: format === 'md' ? renderMarkdown(report) : JSON.stringify(report, null, 2) }],
    structuredContent: {
      tier: report.tier,
      tierSource: report.tierSource,
      score: report.score,
      confidence: report.confidence,
      stoppedAt: report.stoppedAt,
      cappedBy: report.cappedBy,
      decisionSource: report.decision?.source ?? null,
      directCallers: report.blastRadius?.directCallers ?? null,
      transitiveCallers: report.blastRadius?.transitiveCallers ?? null,
      /** A per-transaction upper-bound proxy. Marked so no caller promotes it into a TVL claim. */
      lamportsRouted: report.blastRadius?.lamportsRouted ?? null,
      valueIsProxy: true,
      attributionQuality: report.blastRadius?.attributionQuality ?? null,
      integrity: report.integrity?.agreement ?? 'not_checked',
      budget: report.budget,
      limits: report.limits.map((l) => l.code),
      ...extra,
    },
  };
}

function errorResult(message: string, extra: Record<string, unknown> = {}) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message, ...extra }) }],
    isError: true,
  };
}

/**
 * The MCP surface is Dot's agent-facing interface, and its job is to hand a calling
 * agent the same honesty a human gets: the budget snapshot, the stage the run ended
 * at, the limits that applied, and value figures marked as proxies.
 *
 * Two rules this file does not break. **stdout is the protocol channel** — every
 * diagnostic here is `console.error`, because one stray `console.log` corrupts the
 * JSON-RPC stream and the host drops the connection. And **absence is reported as
 * absence**: an unobserved dependent count is `null`, not `0`, and a watch cursor
 * with no status file says `unavailable` with the path it looked at.
 *
 * Tool names moved from `solana_*` to `dot_*`; a caller written against the old
 * names must be updated, which belongs in the commit message, not a silent diff.
 */
export function buildServer(opts: McpOptions): McpServer {
  const mode: 'rules' | 'real' = opts.mode === 'real' ? 'real' : 'rules';
  const server = new McpServer({ name: 'dot', version: '0.1.0' }, { capabilities: { tools: {} } });

  server.registerTool(
    'dot_blast_radius',
    {
      title: 'Solana CPI blast radius',
      description:
        'Reconstructs the on-chain CPI dependency graph for a program from historical transaction traces and returns dependent programs, attributed CPI volume, value routed (a per-transaction upper-bound proxy, not TVL), a P0-P3 tier, the budget spent, and the limits that applied. Stops when the budget runs out and reports the partial graph as partial.',
      inputSchema: { ...toolSchema.shape, format: z.enum(['json', 'md']).default('json') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      if (!isWellFormedPubkey(args.program)) return errorResult(`${args.program} is not a 32-byte base58 address`);
      const { scout } = makeScout(args, mode);
      try {
        const report = await scout.run({ program: args.program, forceFullTrace: args.forceFullTrace });
        return reportContent(report, args.format, {});
      } catch (e) {
        if (isDotError(e)) return errorResult(e.message, { code: e.code, details: e.details });
        return errorResult((e as Error).message);
      }
    },
  );

  server.registerTool(
    'dot_evaluate_upgrade',
    {
      title: 'Evaluate a Solana program upgrade',
      description:
        'Scores one BPFLoaderUpgradeable upgrade: authority posture, whether the authority rotated, bytecode size move, and the blast radius reconstructed from traces. Event fields are taken from the caller when supplied; if omitted, Dot reads current on-chain state only and names which inputs it lacked. The tier is a queue position, not a verdict, and a same-slot endpoint contradiction returns tierSource "integrity".',
      inputSchema: { ...toolSchema.shape, event: eventSchema, format: z.enum(['json', 'md']).default('json') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      if (!isWellFormedPubkey(args.program)) return errorResult(`${args.program} is not a 32-byte base58 address`);
      const { scout } = makeScout(args, mode);
      const ev = args.event
        ? {
            kind: args.event.kind,
            program: args.program,
            programData: '',
            before:
              args.event.beforeBytes === undefined && args.event.beforeAuthority === undefined
                ? null
                : {
                    programData: '',
                    bytecodeHash: '',
                    fullAccountHash: '',
                    authority: args.event.beforeAuthority ?? null,
                    bytecodeLen: args.event.beforeBytes ?? 0,
                    accountLen: 0,
                    headerU64: 0,
                    observedAt: 0,
                    closed: false,
                  },
            after: {
              programData: '',
              bytecodeHash: '',
              fullAccountHash: '',
              authority: args.event.afterAuthority ?? null,
              bytecodeLen: args.event.afterBytes ?? 0,
              accountLen: 0,
              headerU64: 0,
              observedAt: 0,
              closed: false,
            },
            changed: {
              bytecode: (args.event.beforeBytes ?? null) !== (args.event.afterBytes ?? null),
              authority: (args.event.beforeAuthority ?? null) !== (args.event.afterAuthority ?? null),
              size: (args.event.beforeBytes ?? null) !== (args.event.afterBytes ?? null),
            },
            detectedAt: Date.now(),
            source: 'ws' as const,
          }
        : undefined;
      try {
        const report = await scout.run({ program: args.program, forceFullTrace: args.forceFullTrace, ...(ev ? { event: ev } : {}) });
        return reportContent(report, args.format, { components: report.components });
      } catch (e) {
        if (isDotError(e)) return errorResult(e.message, { code: e.code, details: e.details });
        return errorResult((e as Error).message);
      }
    },
  );

  server.registerTool(
    'dot_limits',
    {
      title: 'Dot limit catalogue with three-state status',
      description:
        'Returns every documented blind spot with its state: RESOLVED (fixed in code, names its test file), NARROWED (smaller surface, and what remains is named), or UNRESOLVABLE_IN_CODE (a property of the chain or of intent, not a bug to be closed). Call this before treating any empty result as a clean result.',
      inputSchema: { state: z.enum(['RESOLVED', 'NARROWED', 'UNRESOLVABLE_IN_CODE']).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: { state?: LimitState }) => {
      const status = LIMIT_STATUS.filter((s) => !args.state || s.state === args.state);
      const verification = await verifyTestClaims(process.cwd());
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ counts: countStates(), coverage: auditCoverage(), verification, status }, null, 2) }],
        structuredContent: {
          counts: countStates(),
          coverage: auditCoverage(),
          /** A RESOLVED limit whose named test is missing is a bug, reported not hidden. */
          resolvedVerification: verification,
          limits: status.map((s) => ({ code: s.code, state: s.state, remains: s.remains || null, tests: s.tests })),
        },
      };
    },
  );

  server.registerTool(
    'dot_watch_status',
    {
      title: 'Watch cursor and daemon health',
      description:
        "Returns the detection daemon's position: last read slot, ticks, targets observed, events emitted, and feed/dispatcher counters. Reads the status file the daemon writes; with no status file it reports unavailable plus the path it looked at, because a caller must be able to tell \"no upgrades detected\" from \"nobody is watching\".",
      inputSchema: {
        network: z.string().default('mainnet'),
        statusFile: z.string().optional().describe('path to the daemon status file (or DOT_STATUS_FILE)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: { network: string; statusFile?: string }) => {
      const lookedAt = args.statusFile ?? process.env.DOT_STATUS_FILE ?? null;
      if (!lookedAt) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ available: false, reason: 'no status file configured; this MCP process is not the daemon' }, null, 2) }],
          structuredContent: { available: false, reason: 'no_status_file_configured', lookedAt: null, network: args.network },
        };
      }
      try {
        const raw = JSON.parse(await readFile(lookedAt, 'utf8')) as { network?: string; watcher?: WatchStatus; writtenAt?: number };
        const staleMs = raw.writtenAt ? Date.now() - raw.writtenAt : null;
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ available: true, staleMs, ...raw }, null, 2) }],
          structuredContent: {
            available: true,
            network: raw.network ?? args.network,
            lastReadSlot: raw.watcher?.lastReadSlot ?? null,
            ticks: raw.watcher?.ticks ?? null,
            eventsEmitted: raw.watcher?.eventsEmitted ?? null,
            running: raw.watcher?.running ?? false,
            cursorPersisted: true,
            staleMs,
            // An old cursor is not a live cursor, and a caller cannot tell without this.
            stale: staleMs !== null && staleMs > 300_000,
            lookedAt,
          },
        };
      } catch (e) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ available: false, reason: (e as Error).message, lookedAt }, null, 2) }],
          structuredContent: { available: false, reason: 'unreadable', lookedAt, network: args.network },
        };
      }
    },
  );

  return server;
}

export async function startMcpServer(opts: McpOptions): Promise<void> {
  const server = buildServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the protocol channel. Anything written there breaks the host's parse
  // and drops the connection, so every diagnostic in this file goes to stderr.
  console.error(`dot mcp ready (mode ${opts.mode === 'real' ? 'real' : 'rules'}, ${LIMIT_NOTES.length} codes)`);
}

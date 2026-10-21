import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Budget } from '../agent/budget.js';
import { RuleBasedDecision } from '../agent/rules.js';
import type { UpgradeContext } from '../agent/decision.js';
import { RealLlmDecision, llmConfigFromEnv, narrateIdlDiff } from '../agent/llm.js';
import { EvidenceLedger } from '../agent/evidence.js';
import { Scout } from '../agent/scout.js';
import { HttpTransport } from '../rpc/transport.js';
import { SolanaClient } from '../rpc/client.js';
import { resolveIdl } from '../idl.js';
import { renderMarkdown, type DotReport } from '../report.js';
import { LIMIT_NOTES } from '../limits.js';
import { isWellFormedPubkey } from '../ids.js';
import { isDotError } from '../errors.js';

const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';

export type McpOptions = { rpc?: string; mode?: string };

const budgetSchema = z
  .object({
    maxRpcCalls: z.number().int().min(1).max(2000).describe('hard ceiling on JSON-RPC round trips, retries included'),
    maxSignatures: z.number().int().min(1).max(1000).describe('hard ceiling on transactions pulled into the graph'),
    maxLlmTokens: z.number().int().min(0).max(200000).describe('hard ceiling on model spend for this call'),
    maxWallMs: z.number().int().min(1000).max(600000).describe('hard ceiling on wall clock for this call'),
  })
  .describe('Dot stops mid-analysis rather than exceed these');

const toolSchema = z.object({
  program: z.string().min(32).max(44).describe('the program whose blast radius is being asked about'),
  budget: budgetSchema,
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
          narrate: async (ctx: UpgradeContext, graph: string, led: EvidenceLedger) =>
            narrateIdlDiff(cfg, budget, led, ctx, graph),
        }
      : {}),
  });
  return { scout, budget };
}

function textify(report: DotReport, format: 'json' | 'md'): string {
  return format === 'md' ? renderMarkdown(report) : JSON.stringify(report, null, 2);
}

function errorResult(message: string, extra: Record<string, unknown> = {}) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message, ...extra }) }],
    isError: true,
  };
}

/**
 * The MCP surface is Dot's real interface; the CLI is a thin wrapper over it.
 *
 * What matters here is that a calling agent gets the same honesty a human gets:
 * `isError` on a bad argument, the budget snapshot on every result, and the
 * `limits` array in the payload even when the run looked clean. A blast-radius
 * answer that does not say what it could not see is the failure mode this
 * server exists to avoid.
 */
export function buildServer(opts: McpOptions): McpServer {
  const mode: 'rules' | 'real' = opts.mode === 'real' ? 'real' : 'rules';
  const server = new McpServer(
    { name: 'dot', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'solana_blast_radius',
    {
      title: 'Solana CPI blast radius',
      description:
        'Reconstructs the on-chain CPI dependency graph for a program from historical transaction traces and returns the dependent programs, attributed CPI volume, value routed, and a P0-P3 triage tier. Accepts a spend budget and stops when it runs out, reporting a partial graph as partial.',
      inputSchema: { ...toolSchema.shape, format: z.enum(['json', 'md']).default('json') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      if (!isWellFormedPubkey(args.program)) return errorResult(`${args.program} is not a 32-byte base58 address`);
      const { scout } = makeScout(args, mode);
      try {
        const report = await scout.run({
          program: args.program,
          forceFullTrace: args.forceFullTrace,
        });
        return {
          content: [{ type: 'text' as const, text: textify(report, args.format) }],
          structuredContent: {
            tier: report.tier,
            score: report.score,
            confidence: report.confidence,
            stoppedAt: report.stoppedAt,
            directCallers: report.blastRadius?.directCallers ?? null,
            transitiveCallers: report.blastRadius?.transitiveCallers ?? null,
            lamportsRouted: report.blastRadius?.lamportsRouted ?? null,
            attributionQuality: report.blastRadius?.attributionQuality ?? null,
            budget: report.budget,
            limits: report.limits.map((l) => l.code),
          },
        };
      } catch (e) {
        if (isDotError(e)) return errorResult(e.message, { code: e.code, details: e.details });
        return errorResult((e as Error).message);
      }
    },
  );

  server.registerTool(
    'solana_evaluate_upgrade',
    {
      title: 'Evaluate a Solana program upgrade',
      description:
        'Scores one BPFLoaderUpgradeable upgrade event: authority posture, whether the authority rotated, bytecode size move, and the blast radius reconstructed from traces. Returns a P0-P3 tier with the components that produced it, the evidence ledger, and the limits that capped the answer. The event fields are taken from the caller when supplied; if omitted Dot reads current on-chain state only and says which inputs it lacked.',
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
            before: {
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
        const report = await scout.run({
          program: args.program,
          forceFullTrace: args.forceFullTrace,
          ...(ev ? { event: ev } : {}),
        });
        return {
          content: [{ type: 'text' as const, text: textify(report, args.format) }],
          structuredContent: {
            tier: report.tier,
            score: report.score,
            confidence: report.confidence,
            components: report.components,
            stoppedAt: report.stoppedAt,
            decisionSource: report.decision?.source ?? null,
            cappedBy: report.cappedBy,
            budget: report.budget,
            limits: report.limits.map((l) => l.code),
          },
        };
      } catch (e) {
        if (isDotError(e)) return errorResult(e.message, { code: e.code, details: e.details });
        return errorResult((e as Error).message);
      }
    },
  );

  return server;
}

export async function startMcpServer(opts: McpOptions): Promise<void> {
  const server = buildServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the protocol channel. Any diagnostic must go to stderr or the
  // client's JSON parse dies on it.
  process.stderr.write(`dot mcp ready (mode ${opts.mode === 'real' ? 'real' : 'rules'}, ${LIMIT_NOTES.length} documented limits)\n`);
}

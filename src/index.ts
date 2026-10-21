export { Budget, type BudgetLimits, type BudgetSnapshot } from './agent/budget.js';
export { EvidenceLedger, type Evidence } from './agent/evidence.js';
export type { Decision, DecisionEngine, UpgradeContext } from './agent/decision.js';
export { RuleBasedDecision } from './agent/rules.js';
export { RealLlmDecision, llmConfigFromEnv, narrateIdlDiff, type LlmConfig } from './agent/llm.js';
export { Scout, type ScoutOptions, type PriorDigest } from './agent/scout.js';
export { HttpTransport, type RpcTransport } from './rpc/transport.js';
export { SolanaClient, type SolanaClientOptions } from './rpc/client.js';
export { GraphBuilder, directDependents, dependentsByDepth, type Graph, type GraphEdge } from './graph/builder.js';
export { analyzeTrace, foldInnerInstructions, treeFromLogs } from './graph/normalize.js';
export { resolveAccountKeys } from './graph/keys.js';
export { UpgradeWatcher, verifyProgramPointer, type WatchTarget, type UpgradeEvent } from './watcher/watcher.js';
export {
  classifyAuthority,
  decodeProgramData,
  deriveProgramData,
  readProgramPointer,
  type ProgramDataState,
} from './state/programdata.js';
export { scoreRisk, tierFor, TIER_MEANING, type RiskTier, type ExposureSignals, type EvidenceSignals } from './score/risk.js';
export { LIMIT_NOTES, limitsFor, type LimitNote } from './limits.js';
export { resolveIdl, anchorIdlPda, diffIdl, type IdlOptions, type IdlResolution } from './idl.js';
export { renderMarkdown, type DotReport } from './report.js';
export { DotError, BudgetExhaustedError, isDotError } from './errors.js';

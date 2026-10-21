/** Error taxonomy. Every throw site names a code so a report can say *why* a
 *  number is missing instead of silently reporting zero. */

export type DotErrorCode =
  | 'BUDGET_EXHAUSTED_RPC'
  | 'BUDGET_EXHAUSTED_TOKENS'
  | 'BUDGET_EXHAUSTED_WALL'
  | 'BUDGET_EXHAUSTED_SIGNATURES'
  | 'RPC_TRANSPORT'
  | 'RPC_JSONRPC'
  | 'RPC_ACCOUNT_NOT_FOUND'
  | 'TX_PRUNED'
  | 'NOT_UPGRADEABLE'
  | 'UNKNOWN_PROGRAMDATA_LAYOUT'
  | 'LLM_UNAVAILABLE'
  | 'BAD_HYPOTHESIS_FILE'
  | 'INVALID_PUBKEY';

export class DotError extends Error {
  readonly code: DotErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: DotErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'DotError';
    this.code = code;
    this.details = details;
  }
}

export type BudgetExhaustedKind = 'rpc' | 'tokens' | 'wall' | 'signatures';

export class BudgetExhaustedError extends DotError {
  readonly kind: BudgetExhaustedKind;
  readonly limit: number;
  readonly used: number;

  constructor(kind: BudgetExhaustedKind, limit: number, used: number, requested: number) {
    const codeMap: Record<BudgetExhaustedKind, DotErrorCode> = {
      rpc: 'BUDGET_EXHAUSTED_RPC',
      tokens: 'BUDGET_EXHAUSTED_TOKENS',
      wall: 'BUDGET_EXHAUSTED_WALL',
      signatures: 'BUDGET_EXHAUSTED_SIGNATURES',
    };
    super(
      codeMap[kind],
      `budget exhausted: ${kind} limit=${limit} used=${used} requested=${requested}`,
      { kind, limit, used, requested },
    );
    this.name = 'BudgetExhaustedError';
    this.kind = kind;
    this.limit = limit;
    this.used = used;
  }
}

export function isDotError(e: unknown): e is DotError {
  return e instanceof DotError;
}

/** Best-effort serialisation of an unknown throw for the report's evidence log. */
export function describeError(e: unknown): Record<string, unknown> {
  if (isDotError(e)) return { code: e.code, message: e.message, details: e.details };
  if (e instanceof Error) return { code: 'UNCLASSIFIED', message: e.message, name: e.name };
  return { code: 'UNCLASSIFIED', message: String(e) };
}

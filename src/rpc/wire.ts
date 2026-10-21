/**
 * Wire contract for `getTransaction` / `getSignaturesForAddress` at
 * `encoding: "jsonParsed"`, `maxSupportedTransactionVersion: 0`.
 *
 * Field presence below was read off live mainnet responses, not off the
 * `@solana/web3.js` v1.99 declarations — those differ in two ways that matter:
 *
 *  1. Parsed instructions carry NO `accounts` array (the account set lives in
 *     `parsed.info`). web3.js's superstruct marks `accounts` required, so
 *     `Connection.getTransaction(..., 'jsonParsed')` throws a StructError on
 *     real CPI-heavy transactions. Dot therefore speaks JSON-RPC directly.
 *  2. `stackHeight` IS returned (on both outer and inner instructions) but is
 *     not declared in web3.js v1's types. It is what makes an exact CPI call
 *     tree recoverable; older or filtered RPC nodes omit it, so every consumer
 *     here treats it as optional and has a fallback.
 */

export type PubkeyString = string;

export type WireAccountKey = {
  pubkey: PubkeyString;
  signer: boolean;
  source: 'transaction' | 'lookupTable';
  writable: boolean;
};

export type WireParsedInfo = {
  type?: string;
  info?: Record<string, unknown>;
};

/** A `spl-token`/`system`-style instruction the node understood. */
export type WireParsedInstruction = {
  program: string;
  programId: PubkeyString;
  parsed: WireParsedInfo | unknown;
  /** CPI nesting depth, 1-based. Absent on nodes that do not emit it. */
  stackHeight?: number;
  accounts?: undefined;
  data?: undefined;
};

/** An instruction the node could not decode — an unanchored/unknown program. */
export type WireRawInstruction = {
  programId: PubkeyString;
  /**
   * `encoding: "json"` sends these as indexes into the resolved key table
   * (static keys, then loaded-writable, then loaded-readonly).
   * `encoding: "jsonParsed"` sends these as **base58 pubkeys already**.
   * Measured on mainnet 2026-10-21; see `src/graph/keys.ts`.
   */
  accounts: Array<number | string>;
  /** base58 instruction data */
  data: string;
  stackHeight?: number;
  parsed?: undefined;
  program?: undefined;
};

/** The node may also return a *fully* opaque instruction: programId + accounts only. */
export type WireAnyInstruction = {
  programId: PubkeyString;
  stackHeight?: number;
  program?: string;
  parsed?: WireParsedInfo | unknown;
  accounts?: Array<number | string>;
  data?: string;
};

/**
 * `meta.innerInstructions[]`. `index` is the position in the OUTER
 * `transaction.message.instructions` array that this CPI burst belongs to.
 * The list inside a group is flat execution order with no parent pointer:
 * depth must be recovered from `stackHeight` (or the logs) — never assumed.
 */
export type WireInnerInstructionGroup = {
  index: number;
  instructions: WireAnyInstruction[];
};

export type WirePreInstructionGroup = {
  index: number;
  instructions: WireAnyInstruction[];
};

export type WireTokenAmount = {
  amount: string;
  decimals: number;
  uiAmount: number | null;
  uiAmountString: string;
};

export type WireTokenBalance = {
  accountIndex: number;
  mint: PubkeyString;
  owner?: PubkeyString;
  programId?: PubkeyString;
  uiTokenAmount: WireTokenAmount;
};

export type WireLoadedAddresses = {
  writable: PubkeyString[];
  readonly: PubkeyString[];
};

export type WireTransactionError = string | Record<string, unknown> | null;

export type WireTransactionMeta = {
  err: WireTransactionError;
  status?: { Ok?: unknown; Err?: WireTransactionError };
  fee: number;
  preBalances: number[];
  postBalances: number[];
  computeUnitsConsumed?: number;
  costUnits?: number;
  innerInstructions?: WireInnerInstructionGroup[] | null;
  preInnerInstructions?: WirePreInstructionGroup[] | null;
  logMessages?: string[] | null;
  preTokenBalances?: WireTokenBalance[] | null;
  postTokenBalances?: WireTokenBalance[] | null;
  loadedAddresses?: WireLoadedAddresses | null;
  rewards?: unknown[];
};

export type WireMessage = {
  accountKeys: WireAccountKey[];
  instructions: WireAnyInstruction[];
  recentBlockhash: string;
  addressTableLookups?: Array<{ accountKey: PubkeyString; writableIndexes: number[]; readonlyIndexes: number[] }> | null;
};

export type WireGetTransactionResult = {
  slot: number;
  transactionIndex?: number;
  blockTime: number | null;
  meta: WireTransactionMeta | null;
  version: 'legacy' | number | null;
  transaction: { message: WireMessage; signatures: string[] };
};

/**
 * `getBlock` at `encoding: "jsonParsed"`. Each entry is close to, but not the
 * same as, a `getTransaction` result: `version` is optional and `transactionIndex`
 * is absent, so an adapter is required rather than a cast.
 */
export type WireBlockTransaction = {
  slot?: number | null;
  transaction: { message: WireMessage; signatures: string[] };
  meta: WireTransactionMeta | null;
  blockTime?: number | null;
  version?: 'legacy' | number | null;
};

export type WireBlock = {
  blockhash: string;
  previousBlockhash: string;
  parentSlot: number;
  slot?: number;
  blockTime?: number | null;
  blockHeight?: number | null;
  transactions?: WireBlockTransaction[];
  signatures?: string[];
};

export type WireSignatureInfo = {
  signature: string;
  slot: number;
  err: WireTransactionError;
  memo?: string | null;
  blockTime?: number | null;
  confirmationStatus?: string;
};

export type WireAccountState<T = unknown> = {
  lamports: number;
  owner: PubkeyString;
  executable: boolean;
  rentEpoch?: number | null;
  space?: number;
  data: T;
};

export type WireGetAccountInfoResult = { value: WireAccountState<[string, 'base64' | 'base58' | 'jsonParsed']> | null } | null;

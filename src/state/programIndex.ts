import { Buffer } from 'node:buffer';
import type { SolanaClient } from '../rpc/client.js';
import type { Budget } from '../agent/budget.js';
import { deriveProgramData, readProgramPointer } from './programdata.js';
import { BudgetExhaustedError } from '../errors.js';

/**
 * `ProgramData` address → program address.
 *
 * Nothing on-chain stores the reverse pointer. `Program` accounts point *at*
 * `ProgramData`, and `findProgramAddress` is one-way, so a chain-wide Geyser feed —
 * which reports "this ProgramData was written" and nothing else — arrives with the
 * one fact Dot most needs missing. Three ways out, cheapest first, and each is
 * recorded on the answer so a report can say how the program got its name:
 *
 *  1. **Pointer accounts already seen.** The owner filter catches `Program` accounts
 *     too, and they are written at deploy, so a long-running daemon accumulates the
 *     map for free.
 *  2. **The transaction that wrote the account.** Geyser gives the signature; the
 *     upgrade transaction lists the program, the programdata and the buffer among
 *     its account keys. For each candidate key Dot derives *its* programdata PDA
 *     locally and compares — exact, and one RPC call, not one per candidate.
 *  3. **A reverse `getProgramAccounts` scan.** Correct but heavy, and many providers
 *     gate it; last resort only.
 *
 * When all three fail the answer is `unresolved`, and the caller must skip the
 * event with a count — not guess a program id, and not analyze nothing while
 * reporting nothing wrong.
 */
export type ResolveMethod = 'pointer_index' | 'upgrade_tx' | 'reverse_scan' | 'unresolved';

export type Resolved = { program: string | null; how: ResolveMethod; rpcCalls: number };

export class ProgramIndex {
  private readonly byProgramData = new Map<string, string>();
  private readonly negative = new Set<string>();

  constructor(
    private readonly client: SolanaClient,
    private readonly budget?: Budget,
  ) {}

  size(): number {
    return this.byProgramData.size;
  }

  /** Fed from the feed's `Program` pointer updates; costs nothing. */
  observePointer(programData: string, program: string): void {
    this.byProgramData.set(programData, program);
    this.negative.delete(programData);
  }

  static pointerFrom(data: Buffer): string | null {
    return readProgramPointer(data);
  }

  async resolve(programData: string, hintSignature?: string | null): Promise<Resolved> {
    const known = this.byProgramData.get(programData);
    if (known) return { program: known, how: 'pointer_index', rpcCalls: 0 };

    if (hintSignature) {
      let calls = 0;
      try {
        this.budget?.spendRpc(1, 'getTransaction');
        calls++;
        const res = await this.client.getTransaction(hintSignature);
        if (res.status === 'found') {
          for (const key of res.tx.transaction.message.accountKeys) {
            try {
              if (deriveProgramData(key.pubkey) === programData) {
                this.byProgramData.set(programData, key.pubkey);
                return { program: key.pubkey, how: 'upgrade_tx', rpcCalls: calls };
              }
            } catch {
              // A non-pubkey string in the key table is not a candidate; skip it.
            }
          }
        }
      } catch (e) {
        if (e instanceof BudgetExhaustedError) return { program: null, how: 'unresolved', rpcCalls: calls };
      }
    }

    // Last resort: a full-program scan filtered to pointer accounts. One call, but
    // providers gate it and it can be slow, so it is tried only when the cheap
    // routes came up empty.
    try {
      this.budget?.spendRpc(1, 'getProgramAccounts');
      const found = await this.client.findProgramAccountsForProgramData(programData);
      if (found.length > 0) {
        const program = found[0]!;
        this.byProgramData.set(programData, program);
        return { program, how: 'reverse_scan', rpcCalls: 1 };
      }
    } catch {
      /* gated or timed out — that is the expected outcome on a public endpoint */
    }

    this.negative.add(programData);
    return { program: null, how: 'unresolved', rpcCalls: 0 };
  }
}

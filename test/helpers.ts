import { readFileSync } from 'node:fs';
import type { RpcTransport, JsonRpcResponse } from '../src/rpc/transport.js';
import type { WireGetTransactionResult } from '../src/rpc/wire.js';

export function fixture<T = unknown>(name: string): T {
  const url = new URL(`./fixtures/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}

export function txFixture(name: string): WireGetTransactionResult {
  return fixture<WireGetTransactionResult>(name);
}

export type FakeRoute = {
  match: (method: string, params: unknown[]) => boolean;
  /** Static result, or a factory for tests that change chain state between calls. */
  result?: unknown;
  resultFn?: () => unknown;
  error?: { code: number; message: string };
};

/**
 * A transport that answers from a routing table instead of the network, so tests
 * can assert on the *call sequence* — which is the only way to prove a budget was
 * actually enforced rather than merely configured.
 */
export class FakeTransport implements RpcTransport {
  readonly endpoint = 'fake://localhost';
  readonly calls: Array<{ method: string; params: unknown[] }> = [];
  private routes: FakeRoute[];

  constructor(routes: FakeRoute[] = []) {
    this.routes = routes;
  }

  route(r: FakeRoute): void {
    this.routes = [...this.routes, r];
  }

  methodCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const c of this.calls) out[c.method] = (out[c.method] ?? 0) + 1;
    return out;
  }

  async request<T>(method: string, params: unknown[]): Promise<JsonRpcResponse<T>> {
    this.calls.push({ method, params });
    const hit = this.routes.find((r) => r.match(method, params));
    if (!hit) throw new Error(`FakeTransport: no route for ${method} ${JSON.stringify(params).slice(0, 120)}`);
    if (hit.error) return { jsonrpc: '2.0', id: this.calls.length, error: hit.error };
    const result = hit.resultFn ? hit.resultFn() : hit.result;
    return { jsonrpc: '2.0', id: this.calls.length, result: result as T };
  }
}

export const ctxSlot = (slot = 400_000_100) => ({ context: { slot } });

export function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

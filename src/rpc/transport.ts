import { DotError } from '../errors.js';

export type JsonRpcError = { code: number; message: string; data?: unknown };

export type JsonRpcResponse<T> = {
  jsonrpc: '2.0';
  id: number | string;
  result?: T;
  error?: JsonRpcError;
};

/**
 * Single-shot JSON-RPC. Deliberately dumb: no retries and no budgeting in
 * here, because a retry is a *second paid call* and that decision belongs to
 * the caller holding the `Budget`. A transport that silently retries makes the
 * reported call count a lie.
 */
export interface RpcTransport {
  readonly endpoint: string;
  request<T>(method: string, params: unknown): Promise<JsonRpcResponse<T>>;
  /** Wire size of the last response, when the transport can know it. */
  reportedBytes?(): number | null;
  close?(): void | Promise<void>;
}

export type HttpTransportOptions = {
  timeoutMs?: number;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
};

export class HttpTransport implements RpcTransport {
  readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;
  private readonly doFetch: typeof fetch;
  private seq = 0;
  private lastBytes: number | null = null;

  constructor(endpoint: string, opts: HttpTransportOptions = {}) {
    this.endpoint = endpoint;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    // API keys land here. Never log these headers and never put the endpoint in
    // an exception message that a report will carry.
    this.headers = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  /** Strips a query string that may hold an API key, for use in errors and reports. */
  redactedEndpoint(): string {
    try {
      const u = new URL(this.endpoint);
      if ([...u.searchParams.keys()].length > 0) return `${u.origin}${u.pathname}?<redacted>`;
      return `${u.origin}${u.pathname}`;
    } catch {
      return '<unparseable-endpoint>';
    }
  }

  reportedBytes(): number | null {
    return this.lastBytes;
  }

  async request<T>(method: string, params: unknown): Promise<JsonRpcResponse<T>> {
    const id = ++this.seq;
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await this.doFetch(this.endpoint, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      throw new DotError(
        'RPC_TRANSPORT',
        `${method} failed against ${this.redactedEndpoint()}: ${timedOut ? `timeout after ${this.timeoutMs}ms` : (e as Error).message}`,
        { method, cause: timedOut ? 'timeout' : 'network', name: (e as Error)?.name },
      );
    }

    // 429/5xx are thrown, not returned as JSON-RPC errors, so the caller can
    // tell "the node refused" from "the chain said no".
    if (res.status === 429) {
      const retryAfter = res.headers.get('retry-after');
      const err = new DotError('RPC_TRANSPORT', `${method} rate limited by ${this.redactedEndpoint()}`, {
        method,
        cause: 'rate_limited',
        ...(retryAfter ? { retryAfterMs: Number(retryAfter) * 1000 } : {}),
      });
      throw err;
    }
    if (res.status >= 500) {
      throw new DotError('RPC_TRANSPORT', `${method} got HTTP ${res.status} from ${this.redactedEndpoint()}`, {
        method,
        cause: 'server_error',
        status: res.status,
      });
    }
    if (!res.ok) {
      throw new DotError('RPC_TRANSPORT', `${method} got HTTP ${res.status}`, { method, status: res.status });
    }

    const len = Number(res.headers.get('content-length') ?? '0');
    this.lastBytes = Number.isFinite(len) && len > 0 ? len : null;

    let body: JsonRpcResponse<T>;
    try {
      body = (await res.json()) as JsonRpcResponse<T>;
    } catch {
      throw new DotError('RPC_TRANSPORT', `${method} returned a non-JSON body`, { method });
    }
    if (body.error) {
      throw new DotError('RPC_JSONRPC', `${method}: jsonrpc ${body.error.code} ${body.error.message}`, {
        method,
        rpcCode: body.error.code,
        rpcMessage: body.error.message,
      });
    }
    return body;
  }
}

/** Unwraps `RpcResponseAndContext`. */
export type WithContext<T> = { context: { slot: number }; value: T };

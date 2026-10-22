import { YellowstoneUpgradeFeed } from '../src/rpc/yellowstone.js';
import { isDotError } from '../src/errors.js';

/**
 * Re-probe every Geyser hostname named in `docs/blocked.md` §3, through Dot's own feed — not
 * through a hand-rolled client, so what this prints is what `dot watch --yellowstone` would
 * experience. Run it before quoting that table: the entries are measurements with a date, not
 * properties of the endpoints.
 *
 * No frame is expected without a token. The value of the probe is the *stage* each failure
 * surfaces at and the string that comes back, which is what makes "no credentials" separable
 * from "no service" — and, as §3 records, what makes it unseparable in practice.
 */
const ENDPOINTS = [
  'https://api.rpcpool.com',
  'https://mainnet.rpcpool.com',
  'https://grpc.mainnet.rpcpool.com',
  'https://solana-grpc.publicnode.com',
  'https://grpc.publicnode.com',
  'https://mainnet.helius-rpc.com',
  // The control. This host serves JSON-RPC and has no Geyser service at all; if it fails with
  // the same string as a real Geyser host, the client cannot tell those two situations apart.
  'https://api.mainnet-beta.solana.com',
];

const only = process.env.PROBE_ONLY?.split(',').filter(Boolean);
const hosts = only?.length ? ENDPOINTS.filter((e) => only.some((o) => e.includes(o))) : ENDPOINTS;
const token = process.env.YELLOWSTONE_TOKEN;
const WAIT_MS = Number(process.env.PROBE_WAIT_MS ?? 20_000);

for (const endpoint of hosts) {
  const t0 = Date.now();
  const feed = new YellowstoneUpgradeFeed({ endpoint, ...(token ? { xToken: token } : {}), connectTimeoutMs: 12_000 });
  let first: string | null = null;
  feed.on('account', (u: { address: string; slot: number }) => {
    first ??= `${u.address} slot=${u.slot}`;
  });
  let outcome = '';
  // Node kills the process on an 'error' event nobody listened for, and the feed emits one when
  // the provider's stream dies after start() resolved. The CLI registers a handler; a probe that
  // forgot would look like a crash in Dot rather than a crash in the probe.
  feed.on('error', (e: unknown) => {
    outcome = `stream error: ${isDotError(e) ? `cause=${JSON.stringify(e.details.cause ?? e.message)} endpoint=${e.details.endpoint ?? '?'}` : String((e as Error)?.message ?? e)}`;
  });
  try {
    await feed.start();
    const got = await new Promise<boolean>((res) => {
      const to = setTimeout(() => res(false), WAIT_MS);
      feed.on('account', () => {
        clearTimeout(to);
        res(true);
      });
    });
    outcome = got ? `FRAME ${first}` : `subscribed, no frame within ${WAIT_MS}ms`;
  } catch (e) {
    outcome = isDotError(e)
      ? `stage=${e.details.stage ?? '?'} cause=${JSON.stringify(e.details.cause ?? e.message)}`
      : `threw ${(e as Error).message}`;
  } finally {
    feed.stop();
  }
  console.log(`${Date.now() - t0}ms ${endpoint} — ${outcome}`);
}

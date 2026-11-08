/**
 * The api process of the automated rehearsal (PNT-102) — rehearsal tooling, never deployed.
 *
 * It is apps/api/src/main.ts (the built `createApp`, the metrics server, `listen`) with one addition: no S3 runs
 * locally, so the private bucket is the api's in-memory object storage, and its presigned URLs
 * (`http://object-storage.invalid/…`) are answered here under `/__rehearsal/storage` (the presigned URL in the
 * `x-presigned-url` header), with the bucket's own signature, expiry, type and length checks — the same
 * arrangement as the live G1 run (apps/web/e2e/live/api-server.mjs). Configuration comes from the environment
 * (05 §8), exactly as for the real process. Prints one JSON line `{"ready":true}` once listening.
 */
import { loadEnvOrExit, OBJECT_STORAGE, startMetricsServer } from '@point/server';
import { createApp } from '../dist/bootstrap.js';

const env = loadEnvOrExit();
const app = await createApp({ env });
const storage = app.get(OBJECT_STORAGE);
app.use('/__rehearsal/storage', (req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const target = String(req.headers['x-presigned-url'] ?? '');
    const r = storage.handleHttp(req.method, target, {
      headers: { 'content-type': String(req.headers['content-type'] ?? '') },
      body: Buffer.concat(chunks),
    });
    res.status(r.status);
    for (const [name, value] of Object.entries(r.headers ?? {})) res.setHeader(name, value);
    res.end(r.body ?? (r.code ? `${r.code}: ${r.message ?? ''}` : ''));
  });
});
if (env.METRICS_ENABLED) startMetricsServer(env.METRICS_PORT);
await app.listen(env.API_PORT, '127.0.0.1');
console.log(JSON.stringify({ ready: true, port: env.API_PORT }));

const stop = async () => {
  await app.close().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());

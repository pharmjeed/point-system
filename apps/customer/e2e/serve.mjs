// Static server for the web export of the customer app (V2-018, DEC-550): serves `dist-web/` and falls back to
// index.html for every route (expo-router single-page output). Test harness only; never deployed.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  process.env.E2E_WEB_DIR ?? 'dist-web',
);
const port = Number(process.env.E2E_PORT ?? 4310);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.css': 'text/css',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

if (!existsSync(join(root, 'index.html'))) {
  console.error(`No web export in ${root}: run \`pnpm --filter @point/customer run export:web\` first`);
  process.exit(1);
}

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  let file = normalize(join(root, path));
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory())
    file = join(root, 'index.html');
  res.writeHead(200, {
    'content-type': types[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`customer web export on http://127.0.0.1:${port}`));

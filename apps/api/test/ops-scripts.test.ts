import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SCRIPT = join(REPO, 'scripts/check-secrets.mjs');

function runScan(root: string): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

/** PNT-096: `scripts/check-secrets.mjs` (part of `pnpm lint`) finds what must never be committed or shipped. */
describe('secrets scan', () => {
  const dirs: string[] = [];
  const tree = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), 'point-secrets-'));
    dirs.push(root);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  };
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('passes a clean tree (empty secrets in .env.example, env:// references, placeholders)', () => {
    const root = tree({
      '.env.example':
        'SESSION_SECRET=\nWA_APP_SECRET_REF=env://WA_APP_SECRET\nS3_SECRET_ACCESS_KEY=minio-secret\n',
      'docs/guide.md':
        'SESSION_SECRET=$(openssl rand -base64 32)\npostgres://point_api:CHANGE_ME@db:5432/point\n',
      'src/a.ts': "const url = 'postgres://postgres:postgres@localhost:5432/postgres';\n",
      'apps/web/dist/assets/index.js': 'console.log("VITE_BRAND_STAFF_NAME_AR");\n',
    });
    expect(runScan(root)).toMatchObject({ code: 0 });
  });

  it('refuses secret files, credentials in text and server names in the web bundle', () => {
    // the planted values are assembled at run time so that this file itself stays clean
    const privateKey = ['-----BEGIN OPENSSH', 'PRIVATE KEY-----'].join(' ');
    const awsKey = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
    const dbUrl = ['postgres://point_api:', 'Vq8sLmT2xYp9Kd3R', '@db.internal:5432/point'].join('');
    const root = tree({
      '.env': 'APP_ENV=production\n',
      'infra/.env.production': 'x=1\n',
      'deploy/server.key': 'k\n',
      'backups/point-2026.dump.age': 'x\n',
      'release.zip': 'x\n',
      'notes/key.txt': `${privateKey}\nabc\n`,
      'notes/age.txt': `AGE-SECRET-KEY-1${'Q'.repeat(58)}\n`,
      'notes/aws.txt': `aws key ${awsKey} here\n`,
      'infra/prod.env.sample': 'SESSION_SECRET=Q2hhbmdlTWVQbGVhc2VUaGlzSXNOb3RBUmVhbFNlY3JldA==\n',
      'infra/compose.yml': '    WA_APP_SECRET: 9f2c4b7e1d8a6c3f5e0b9a7d\n',
      'ops/db.sh': `psql ${dbUrl}\n`,
      'apps/web/dist/assets/index.js': 'const u = "DATABASE_URL";\n',
    });
    const r = runScan(root);
    expect(r.code).toBe(1);
    for (const finding of [
      '.env: environment file',
      'infra/.env.production: environment file',
      'deploy/server.key: key or certificate store',
      'backups/point-2026.dump.age: encrypted backup or database dump',
      'release.zip: delivery archive',
      'notes/key.txt:1: private key block',
      'notes/age.txt:1: age identity',
      'notes/aws.txt:1: AWS access key id',
      'infra/prod.env.sample:1: SESSION_SECRET has a literal value',
      'infra/compose.yml:1: WA_APP_SECRET has a literal value',
      'ops/db.sh:1: database URL with a password',
      'apps/web/dist/assets/index.js:1: server-only name DATABASE_URL in the web bundle',
    ]) {
      expect(r.out).toContain(finding);
    }
  });

  it('the repository itself is clean (the same check as pnpm lint)', () => {
    const out = execFileSync(process.execPath, [SCRIPT], { cwd: REPO, encoding: 'utf8' });
    expect(out).toMatch(/^secrets check: ok/);
  });
});

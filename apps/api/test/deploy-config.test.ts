import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deploymentProblems, isGatewayHost, loadEnv } from '@point/server';
import { afterAll, describe, expect, it } from 'vitest';
import { optionsFromEnv } from '../../../tools/payment-simulator/src/index.js';

const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * PNT-096 / 17 §10 «الترويسات»: the production proxy and compose files carry the documented values (05 §14.1,
 * 09 §9.3, DEC-29, DEC-94). The same files were exercised end to end with Caddy 2.11 and the images (see
 * docs/progress/notes/ops-security.md); this test keeps them from drifting.
 */
describe('reverse proxy (infra/caddy/Caddyfile)', () => {
  const caddy = read('infra/caddy/Caddyfile');
  const csp = /Content-Security-Policy "([^"]+)"/.exec(caddy)?.[1] ?? '';
  const directives = new Map(
    csp.split(';').map((d) => {
      const [name = '', ...values] = d.trim().split(/\s+/);
      return [name, values] as const;
    }),
  );

  it('CSP of the PWA: no inline script, no framing, self plus the storage origin only', () => {
    expect(directives.get('default-src')).toEqual(["'self'"]);
    expect(directives.get('script-src')).toEqual(["'self'"]);
    expect(directives.get('style-src')).toEqual(["'self'"]);
    // DEC-192 (05 §14.1): injected <style> elements only (Radix scroll lock); style attributes stay blocked
    expect(directives.get('style-src-elem')).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directives.get('img-src')).toEqual(["'self'", 'blob:', 'data:', '{$STORAGE_ORIGIN}']);
    expect(directives.get('connect-src')).toEqual(["'self'", 'wss://{$DOMAIN}', '{$STORAGE_ORIGIN}']);
    expect(directives.get('frame-ancestors')).toEqual(["'none'"]);
    expect(directives.get('object-src')).toEqual(["'none'"]);
    for (const d of ['base-uri', 'form-action', 'font-src', 'worker-src', 'manifest-src', 'media-src']) {
      expect(directives.get(d), d).toEqual(["'self'"]);
    }
    const others = [...directives].filter(([name]) => name !== 'style-src-elem');
    expect(others.flatMap(([, values]) => values).join(' ')).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
  });

  it('security headers, one origin for /v1, /ws, the webhook and health; /metrics never proxied', () => {
    expect(caddy).toContain('Strict-Transport-Security "max-age=31536000; includeSubDomains"');
    expect(caddy).toContain('Referrer-Policy "no-referrer"');
    expect(caddy).toContain('Permissions-Policy "geolocation=(), microphone=(), camera=(self), payment=()"');
    expect(caddy).toContain('X-Frame-Options "DENY"');
    expect(caddy).toContain('X-Content-Type-Options "nosniff"');
    expect(caddy).toMatch(/@api path \/v1 \/v1\/\* \/ws \/ws\/\* \/health\/live \/health\/ready/);
    expect(caddy).toMatch(/handle \/webhooks\/whatsapp \{[^}]*max_size 4MB/s);
    // V2-051 (DEC-562): the gateway's and the e-invoicing provider's webhooks reach the api (not the PWA)
    expect(caddy).toMatch(/handle \/webhooks\/payments\/moyasar \{[^}]*max_size 1MB[^}]*\}\s*reverse_proxy/s);
    expect(caddy).toMatch(/handle \/webhooks\/einvoicing \{[^}]*max_size 1MB[^}]*\}\s*reverse_proxy/s);
    expect(caddy).toMatch(/handle \/metrics\* \{\s*respond 404\s*\}/);
  });

  it('caching: hashed assets immutable, the shell revalidated, no source maps, no index.html under an asset name', () => {
    expect(caddy).toContain('header @hashed Cache-Control "public, max-age=31536000, immutable"');
    expect(caddy).toContain('header ?Cache-Control "no-cache"');
    expect(caddy).toMatch(/@maps path \*\.map\s+respond @maps 404/);
    expect(caddy).toMatch(
      /@not_served \{\s*path \/assets\/\* \/icons\/\* \/sounds\/\*\s*not file\s*\}\s*respond @not_served 404/,
    );
    expect(caddy).toMatch(/rewrite @spa \/index\.html/);
  });

  it('the access log drops secrets carried in query strings', () => {
    // V2-051 (DEC-562): `phone` too (P-06's exact search by number), canon rule 8
    for (const p of [
      'phone',
      'hub.verify_token',
      'X-Amz-Signature',
      'X-Amz-Credential',
      'X-Amz-Security-Token',
    ]) {
      expect(caddy).toContain(`delete ${p}`);
    }
  });
});

describe('production compose (infra/compose/docker-compose.prod.yml)', () => {
  const compose = read('infra/compose/docker-compose.prod.yml');
  const block = (name: string) => {
    const m = new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z-]+:\\n|\\nnetworks:|\\nvolumes:)`).exec(
      compose,
    );
    return m?.[1] ?? '';
  };

  it('backend processes: read-only, no capabilities, no new privileges, the same image', () => {
    const backend = /x-backend: &backend\n([\s\S]*?)\nservices:/.exec(compose)?.[1] ?? '';
    expect(backend).toContain('read_only: true');
    expect(backend).toMatch(/cap_drop:\s*\n\s*- ALL/);
    expect(backend).toContain('no-new-privileges:true');
    expect(backend).toContain('dockerfile: infra/docker/Dockerfile');
    for (const s of ['migrate', 'api', 'worker']) expect(block(s), s).toContain('<<: *backend');
  });

  it('migrations run first as the schema owner; api and worker use their own database roles', () => {
    expect(block('migrate')).toContain("command: ['node', 'db/dist/cli.js', 'migrate']");
    expect(block('migrate')).toContain('DATABASE_URL: ${MIGRATION_DATABASE_URL:?');
    expect(block('api')).toContain('DATABASE_URL: ${API_DATABASE_URL:?');
    expect(block('worker')).toContain('DATABASE_URL: ${WORKER_DATABASE_URL:?');
    for (const s of ['api', 'worker'])
      expect(block(s), s).toContain('condition: service_completed_successfully');
  });

  it('only the proxy publishes ports (80, 443); metrics and the api stay internal', () => {
    // the host side defaults to 80/443; behind a shared gateway it is a loopback/bridge address (DEC-457)
    const published = [...compose.matchAll(/^\s+- '([^']+)'$/gm)]
      .map((m) => m[1] ?? '')
      .filter((p) => /:\d+(\/udp)?$/.test(p));
    expect(published).toEqual([
      '${POINT_HTTP_BIND:-80}:80',
      '${POINT_HTTPS_BIND:-443}:443',
      '${POINT_HTTPS_BIND:-443}:443/udp',
    ]);
    expect(block('web')).toContain('ports:');
    expect(compose.match(/^\s+ports:/gm)).toHaveLength(1); // only web publishes anything
    expect(compose).not.toMatch(/^\s+expose:/m);
  });
});

describe('backend image (infra/docker/Dockerfile)', () => {
  const dockerfile = read('infra/docker/Dockerfile');

  it('ships no sources, tests or rehearsal tooling of the workspace packages (DEC-366)', () => {
    const cleanup = dockerfile.match(/for d in \/out\/\*; do \\\n\s+rm -rf ([^;]+);/);
    expect(cleanup?.[1]).toBeDefined();
    for (const dir of ['"$d/src"', '"$d/test"', '"$d/rehearsal"', '"$d/scripts"'])
      expect(cleanup![1]).toContain(dir);
  });
});

describe('shared-server installation (DEC-457)', () => {
  const caddy = read('infra/caddy/Caddyfile');
  const install = read('infra/deploy/install.sh');
  const behind = read('infra/compose/docker-compose.behind-proxy.yml');

  it('the defaults keep Caddy terminating TLS itself; plain HTTP only when SITE_SCHEME says so', () => {
    expect(caddy).toMatch(/^\{\$SITE_SCHEME\}\{\$DOMAIN\} \{$/m);
    expect(caddy).toContain('trusted_proxies static {$TRUSTED_PROXIES:127.0.0.1/32}');
  });

  it('the installer generates every secret on the server and never takes over a port it does not own', () => {
    const envLib = read('infra/deploy/env.sh');
    for (const k of ['SESSION_SECRET', 'CODE_PEPPER', 'AUTH_SECRET_PEPPER', 'DATA_ENCRYPTION_KEY']) {
      expect(envLib).toContain(`${k}=$(point_b64)`);
    }
    expect(install).toContain('chmod 600 "$ENV_FILE"');
    expect(envLib).toContain('chmod 600 "$file"');
    expect(envLib).toContain('APP_ENV=staging');
    expect(envLib).toContain('WA_MODE=simulator');
    expect(install).toMatch(/ports 80\/443 are taken by something that is not a known gateway/);
    // a site file the gateway rejects is rolled back before any reload
    expect(install.indexOf('caddy validate')).toBeLessThan(install.indexOf('caddy reload'));
  });

  it('behind the gateway, api and worker reach the storage on DOMAIN through the host', () => {
    expect(behind).toMatch(/api:\s+extra_hosts:\s+- '\$\{DOMAIN\}:\$\{POINT_HOST_GATEWAY:-host-gateway\}'/);
    expect(behind).toMatch(
      /worker:\s+extra_hosts:\s+- '\$\{DOMAIN\}:\$\{POINT_HOST_GATEWAY:-host-gateway\}'/,
    );
  });
});

/**
 * V2 on the server (DEC-630 … DEC-635): infra/deploy/env.sh writes the staging .env and appends the keys a newer
 * version needs to an older one. Both run here for real (bash + openssl) and the result goes through the api's own
 * configuration checks.
 */
describe('the staging .env of the installer (V2, DEC-630, DEC-631)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'point-env-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const sh = (script: string, ...args: string[]) =>
    execFileSync(
      'bash',
      [
        '-c',
        `set -euo pipefail; ROOT="$1"; shift; . "$ROOT/infra/deploy/env.sh"; ${script}`,
        '_',
        ROOT,
        ...args,
      ],
      { encoding: 'utf8' },
    );
  const parse = (file: string): Record<string, string> =>
    Object.fromEntries(
      readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => /^[A-Z_][A-Z0-9_]*=/.test(l))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)] as const),
    );
  const fresh = join(dir, 'fresh.env');
  sh('point_env_write_new "$1" app.point.test ci@point.test; point_env_ensure "$1" >/dev/null', fresh);
  const env = parse(fresh);
  const v2Keys = sh('point_env_defaults | cut -d= -f1').trim().split('\n');

  it('a fresh install boots the api and the worker in staging with every V2 part simulated', () => {
    expect(statSync(fresh).mode & 0o777).toBe(0o600);
    for (const url of ['API_DATABASE_URL', 'WORKER_DATABASE_URL']) {
      const source = { ...env, DATABASE_URL: env[url]! };
      const parsed = loadEnv(source);
      expect(deploymentProblems(parsed, source), url).toEqual([]);
      expect(parsed.APP_ENV).toBe('staging');
      expect(parsed.PLATFORM_SESSION_COOKIE_NAME).toBe('__Host-point_psid');
      expect(parsed.MOYASAR_MODE).toBe('simulator');
      expect(parsed.MOYASAR_BASE_URL).toBe('http://payment-simulator:4020');
      expect(isGatewayHost(parsed.MOYASAR_BASE_URL)).toBe(false);
      expect(parsed.EINVOICE_MODE).toBe('simulator');
      expect(parsed.CUSTOMER_PUSH_MODE).toBe('simulator');
      expect(parsed.WA_MODE).toBe('simulator');
      expect(parsed.CUSTOMER_APP_LINK).toBe('');
      // an empty seller = the runtime's visible placeholders («بيانات تجريبية»), never a real-looking identity
      expect(parsed.INVOICE_SELLER_VAT_NUMBER).toBe('');
    }
    expect(env.MOYASAR_SECRET_KEY).toMatch(/^sk_test_[0-9a-f]{48}$/);
    expect(env.MOYASAR_WEBHOOK_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(env.EINVOICE_WEBHOOK_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set([env.MOYASAR_WEBHOOK_SECRET, env.EINVOICE_WEBHOOK_SECRET, env.WA_APP_SECRET]).size).toBe(
      3,
    );
    // the terms and consent versions follow the code and the app that ships their text (DEC-631): never pinned here
    for (const k of Object.keys(env)) expect(k).not.toMatch(/^CUSTOMER_.*_VERSION$/);
  });

  it('every env:// secret reference the server reads has its variable in .env', () => {
    const refs = new Set(
      [...read('packages/server/src/core/config/env.ts').matchAll(/env:\/\/([A-Z_]+)/g)].map((m) => m[1]!),
    );
    expect([...refs].sort()).toEqual([
      'EINVOICE_WEBHOOK_SECRET',
      'EXPO_ACCESS_TOKEN',
      'MOYASAR_SECRET_KEY',
      'MOYASAR_WEBHOOK_SECRET',
      'WA_ACCESS_TOKEN',
      'WA_APP_SECRET',
      'WA_VERIFY_TOKEN',
    ]);
    for (const k of refs) expect(Object.hasOwn(env, k), k).toBe(true);
    // EXPO_ACCESS_TOKEN is optional (the Expo project's push security) and the push simulator needs none
    for (const k of [...refs].filter((r) => r !== 'EXPO_ACCESS_TOKEN')) expect(env[k], k).not.toBe('');
  });

  it('an install of the first release gets the new keys appended; nothing it had changes (DEC-631)', () => {
    const v1 = join(dir, 'v1.env');
    sh('point_env_write_new "$1" app.point.test ci@point.test', v1);
    // the owner had changed a value the new version also lists, and the file lost its final newline
    writeFileSync(v1, `${readFileSync(v1, 'utf8')}MOYASAR_MODE=test`);
    const before = readFileSync(v1, 'utf8');
    const added = sh('point_env_ensure "$1"', v1).trim().split('\n');
    expect(added).toEqual(v2Keys.filter((k) => k !== 'MOYASAR_MODE'));
    const after = readFileSync(v1, 'utf8');
    expect(after.startsWith(`${before}\n`)).toBe(true);
    expect(parse(v1).MOYASAR_MODE).toBe('test');
    expect(statSync(v1).mode & 0o777).toBe(0o600);
    // the printed lines are names only, never a value
    expect(added.join('\n')).not.toContain('=');
    // idempotent: a second update adds nothing
    expect(sh('point_env_ensure "$1"', v1)).toBe('');
    expect(readFileSync(v1, 'utf8')).toBe(after);
    for (const k of v2Keys) expect(after.match(new RegExp(`^${k}=`, 'gm')), k).toHaveLength(1);
  });

  it('the payment simulator gets the same key and webhook secret as the api, and calls the api back', () => {
    const compose = read('infra/compose/docker-compose.payment-simulator.yml');
    const vars: Record<string, string> = {};
    for (const m of compose.matchAll(/^ {6}([A-Z_]+): (.+)$/gm)) {
      vars[m[1]!] = m[2]!
        .replace(/^'|'$/g, '')
        .replace(/\$\{([A-Z_]+)(?::[-?][^}]*)?\}/g, (_, k: string) =>
          k === 'API_PORT' ? '3000' : (env[k] ?? ''),
        );
    }
    expect(vars.WEBHOOK_URL).toBe('http://api:3000/webhooks/payments/moyasar');
    const opts = optionsFromEnv(vars);
    expect(opts.port).toBe(4020);
    expect(opts.secretKey).toBe(env.MOYASAR_SECRET_KEY);
    expect(opts.webhookSecret).toBe(env.MOYASAR_WEBHOOK_SECRET);
    expect(opts.webhookUrl).toBe('http://api:3000/webhooks/payments/moyasar');
    expect(new URL(env.MOYASAR_BASE_URL!).port).toBe(String(opts.port));
  });
});

describe('the staging stack on the server (V2, DEC-630, DEC-632, DEC-634)', () => {
  const install = read('infra/deploy/install.sh');
  const files = [
    'docker-compose.prod.yml',
    'docker-compose.local-db.yml',
    'docker-compose.minio.yml',
    'docker-compose.simulator.yml',
    'docker-compose.payment-simulator.yml',
    'docker-compose.behind-proxy.yml',
  ].map((f) => [f, read(`infra/compose/${f}`)] as const);

  it('the payment simulator is part of the stack and never published', () => {
    expect(install).toContain('infra/compose/docker-compose.payment-simulator.yml');
    const sim = read('infra/compose/docker-compose.payment-simulator.yml');
    expect(sim).not.toMatch(/^\s+(ports|expose):/m);
    expect(sim).toMatch(/networks:\s*\n\s+- point/);
    expect(sim).toContain('read_only: true');
    // only POINT's web server publishes anything (the simulator page behind the gateway is simulator-ui.yml)
    for (const [f, text] of files)
      expect(text.match(/^\s+ports:/gm)?.length ?? 0, f).toBe(f === 'docker-compose.prod.yml' ? 1 : 0);
  });

  it('every image POINT builds carries its label, and the cleanup touches nothing else', () => {
    for (const [f, text] of files) {
      const builds = text.match(/^\s+build:/gm)?.length ?? 0;
      expect(text.match(/sa\.point\.stack: point/g)?.length ?? 0, f).toBe(builds);
    }
    expect(install).toContain('docker image prune -f --filter label=sa.point.stack=point');
    expect(install).toMatch(/docker builder prune -f --filter "until=/);
    // the commands, not the comments that say what is never run
    const code = install
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(code).not.toMatch(/docker (system|volume|container|network) prune/);
    expect(code).not.toMatch(/image prune[^\n]*(-a\b|--all)/);
    expect(code).not.toMatch(/docker (rm|rmi|volume rm)\b/);
  });

  it('the free-disk guard and the disk report come before the build; the cleanup right after it', () => {
    const build = install.indexOf('"${PC[@]}" build');
    expect(install.indexOf('-lt "$MIN_FREE_GB"')).toBeGreaterThan(0);
    expect(install.indexOf('-lt "$MIN_FREE_GB"')).toBeLessThan(build);
    expect(install.indexOf('disk_report "before"')).toBeLessThan(build);
    expect(install.indexOf('prune_point', build)).toBeGreaterThan(build);
    expect(install.indexOf('disk_report "after"')).toBeGreaterThan(build);
    expect(install).toContain('MIN_FREE_GB="${POINT_MIN_FREE_GB:-8}"');
  });

  it('the gateway hands the whole host to the Caddy of POINT, which routes the customer, platform and webhook paths', () => {
    // one directive: every path (the PWA, /platform, /v1/customer/*, /ws with its /customer namespace, the webhooks)
    const site = /echo "\$DOMAIN \{"\n([\s\S]*?)echo "\}"/.exec(install)?.[1] ?? '';
    expect(site.trim()).toBe('echo "\treverse_proxy $GW_IP:$HTTP_PORT"');
    const caddy = read('infra/caddy/Caddyfile');
    expect(caddy).toMatch(/@api path \/v1 \/v1\/\* \/ws \/ws\/\*/);
    expect(caddy).toMatch(/rewrite @spa \/index\.html/);
    for (const hook of ['/webhooks/whatsapp', '/webhooks/payments/moyasar', '/webhooks/einvoicing'])
      expect(caddy).toContain(`handle ${hook} {`);
  });
});

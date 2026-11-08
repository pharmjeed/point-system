import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');

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
    for (const k of ['SESSION_SECRET', 'CODE_PEPPER', 'AUTH_SECRET_PEPPER', 'DATA_ENCRYPTION_KEY']) {
      expect(install).toContain(`${k}=$(b64)`);
    }
    expect(install).toContain('chmod 600 "$ENV_FILE"');
    expect(install).toContain('APP_ENV=staging');
    expect(install).toContain('WA_MODE=simulator');
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

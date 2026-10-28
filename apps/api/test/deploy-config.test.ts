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
    expect(directives.get('img-src')).toEqual(["'self'", 'blob:', 'data:', '{$STORAGE_ORIGIN}']);
    expect(directives.get('connect-src')).toEqual(["'self'", 'wss://{$DOMAIN}', '{$STORAGE_ORIGIN}']);
    expect(directives.get('frame-ancestors')).toEqual(["'none'"]);
    expect(directives.get('object-src')).toEqual(["'none'"]);
    for (const d of ['base-uri', 'form-action', 'font-src', 'worker-src', 'manifest-src', 'media-src']) {
      expect(directives.get(d), d).toEqual(["'self'"]);
    }
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
  });

  it('security headers, one origin for /v1, /ws, the webhook and health; /metrics never proxied', () => {
    expect(caddy).toContain('Strict-Transport-Security "max-age=31536000; includeSubDomains"');
    expect(caddy).toContain('Referrer-Policy "no-referrer"');
    expect(caddy).toContain('Permissions-Policy "geolocation=(), microphone=(), camera=(self), payment=()"');
    expect(caddy).toContain('X-Frame-Options "DENY"');
    expect(caddy).toContain('X-Content-Type-Options "nosniff"');
    expect(caddy).toMatch(/@api path \/v1 \/v1\/\* \/ws \/ws\/\* \/health\/live \/health\/ready/);
    expect(caddy).toMatch(/handle \/webhooks\/whatsapp \{[^}]*max_size 4MB/s);
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
    for (const p of ['hub.verify_token', 'X-Amz-Signature', 'X-Amz-Credential', 'X-Amz-Security-Token']) {
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
    const published = [...compose.matchAll(/^\s+- '(\d+):(\d+)(\/udp)?'$/gm)].map((m) => m[0].trim());
    expect(published).toEqual(["- '80:80'", "- '443:443'", "- '443:443/udp'"]);
    expect(block('web')).toContain('ports:');
    expect(compose.match(/^\s+ports:/gm)).toHaveLength(1); // only web publishes anything
    expect(compose).not.toMatch(/^\s+expose:/m);
  });
});

#!/usr/bin/env node
/**
 * The two files that let `https://{CUSTOMER_LINK_DOMAIN}/app…` open the customer app (V2-052, DEC-566):
 * `/.well-known/apple-app-site-association` (iOS universal links) and `/.well-known/assetlinks.json` (Android App
 * Links, `autoVerify`). They name the app only — no secret — but need two values that exist once the store accounts
 * do, so they are rendered from the environment, never committed with guessed values:
 *
 *   APPLE_TEAM_ID=AB12CD34EF \
 *   ANDROID_CERT_SHA256=AA:BB:…:FF[,…]        # Play Console → App integrity → App signing key (and upload key)
 *   node apps/customer/scripts/well-known.mjs [outDir]   # default apps/customer/dist/well-known
 *
 * CUSTOMER_IOS_BUNDLE_ID / CUSTOMER_ANDROID_PACKAGE default to `sa.point.app` like app.config.ts (DEC-565).
 * Serve both over HTTPS on the link domain itself, with `Content-Type: application/json` and no redirect
 * (docs/v2/store/RELEASE_CHECKLIST.md §5 has the Caddy snippet).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Same prefix as app.config.ts CUSTOMER_LINK_PATH_PREFIX and src/features/links.ts APP_LINK_PREFIX. */
const PREFIX = '/app';

export function appleAppSiteAssociation({ teamId, bundleId }) {
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error('APPLE_TEAM_ID must be the 10-character Apple team id');
  return {
    applinks: {
      details: [
        {
          appIDs: [`${teamId}.${bundleId}`],
          components: [
            { '/': PREFIX, comment: 'the app entry (journey R1 continues where it stopped)' },
            { '/': `${PREFIX}/*`, comment: 'everything under /app (src/features/links.ts)' },
          ],
        },
      ],
    },
  };
}

export function assetLinks({ androidPackage, fingerprints }) {
  const list = fingerprints.map((f) => f.trim().toUpperCase()).filter(Boolean);
  if (list.length === 0)
    throw new Error('ANDROID_CERT_SHA256 needs at least one SHA-256 certificate fingerprint');
  for (const f of list) {
    if (!/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(f)) throw new Error(`not a SHA-256 fingerprint: ${f}`);
  }
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: androidPackage, sha256_cert_fingerprints: list },
    },
  ];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const out = resolve(process.argv[2] ?? join(appDir, 'dist', 'well-known'));
  const bundleId = process.env.CUSTOMER_IOS_BUNDLE_ID?.trim() || 'sa.point.app';
  const androidPackage = process.env.CUSTOMER_ANDROID_PACKAGE?.trim() || 'sa.point.app';
  const aasa = appleAppSiteAssociation({ teamId: process.env.APPLE_TEAM_ID?.trim() ?? '', bundleId });
  const links = assetLinks({
    androidPackage,
    fingerprints: (process.env.ANDROID_CERT_SHA256 ?? '').split(','),
  });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'apple-app-site-association'), `${JSON.stringify(aasa, null, 2)}\n`);
  writeFileSync(join(out, 'assetlinks.json'), `${JSON.stringify(links, null, 2)}\n`);
  process.stdout.write(`written to ${out}: apple-app-site-association, assetlinks.json\n`);
}

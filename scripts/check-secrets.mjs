// PNT-096 secrets scan (05 §10 «فحص الأسرار في المستودع», 17 §10 «الأسرار»), run by `pnpm lint`:
//   1. no secret-bearing file in the repository: .env files, private keys, keystores, database dumps, backups,
//      delivery archives (CLAUDE.md §8);
//   2. no credential in any tracked text file: private key blocks, age identities, cloud/API tokens,
//      server secrets written as KEY=<value>;
//   3. the built web bundle (apps/web/dist, when present) carries no secret and no server-only variable
//      name (05 §7.7: only VITE_* values are public).
// usage: node scripts/check-secrets.mjs [--root <dir>]   (--root scans a plain directory instead of git ls-files)
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Files that must never be committed, by path. */
const FORBIDDEN_PATHS = [
  [/(^|\/)\.env(\.[^/]*)?$/, 'environment file (only .env.example is allowed)'],
  [/\.(pem|key|p12|pfx|jks|keystore|ppk)$/i, 'key or certificate store'],
  [/(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/, 'SSH key'],
  [/\.(age|gpg|asc|dump|backup|bak|sql\.gz|pgdump)$/i, 'encrypted backup or database dump'],
  [/\.zip$/i, 'delivery archive'],
];
const ALLOWED_PATHS = [/(^|\/)\.env\.example$/];

/** Credential formats (value patterns); each match is a finding unless listed in ALLOWED_VALUES. */
const PATTERNS = [
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/, 'private key block'],
  [/AGE-SECRET-KEY-1[0-9A-Z]{58}/, 'age identity (backup decryption key)'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{60,}\b/, 'GitHub fine-grained token'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, 'Slack token'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key'],
  [/\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/, 'Stripe live key'],
  [/\bEAA[A-Za-z0-9]{80,}\b/, 'Meta (WhatsApp Cloud API) access token'],
  [
    /postgres(?:ql)?:\/\/[^:\s/@'"]+:(?!postgres@|point@|secret@|password@|\$|\{|<)[^@\s'"]{12,}@/,
    'database URL with a password',
  ],
];

/** Server secrets (05 §10) written with a literal value: `NAME=value` or `NAME: value` (≥ 16 characters). */
const SECRET_NAMES = [
  'SESSION_SECRET',
  'CODE_PEPPER',
  'AUTH_SECRET_PEPPER',
  'DATA_ENCRYPTION_KEY',
  'WA_ACCESS_TOKEN',
  'WA_APP_SECRET',
  'WA_VERIFY_TOKEN',
  'VAPID_PRIVATE_KEY',
  'S3_SECRET_ACCESS_KEY',
  'BACKUP_PASSPHRASE',
  'AWS_SECRET_ACCESS_KEY',
  'MINIO_ROOT_PASSWORD',
];
const ASSIGNMENT = new RegExp(
  `(?:^|[\\s'"{])(${SECRET_NAMES.join('|')})\\s*[:=]\\s*['"]?([A-Za-z0-9+/=_.~-]{16,})['"]?\\s*$`,
);

/**
 * Values that look like secrets but are published test/development data, each with its reason:
 * the dev-only data key of the seed (DEC-57) and the fixed local defaults of the dev compose file.
 */
const ALLOWED_VALUES = [
  'J0fYaXmFXs1TdlfW/n9DaIpgvRF/ntOunEAKS7scTFg=', // DEV_DATA_ENCRYPTION_KEY, published dev-only key (DEC-57)
];

/** Server-only variable names that must not reach the browser bundle (05 §7.7). */
const SERVER_ONLY_NAMES = [...SECRET_NAMES, 'DATABASE_URL', 'S3_ACCESS_KEY_ID', 'WA_APP_SECRET_REF'];

const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|avif|ico|pdf|woff2?|ttf|otf|eot|mp3|mp4|wav|ogg|zip|gz|tgz|br|zst)$/i;
const SKIP = [/(^|\/)pnpm-lock\.yaml$/, /(^|\/)node_modules\//, /(^|\/)\.git\//];

/** Findings for one path (name rules only). */
export function pathFindings(path) {
  if (ALLOWED_PATHS.some((re) => re.test(path))) return [];
  return FORBIDDEN_PATHS.filter(([re]) => re.test(path)).map(
    ([, what]) => `${path}: ${what} must not be committed`,
  );
}

/** Findings for one file's text. `bundle` adds the server-only name rule (web build output). */
export function textFindings(path, text, { bundle = false } = {}) {
  const out = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const [re, what] of PATTERNS) {
      const m = re.exec(line);
      if (m && !ALLOWED_VALUES.some((v) => m[0].includes(v))) out.push(`${path}:${i + 1}: ${what}`);
    }
    const a = ASSIGNMENT.exec(line);
    if (a && !ALLOWED_VALUES.includes(a[2]) && !/^(?:env|sm):\/\//.test(a[2])) {
      out.push(`${path}:${i + 1}: ${a[1]} has a literal value`);
    }
    if (bundle) {
      for (const n of SERVER_ONLY_NAMES) {
        if (new RegExp(`\\b${n}\\b`).test(line))
          out.push(`${path}:${i + 1}: server-only name ${n} in the web bundle`);
      }
    }
  });
  return out;
}

/** Any file that is not a known binary format and has no NUL byte in its first 8 KB is read as text. */
function readText(full, path) {
  if (BINARY_EXT.test(path)) return null;
  let buf;
  try {
    if (statSync(full).size > 2_000_000) return null;
    buf = readFileSync(full);
  } catch {
    return null; // deleted in the working tree
  }
  if (buf.subarray(0, 8192).includes(0)) return null;
  return buf.toString('utf8');
}

function walk(dir, root = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(root, full).split(sep).join('/');
    if (SKIP.some((re) => re.test(rel + (statSync(full).isDirectory() ? '/' : '')))) continue;
    if (statSync(full).isDirectory()) out.push(...walk(full, root));
    else out.push(rel);
  }
  return out;
}

export function scan({ root, files, bundleDir }) {
  const findings = [];
  for (const f of files) {
    if (SKIP.some((re) => re.test(f))) continue;
    findings.push(...pathFindings(f));
    const text = readText(join(root, f), f);
    if (text !== null) findings.push(...textFindings(f, text));
  }
  if (bundleDir && existsSync(join(root, bundleDir))) {
    // no build yet → nothing to check
    for (const f of walk(join(root, bundleDir)).filter((x) => /\.(m?js|html|css|webmanifest)$/.test(x))) {
      const text = readFileSync(join(root, bundleDir, f), 'utf8');
      findings.push(...textFindings(`${bundleDir}/${f}`, text, { bundle: true }));
    }
  }
  return findings;
}

function main() {
  const args = process.argv.slice(2);
  const rootArg = args.indexOf('--root');
  const root = rootArg >= 0 ? args[rootArg + 1] : fileURLToPath(new URL('..', import.meta.url));
  const files =
    rootArg >= 0
      ? walk(root)
      : execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
          .split('\n')
          .filter(Boolean);
  const findings = scan({ root, files, bundleDir: 'apps/web/dist' });
  if (findings.length) {
    console.error(`secrets check: ${findings.length} finding(s)\n  ${findings.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`secrets check: ok (${files.length} files)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

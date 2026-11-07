// PNT-001 AC3: the brand names come from settings (canon §1). They may appear only in
// default-config files, docs and brand assets. Since V2-D01 (DEC-470) the customer brand defaults to
// «بوينت» and «مصاف» is an operator company (a database name, never a code literal); both stay
// forbidden in code. The WhatsApp customer copy carries the `{brand}` token (wa-templates.ts) and the
// simulator's template fixture does too, so neither is an allowed file any more.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const NAMES = ['بوينت', 'مصاف'];
const ALLOWED = [
  /^docs\//,
  /^brand\//,
  /^README\.md$/,
  /^CLAUDE\.md$/,
  /^PROMPT_FOR_CLAUDE_CODE\.md$/,
  /^\.env\.example$/,
  /^tools\/progress\//,
  /^scripts\/check-brand\.mjs$/,
  /^packages\/db\/migrations\//, // docs/06_schema.sql verbatim (comments)
  /^packages\/db\/src\/schema\/schema\.ts$/, // generated from the migrated database
  /^packages\/shared\/src\/canon\/brand-defaults\.ts$/,
  /^tools\/wa-simulator\/fixtures\/brand\.json$/,
  /^apps\/web\/public\/manifest\.webmanifest$/,
  /^apps\/web\/index\.html$/,
  /\.test\.ts$/,
  /\.spec\.ts$/,
];
const files = execSync('git ls-files -co --exclude-standard', { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
const bad = [];
for (const f of files) {
  if (ALLOWED.some((re) => re.test(f))) continue;
  if (/\.(png|jpg|jpeg|ico|pdf|woff2?|mp3|zip|lock|yaml)$/.test(f) && !f.endsWith('.yaml')) continue;
  let text;
  try {
    text = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  for (const n of NAMES) if (text.includes(n)) bad.push(`${f}: contains «${n}»`);
}
if (bad.length) {
  console.error('Brand names must come from settings (canon §1):\n' + bad.join('\n'));
  process.exit(1);
}
console.log('brand check: ok');

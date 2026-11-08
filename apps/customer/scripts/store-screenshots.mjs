#!/usr/bin/env node
/**
 * Store screenshots of the customer app (V2-052, DEC-568; plan in docs/v2/store/SCREENSHOTS.md).
 *
 *   pnpm --filter @point/customer run store:screenshots            # export + capture, both languages
 *   pnpm --filter @point/customer run store:screenshots -- --skip-export --locale ar --device iphone-6.9
 *
 * 1. Builds the one web export of the app (`pnpm run export:web`: `CUSTOMER_WEB_EXPORT=1`, the in-app fake backend,
 *    `--clear`; the same build the e2e suite runs, DEC-550 / DEC-568) into dist-web/ (gitignored).
 * 2. Serves it on 127.0.0.1 and drives journey R1 with Playwright on the demo phone of the fake backend
 *    (0500000099: a visit in progress), then the screens of the plan, in Arabic and English.
 * 3. Writes PNGs at the exact pixel sizes of the stores to apps/customer/store-screenshots/<locale>/<device>/
 *    (gitignored: the owner reviews them before any upload).
 *
 * Nothing leaves the machine: the fake backend runs in the page, nothing is sent to WhatsApp, Moyasar or Expo.
 * Playwright is this app's @playwright/test (the e2e suite's), else a global install or apps/web's; the browser is
 * PW_CHROMIUM_PATH, /opt/pw-browsers/chromium, or Playwright's own (never installed by this script).
 * The pictures are web renderings of the React Native screens (same components, fonts and tokens), without the
 * native status bar: docs/v2/store/SCREENSHOTS.md says when real-device captures should replace them.
 */
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webDir = join(appDir, 'dist-web');
const outDir = join(appDir, 'store-screenshots');

/**
 * Pixel sizes accepted by the stores (portrait). Points × scale = pixels. Apple: 6.9" 1320×2868 (Dynamic Island,
 * large), 6.3" 1206×2622 (Dynamic Island, medium), 6.5" 1284×2778, 5.5" 1242×2208 — Apple's specification page as
 * read on 2026-11-08. Google Play phone: 1080×1920 (9:16; the long side at most twice the short one). Verify both
 * consoles at upload time (docs/v2/store/SCREENSHOTS.md §2).
 */
export const DEVICES = {
  'iphone-6.9': { width: 440, height: 956, scale: 3, pixels: '1320x2868' },
  'iphone-6.3': { width: 402, height: 874, scale: 3, pixels: '1206x2622' },
  'iphone-6.5': { width: 428, height: 926, scale: 3, pixels: '1284x2778' },
  'iphone-5.5': { width: 414, height: 736, scale: 3, pixels: '1242x2208' },
  'android-phone': { width: 360, height: 640, scale: 3, pixels: '1080x1920' },
};
export const LOCALES = { ar: 'ar-SA', en: 'en-US' };
/** The fake backend's demo number (apps/customer/src/api/index.ts DEMO_VISIT_PHONES): a visit in progress. */
const DEMO_PHONE = '0500000099';
const DEMO_NAME = { ar: 'سارة', en: 'Sarah' };

function args(argv) {
  const out = { skipExport: false, locales: Object.keys(LOCALES), devices: Object.keys(DEVICES) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--skip-export') out.skipExport = true;
    else if (a === '--locale') out.locales = [argv[++i]];
    else if (a === '--device') out.devices = [argv[++i]];
    else if (a !== '--') throw new Error(`unknown argument ${a}`);
  }
  for (const l of out.locales)
    if (!(l in LOCALES)) throw new Error(`--locale must be one of ${Object.keys(LOCALES)}`);
  for (const d of out.devices)
    if (!(d in DEVICES)) throw new Error(`--device must be one of ${Object.keys(DEVICES)}`);
  return out;
}

function exportWeb() {
  rmSync(webDir, { recursive: true, force: true });
  const env = { ...process.env };
  delete env.CUSTOMER_API_BASE_URL;
  delete env.CUSTOMER_FORCE_LOCALE;
  const r = spawnSync('pnpm', ['run', 'export:web'], { cwd: appDir, env, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('pnpm run export:web failed');
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
};

/** A static server for the export: files as they are, every other path → index.html (client-side routes). */
function serve(root) {
  const server = createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let file = normalize(join(root, url));
    if (!file.startsWith(root + sep) || !existsSync(file) || statSync(file).isDirectory()) {
      file = join(root, 'index.html');
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

async function loadPlaywright() {
  const candidates = [
    () => createRequire(join(appDir, 'package.json'))('@playwright/test'),
    () => import('playwright'),
    () => createRequire(join(appDir, '..', 'web', 'package.json'))('@playwright/test'),
    () => createRequire(join(process.env.NODE_PATH ?? '/usr/lib/node_modules', 'x'))('playwright'),
  ];
  for (const c of candidates) {
    try {
      const m = await c();
      if (m?.chromium) return m;
    } catch {
      // next candidate
    }
  }
  throw new Error(
    'Playwright not found: install it globally or run pnpm install (apps/web has @playwright/test)',
  );
}

function chromiumPath() {
  if (process.env.PW_CHROMIUM_PATH) return process.env.PW_CHROMIUM_PATH;
  return existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
}

/** Waits until the fake backend's answers are on screen (its latency is 300 ms) and the fonts have loaded. */
async function settle(page) {
  await page.waitForLoadState('networkidle');
  // runs in the page, where `document` exists
  await page.evaluate(() => globalThis.document.fonts.ready);
  await page.waitForTimeout(900);
}

async function capture(browser, base, locale, deviceName) {
  const d = DEVICES[deviceName];
  const dir = join(outDir, locale, deviceName);
  mkdirSync(dir, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: d.width, height: d.height },
    deviceScaleFactor: d.scale,
    isMobile: true,
    hasTouch: true,
    locale: LOCALES[locale],
    timezoneId: 'Asia/Riyadh',
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  try {
    await journey(page, locale, deviceName, base, dir);
  } catch (e) {
    await page.screenshot({ path: join(dir, 'failed.png') }).catch(() => {});
    throw e;
  } finally {
    await context.close();
  }
}

async function journey(page, locale, deviceName, base, dir) {
  const errors = [];
  page.on('pageerror', (e) => {
    errors.push(e.message);
    process.stderr.write(`  page error: ${e.message}\n`);
  });
  const shot = async (name) => {
    await settle(page);
    await page.screenshot({ path: join(dir, `${name}.png`), fullPage: false });
    process.stdout.write(`  ${locale}/${deviceName}/${name}.png\n`);
  };

  // C-01 welcome
  await page.goto(`${base}/`);
  await page.getByTestId('welcome-start').waitFor();
  await shot('06-welcome');

  // R1 on the demo number: C-02 → C-03 (the code from the simulated inbox) → C-04 → C-05 skipped → C-06
  await page.getByTestId('welcome-start').click();
  await page.getByRole('textbox').first().fill(DEMO_PHONE);
  await page.getByTestId('phone-submit').click();
  await page.getByTestId('otp-submit').waitFor();
  await settle(page);
  const code = (await page.locator('body').innerText()).match(/\b(\d{6})\b/)?.[1];
  if (!code) throw new Error('no simulated code on C-03');
  await page.getByRole('textbox').first().fill(code);
  await page.getByTestId('otp-submit').click();
  await page.getByTestId('profile-submit').waitFor();
  await page.getByRole('textbox').first().fill(DEMO_NAME[locale]);
  const boxes = page.getByRole('checkbox');
  await boxes.nth(0).click();
  await boxes.nth(1).click();
  await page.getByTestId('profile-submit').click();
  // C-05: a fictional plate and car, so C-06, C-11 and C-09 show one (the store pictures never carry a real plate)
  await page.getByTestId('vehicle-submit').filter({ visible: true }).waitFor();
  await page.getByRole('textbox').filter({ visible: true }).first().fill('4827');
  for (const letter of ['ر', 'س', 'ن']) {
    await page
      .getByRole('button', { name: new RegExp(`^${letter} `) })
      .filter({ visible: true })
      .click();
  }
  const groups = page.getByRole('radiogroup').filter({ visible: true });
  await groups.nth(0).getByRole('radio').first().click(); // make
  await groups.nth(1).getByRole('radio').first().click(); // colour
  await groups.nth(2).getByRole('radio').first().click(); // type
  await page.getByTestId('vehicle-submit').filter({ visible: true }).click();
  await page.getByTestId('home-pass').filter({ visible: true }).waitFor();
  await shot('01-home');

  await page.getByTestId('home-visit').filter({ visible: true }).click();
  await page.waitForURL(/\/visit\//);
  await shot('02-visit-live');
  await page.goBack();

  await page.getByTestId('home-pass').filter({ visible: true }).click();
  await page.getByTestId('pass-qr').filter({ visible: true }).waitFor();
  await shot('03-entry-pass');
  await page.goBack();

  await page.getByTestId('home-locations').filter({ visible: true }).click();
  await page.waitForURL(/\/locations/);
  await shot('04-locations');

  // C-08 of the first location that sells a subscription (filter «يقبل الاشتراك», the third chip), then C-09.
  // Expo Router keeps the screens below in the page (hidden): only visible elements are clicked.
  await page.getByRole('radio').filter({ visible: true }).nth(2).click();
  await settle(page);
  // a location row carries its price (digits); the header's back button and «فتح في الخرائط» do not
  const rows = page.locator('[role="button"]', { hasText: /\d/ }).filter({ visible: true });
  const count = await rows.count();
  let opened = false;
  for (let i = 0; i < count && !opened; i++) {
    await rows.nth(i).click();
    await page.waitForTimeout(400);
    if (/\/location\//.test(page.url())) {
      await settle(page);
      if ((await page.getByTestId('location-subscribe').filter({ visible: true }).count()) > 0) opened = true;
      else await page.goBack();
    }
  }
  if (opened) {
    await shot('05-location');
    await page.getByTestId('location-subscribe').filter({ visible: true }).click();
    await page.getByTestId('subscribe-pay').filter({ visible: true }).waitFor();
    await settle(page);
    // C-09 opens with no plan and the account's only car already chosen: tick the first plan
    await page.getByRole('checkbox').filter({ visible: true }).first().click();
    await shot('07-subscribe');
  } else {
    process.stdout.write('  (no location with a subscription in the fake data: C-08/C-09 skipped)\n');
  }

  if (errors.length) throw new Error(`page errors on ${locale}/${deviceName}: ${errors.join(' | ')}`);
}

async function main() {
  const opts = args(process.argv.slice(2));
  if (!opts.skipExport || !existsSync(join(webDir, 'index.html'))) exportWeb();
  const server = await serve(webDir);
  const base = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = await loadPlaywright();
  const executablePath = chromiumPath();
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  try {
    for (const locale of opts.locales) {
      for (const device of opts.devices) await capture(browser, base, locale, device);
    }
  } finally {
    await browser.close();
    server.close();
  }
  process.stdout.write(`screenshots in ${outDir}\n`);
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.stack : e}\n`);
  process.exit(1);
});

/**
 * Shared steps of the customer app e2e (V2-018, DEC-550 … DEC-552). The copy comes from src/i18n/ar.ts (never
 * retyped here), the brand from the documented default (the export is built without `BRAND_*`, DEC-480), and the
 * sign-in code from the fake backend's simulated WhatsApp inbox shown under «وضع التطوير» on C-03.
 */
import { expect, test as base, type Locator, type Page } from '@playwright/test';
import { CUSTOMER_APP_BRAND_DEFAULTS } from '../../../../packages/shared/src/canon/brand-defaults.ts';
import { ar } from '../../src/i18n/ar.ts';
import { en } from '../../src/i18n/en.ts';

export { ar, en, expect };

export const brand = CUSTOMER_APP_BRAND_DEFAULTS.BRAND_CUSTOMER_APP_NAME_AR;

/** The fake backend gives this number a visit in progress at a pay-per-visit location (README «الخادم الوهمي»). */
export const DEMO_VISIT_PHONE = '0500000099';

/** Simulator cards of the fake gateway (README «الدفع للزيارة»). */
export const CARD_OK = '4111111111111111';

/** A fresh Saudi mobile per test (each test also gets its own in-page fake backend). */
export function freshPhone(): string {
  return `051${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A template of ar.ts (`{brand}` filled, other `{placeholders}` matching any value) as a RegExp: values inside
 * sentences are wrapped in Unicode isolates (03 §2.9), so they are matched loosely.
 */
export function tpl(template: string, values: Readonly<Record<string, string | number>> = {}): RegExp {
  const isolated = (value: string) => `[\\u2066-\\u2069]?${escape(value)}[\\u2066-\\u2069]?`;
  // split with a capture group: even items are literal text, odd items the placeholder names
  const source = template
    .split(/\{(\w+)\}/)
    .map((part, i) => {
      if (i % 2 === 0) return escape(part);
      if (part === 'brand') return isolated(brand);
      return Object.hasOwn(values, part) ? isolated(String(values[part])) : '.+?';
    })
    .join('');
  return new RegExp(source);
}

/** Exact visible text (a button, a title) by role or text. */
export const button = (page: Page, name: string | RegExp) =>
  page.getByRole('button', { name: typeof name === 'string' ? exact(name) : name });

const exact = (s: string) => new RegExp(`^\\s*${escape(s)}\\s*$`);

/**
 * expo-router keeps the screens below the top of the stack in the page (hidden): text queries pick the visible one.
 * Role queries skip hidden elements by themselves.
 */
export const shown = (locator: Locator): Locator => locator.filter({ visible: true }).first();

export const heading = (page: Page, name: string | RegExp) =>
  page.getByRole('heading', { name: typeof name === 'string' ? exact(name) : name });

/**
 * The layout checks every screen of the suite passes (17 H-06 for the customer app): Arabic, right to left, and
 * nothing wider than the phone.
 */
export async function expectRtlPhone(page: Page): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  const overflow = await page.evaluate(() => {
    const width = window.innerWidth;
    // inside a horizontal scroller (C-08 photos) content may run past the edge; the scroller itself may not
    const scroll = new Set(['auto', 'scroll']);
    const clipped = (el: HTMLElement): boolean => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (!scroll.has(cs.overflowX) || scroll.has(cs.overflowY)) continue;
        const r = p.getBoundingClientRect();
        return r.left >= -1 && r.right <= width + 1;
      }
      return false;
    };
    // a decoration hidden from screen readers may bleed out of a box that clips it (the C-06 hero's circle, DEC-580);
    // that box itself must stay on screen
    const decoration = (el: HTMLElement): boolean => {
      if (!el.closest('[aria-hidden="true"]')) return false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (getComputedStyle(p).overflow !== 'hidden') continue;
        const r = p.getBoundingClientRect();
        return r.left >= -1 && r.right <= width + 1;
      }
      return false;
    };
    const wide: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('#root *'))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if ((r.right > width + 1 || r.left < -1) && !clipped(el) && !decoration(el))
        wide.push(
          `${el.tagName} ${Math.round(r.left)}…${Math.round(r.right)} ${el.textContent?.slice(0, 30) ?? ''}`,
        );
    }
    return { width, wide: wide.slice(0, 5) };
  });
  expect(overflow.wide, `elements outside a ${overflow.width}px screen`).toEqual([]);
  // Arabic text starts on the right: never pinned to the left edge (DEC-551, `textStart`)
  const leftArabic = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('#root [dir="auto"]'))
      .filter((el) => el.getBoundingClientRect().width > 0 && /^[؀-ۿ]/.test(el.textContent ?? ''))
      .filter((el) => getComputedStyle(el).textAlign === 'left')
      .map((el) => (el.textContent ?? '').slice(0, 30))
      .slice(0, 5),
  );
  expect(leftArabic, 'Arabic text aligned to the left').toEqual([]);
}

/**
 * Every test starts on a fresh install: the fake backend and the device storage live in the page (DEC-551).
 * The browser clock is installed so the live visit can be moved forward like the driver would (C-12).
 */
export const test = base.extend<{ app: Page }>({
  app: async ({ page }, use) => {
    await page.clock.install();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await use(page);
    expect(errors, 'uncaught errors in the app').toEqual([]);
  },
});

/** R1 (C-01 … C-04) through the sign-in; returns on C-05 (a new account without a vehicle). */
export async function signUp(page: Page, opts: { phone?: string; name?: string } = {}): Promise<void> {
  const phone = opts.phone ?? freshPhone();
  await expect(heading(page, tpl(ar.welcome.title))).toBeVisible();
  await button(page, ar.welcome.start).click();

  await expect(heading(page, ar.phone.title)).toBeVisible();
  await page.getByLabel(ar.phone.label, { exact: true }).fill(phone.slice(1));
  await button(page, ar.phone.submit).click();

  await expect(heading(page, ar.otp.title)).toBeVisible();
  const code = await devCode(page);
  await page.getByLabel(ar.otp.label, { exact: true }).fill(code);
  await button(page, ar.otp.submit).click();

  await expect(heading(page, ar.profile.title)).toBeVisible();
  await page.getByLabel(ar.profile.nameLabel, { exact: true }).fill(opts.name ?? 'سارة');
  await page.getByRole('checkbox', { name: ar.profile.terms }).click();
  await page.getByRole('checkbox', { name: ar.profile.privacy }).click();
  await button(page, ar.profile.submit).click();
}

/** The code the fake backend «sent on WhatsApp», shown on C-03 in development only. */
export async function devCode(page: Page): Promise<string> {
  const line = page.getByText(tpl(ar.otp.devCode));
  await expect(line).toBeVisible();
  const match = /(\d{6})/.exec((await line.innerText()) ?? '');
  if (!match) throw new Error('no development code on C-03');
  return match[1] as string;
}

/** C-05: a plate (digits + three letters, by their Latin key «ا A»), a make and a colour from the chips. */
export async function addVehicle(page: Page, digits = '1234', letters = ['A', 'B', 'D']): Promise<void> {
  await expect(heading(page, ar.vehicle.title)).toBeVisible();
  await page.getByLabel(ar.vehicle.digits, { exact: true }).fill(digits);
  for (const l of letters) await page.getByRole('button', { name: new RegExp(`^\\S ${l}$`) }).click();
  await chip(page, ar.vehicle.make, 0).click();
  await chip(page, ar.vehicle.color, 0).click();
  await button(page, ar.vehicle.submit).click();
}

/** The `index`-th option of a ChoiceChips group. */
export function chip(page: Page, group: string, index: number): Locator {
  return page.getByRole('radiogroup', { name: group }).getByRole('radio').nth(index);
}

/**
 * C-06 reached and drawn (V2-UX option B, DEC-580 … DEC-582): the hero's title, the «بطاقة الدخول» chip (and the
 * card's own button without a visit), and the tab bar on «الرئيسية».
 */
export async function expectHome(page: Page): Promise<void> {
  await expect(passButton(page)).toBeVisible();
  await expect(tab(page, ar.tabs.home)).toHaveAttribute('aria-selected', 'true');
  await expectRtlPhone(page);
}

/** «بطاقة الدخول» on C-06: the card's button without a visit, else the chip (the first visible one). */
export const passButton = (page: Page): Locator =>
  page.getByRole('button', { name: ar.home.pass, exact: true }).filter({ visible: true }).first();

/** A tab of the bottom bar (DEC-582). */
export const tab = (page: Page, name: string): Locator => page.getByRole('tab', { name, exact: true });

/**
 * A real drag of the swipe-to-request knob (DEC-583): mouse down on the knob, moved in steps toward the far edge of
 * the track (right to left in Arabic) — all the way, or `fraction` of it — and released.
 */
export async function swipeToRequest(page: Page, fraction = 1): Promise<void> {
  const control = page.getByTestId('request-car-swipe').filter({ visible: true });
  const knob = page.getByTestId('request-car-swipe-knob').filter({ visible: true });
  await expect(knob).toBeVisible();
  const k = await knob.boundingBox();
  const t = await control.boundingBox();
  if (!k || !t) throw new Error('the swipe control is not on screen');
  const rtl = (await page.locator('html').getAttribute('dir')) === 'rtl';
  const x0 = k.x + k.width / 2;
  const y = k.y + k.height / 2;
  const end = rtl ? t.x + k.width / 2 : t.x + t.width - k.width / 2;
  const x1 = x0 + (end - x0) * fraction;
  await page.mouse.move(x0, y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / 12, y);
  await page.mouse.up();
}

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

  // C-04 (option 4, DEC-637): «ابدأ» is the consent to the terms and the privacy policy
  await expect(heading(page, ar.profile.title)).toBeVisible();
  await page.getByLabel(ar.profile.nameLabel, { exact: true }).fill(opts.name ?? 'سارة');
  await expect(page.getByRole('link', { name: ar.profile.agree.terms, exact: true })).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: `${ar.profile.marketing} (${ar.common.optional})` }),
  ).not.toBeChecked();
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
/**
 * C-05 (option 3, DEC-638): step 1 the plate (digits, and the letters typed on the phone's keyboard in Latin), step
 * 2 the type tile, the first colour swatch and the first make of the list.
 */
export async function addVehicle(page: Page, digits = '1234', letters = ['A', 'B', 'D']): Promise<void> {
  await expect(heading(page, ar.vehicle.title)).toBeVisible();
  await page.getByLabel(ar.vehicle.digits, { exact: true }).fill(digits);
  await page.getByLabel(ar.vehicle.letters, { exact: true }).fill(letters.join(''));
  await button(page, ar.vehicle.next).click();
  await expect(heading(page, ar.vehicle.looksTitle)).toBeVisible();
  await page.getByTestId('vehicle-type-sedan').click();
  await chip(page, ar.vehicle.color, 0).click();
  await page.getByTestId('vehicle-make').click();
  await page.getByTestId('vehicle-make-toyota').click();
  await button(page, ar.vehicle.submit).click();
}

/** The `index`-th option of a ChoiceChips group. */
export function chip(page: Page, group: string, index: number): Locator {
  return page.getByRole('radiogroup', { name: group }).getByRole('radio').nth(index);
}

/**
 * C-06 reached and drawn (V2-UX option A «زر واحد», DEC-620): the circle, the account button of the top bar and the
 * shortcuts; no tab bar (DEC-626).
 */
export async function expectHome(page: Page): Promise<void> {
  await expect(page.getByTestId('home-circle').filter({ visible: true })).toBeVisible();
  await expect(page.getByTestId('home-account').filter({ visible: true })).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(0);
  await expectRtlPhone(page);
}

/** «بطاقة الدخول» on C-06: the circle without a visit (the first visible one). */
export const passButton = (page: Page): Locator =>
  page.getByRole('button', { name: ar.home.pass, exact: true }).filter({ visible: true }).first();

/** C-19 from the account button of C-06's top bar (DEC-626). */
export async function openAccount(page: Page): Promise<void> {
  await page.getByTestId('home-account').filter({ visible: true }).click();
  await expect(heading(page, ar.settings.title)).toBeVisible();
}

/**
 * A real hold of the circle that requests the car (DEC-621): the mouse goes down on the circle (`request-car-hold`,
 * on C-06 or in the C-12 sheet), stays there `ms` milliseconds (the request needs 3000) and comes up.
 */
export async function holdToRequest(page: Page, ms = 3200): Promise<void> {
  const circle = page.getByTestId('request-car-hold').filter({ visible: true });
  await expect(circle).toBeVisible();
  const box = await circle.boundingBox();
  if (!box) throw new Error('the hold circle is not on screen');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

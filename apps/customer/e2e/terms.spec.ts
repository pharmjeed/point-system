/**
 * C-24 «الشروط والأحكام» (DEC-614 … DEC-618): reached from «حسابي» (C-19) and from the consent line of C-09; the
 * version and the last update at the top, the table of contents jumping to a section, the sticky bar naming the
 * section being read, «أعلى الصفحة», and — from a plan — the plan's own values in the clauses. `ANNEX_SHOTS=<dir>`
 * also saves the screens (390 px only).
 */
import type { Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderTerms } from '../src/legal/terms.ts';
import { termsAr } from '../src/legal/terms.ar.ts';
import { isolate } from '../src/i18n/index.ts';
import {
  addVehicle,
  ar,
  brand,
  button,
  expect,
  expectHome,
  expectRtlPhone,
  heading,
  shown,
  signUp,
  openAccount,
  test,
  tpl,
} from './support/app';

const terms = renderTerms(termsAr, brand, termsAr.generic, isolate);
const section = (id: string) => terms.sections.find((s) => s.id === id)!;
const shots = process.env.ANNEX_SHOTS;

async function shot(page: Page, name: string) {
  if (!shots || page.viewportSize()?.width !== 390) return;
  mkdirSync(shots, { recursive: true });
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

const visibleTestId = (page: Page, id: string) => page.getByTestId(id).filter({ visible: true }).first();

test('C-24 from «حسابي»: the version, the contents jump to a section, the sticky bar, back to the top', async ({
  app: page,
}) => {
  await signUp(page);
  await button(page, ar.vehicle.skip).click();
  await expectHome(page);
  await openAccount(page);
  await visibleTestId(page, 'settings-terms').click();

  await expect(heading(page, ar.terms.title)).toBeVisible();
  await expect(shown(page.getByText(terms.updated, { exact: true }))).toBeVisible();
  await expect(shown(page.getByText(terms.contents, { exact: true }))).toBeVisible();
  // every section is in the contents
  for (const s of terms.sections) await expect(visibleTestId(page, `terms-toc-${s.id}`)).toBeVisible();
  await expectRtlPhone(page);
  await shot(page, '6-terms-top-contents');

  // the contents jump: «8. التجميد» comes into view and the sticky bar names it
  await visibleTestId(page, 'terms-toc-freeze').click();
  const freeze = heading(page, `${section('freeze').number}. ${section('freeze').title}`);
  await expect(freeze).toBeInViewport();
  await expect(visibleTestId(page, 'terms-current')).toHaveText(
    `${section('freeze').number}. ${section('freeze').title}`,
  );
  await expect(shown(page.getByText(section('freeze').clauses[0]!.text, { exact: true }))).toBeInViewport();
  await expectRtlPhone(page);
  await shot(page, '7-terms-section-freeze');

  // «المحتويات» in the sticky bar goes back to the table, «أعلى الصفحة» to the top
  await visibleTestId(page, 'terms-contents').click();
  await expect(visibleTestId(page, 'terms-toc-definitions')).toBeInViewport();
  await visibleTestId(page, 'terms-toc-law').click();
  await expect(heading(page, `${section('law').number}. ${section('law').title}`)).toBeInViewport();
  await visibleTestId(page, 'terms-top').click();
  await expect(heading(page, ar.terms.title)).toBeInViewport();

  await page.getByRole('button', { name: ar.common.back, exact: true }).filter({ visible: true }).click();
  await expect(heading(page, ar.settings.title)).toBeVisible();
});

test('C-24 from the C-09 consent line: the clauses carry the plan’s own values', async ({ app: page }) => {
  await signUp(page);
  await addVehicle(page, '4821', ['A', 'B', 'D']);
  await expectHome(page);
  await button(page, ar.home.allLocations).click();
  await page.getByLabel(ar.locations.searchLabel, { exact: true }).fill('الأفق');
  await page
    .getByRole('button', { name: /جامعة الأفق/ })
    .first()
    .click();
  await button(page, ar.subscribe.action).click();
  await page.getByRole('radiogroup', { name: ar.subscribe.plan }).getByRole('checkbox').first().click();

  // the consent: two separate boxes, and the link to the full terms (DEC-613)
  await expect(page.getByRole('checkbox', { name: ar.annex.consentTerms })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: ar.annex.consentNonRefund })).toBeVisible();
  await expectRtlPhone(page);
  await visibleTestId(page, 'subscribe-terms-link').click();

  await expect(heading(page, ar.terms.title)).toBeVisible();
  await expect(shown(page.getByText(tpl(ar.terms.planValues)))).toBeVisible();
  await visibleTestId(page, 'terms-toc-term').click();
  await expect(
    shown(page.getByText('مدة الدورة 22 يوم خدمة، تُحتسب من الأحد إلى الخميس ابتداءً من تاريخ التفعيل.')),
  ).toBeInViewport();
  await expectRtlPhone(page);

  await page.getByRole('button', { name: ar.common.back, exact: true }).filter({ visible: true }).click();
  await expect(page.getByTestId('subscribe-terms-link').filter({ visible: true })).toBeVisible();
});

import { expect, test, type Page } from '@playwright/test';

/** Functional specs run once, at the reference width 390 (17: G1 path at 390 px); layout specs at all widths. */
export function runOnlyAt390(): void {
  test.beforeEach(() => {
    test.skip(test.info().project.name !== 'mobile-390', 'functional flow: checked at 390 px only');
  });
}

/**
 * PNT-021 acceptance 1–2 and 17 TC-059/TC-060: no horizontal scroll, `lang="ar" dir="rtl"`, 16px base
 * font, inputs ≥16px (iOS zoom rule), every visible interactive element ≥44×44 px.
 */
export async function expectMobileLayout(page: Page) {
  const r = await page.evaluate(() => {
    const html = document.documentElement;
    const selector =
      'a[href], button, input, select, textarea, [role="button"], [role="radio"], [role="switch"], [role="tab"], [tabindex]:not([tabindex="-1"])';
    const small: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (el.closest('.pt-sr')) continue; // visually hidden helpers (file input inside a 4:3 tile, etc.)
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (rect.width < 44 - 0.5 || rect.height < 44 - 0.5) {
        small.push(
          `${el.tagName.toLowerCase()}.${el.className} "${(el.textContent ?? '').trim().slice(0, 30)}" ${Math.round(rect.width)}×${Math.round(rect.height)}`,
        );
      }
    }
    const smallInputs = Array.from(document.querySelectorAll<HTMLElement>('input, select, textarea'))
      .filter(
        (el) => getComputedStyle(el).display !== 'none' && parseFloat(getComputedStyle(el).fontSize) < 16,
      )
      .map((el) => `${el.id || el.tagName} ${getComputedStyle(el).fontSize}`);
    return {
      scrollWidth: html.scrollWidth,
      innerWidth: window.innerWidth,
      bodyScrollWidth: document.body.scrollWidth,
      lang: html.lang,
      dir: html.dir,
      htmlFont: getComputedStyle(html).fontSize,
      bodyFont: getComputedStyle(document.body).fontSize,
      small,
      smallInputs,
    };
  });
  expect(r.lang).toBe('ar');
  expect(r.dir).toBe('rtl');
  expect(r.scrollWidth, 'no horizontal scroll').toBeLessThanOrEqual(r.innerWidth);
  expect(r.bodyScrollWidth, 'no horizontal scroll (body)').toBeLessThanOrEqual(r.innerWidth);
  expect(r.htmlFont).toBe('16px');
  expect(r.bodyFont).toBe('16px');
  expect(r.smallInputs, 'input text ≥16px').toEqual([]);
  expect(r.small, 'touch targets ≥44px').toEqual([]);
}

/** Everything the app could have persisted in the browser (PNT-022 acceptance 2). */
export async function browserStorageDump(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const dump: Record<string, unknown> = {
      url: location.href,
      history: history.state,
      cookie: document.cookie,
      local: Object.fromEntries(Object.entries(localStorage)),
      session: Object.fromEntries(Object.entries(sessionStorage)),
      caches: 'caches' in window ? await caches.keys() : [],
      idb: [] as unknown[],
    };
    if ('databases' in indexedDB) {
      for (const info of await indexedDB.databases()) {
        if (!info.name) continue;
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open(info.name as string);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        for (const store of Array.from(db.objectStoreNames)) {
          const rows = await new Promise<unknown[]>((resolve) => {
            const req = db.transaction(store).objectStore(store).getAll();
            req.onsuccess = () => resolve(req.result as unknown[]);
            req.onerror = () => resolve([]);
          });
          (dump.idb as unknown[]).push({ db: info.name, store, rows });
        }
        db.close();
      }
    }
    return JSON.stringify(dump);
  });
}

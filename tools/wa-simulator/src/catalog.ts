import { readFileSync } from 'node:fs';
import type { TemplateButton, TemplateCategory, TemplateInfo, TemplateStatus } from './types.js';

// Brand names live only in fixtures/ (scripts/check-brand.mjs); the code reads them from there.
const FIXTURES = new URL('../fixtures/', import.meta.url);

interface FixtureTemplate {
  purpose: string;
  name: string;
  language: string;
  category: TemplateCategory;
  body: string;
  buttons: TemplateButton[];
}

export interface BrandFixture {
  customerNameAr: string;
  customerNameEn: string;
  linkCodePrefix: string;
  stopKeyword: string;
  requestButtonText: string;
}

function readFixture<T>(file: string): T {
  return JSON.parse(readFileSync(new URL(file, FIXTURES), 'utf8')) as T;
}

let brandCache: BrandFixture | undefined;

export function brand(env: Record<string, string | undefined> = process.env): BrandFixture {
  brandCache ??= readFixture<BrandFixture>('brand.json');
  const customerNameAr = env.BRAND_CUSTOMER_NAME_AR || brandCache.customerNameAr;
  return {
    ...brandCache,
    customerNameAr,
    customerNameEn: env.BRAND_CUSTOMER_NAME_EN || brandCache.customerNameEn,
    linkCodePrefix: withBrand(brandCache.linkCodePrefix, customerNameAr),
  };
}

/** `{brand}` of the fixtures = the Arabic customer name (DEC-470). */
export function withBrand(text: string, customerNameAr: string = brand().customerNameAr): string {
  return text.replaceAll('{brand}', customerNameAr);
}

/** Highest `{{n}}` index in a template body. */
export function countBodyParams(body: string): number {
  let max = 0;
  for (const m of body.matchAll(/\{\{(\d+)\}\}/g)) max = Math.max(max, Number(m[1]));
  return max;
}

export function renderBody(body: string, params: readonly string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (whole, n: string) => params[Number(n) - 1] ?? whole);
}

let fixtureTemplates: FixtureTemplate[] | undefined;

function fixtures(): FixtureTemplate[] {
  // W-01 … W-08 and, since V2-010, the customer app's AUTHENTICATION sign-in template (DEC-496)
  if (!fixtureTemplates) {
    const f = readFixture<{ templates: FixtureTemplate[]; authTemplates?: FixtureTemplate[] }>(
      'templates.json',
    );
    fixtureTemplates = [...f.templates, ...(f.authTemplates ?? [])];
  }
  return fixtureTemplates;
}

/** Canon purpose (W-01 …) of a template name, also for later versions (`_v2`) of a catalog name. */
export function purposeOf(name: string): string | null {
  const base = (n: string): string => n.replace(/_v\d+$/, '');
  const exact = fixtures().find((t) => t.name === name);
  if (exact) return exact.purpose;
  return fixtures().find((t) => base(t.name) === base(name))?.purpose ?? null;
}

export function templateKey(name: string, language: string): string {
  return `${name}:${language}`;
}

/** Fresh copy of the local catalog (W-01 … W-08 and the sign-in template), all APPROVED. */
export function defaultTemplates(): TemplateInfo[] {
  return fixtures().map((t, i) => ({
    id: String(900000000000001 + i),
    name: t.name,
    language: t.language,
    category: t.category,
    status: 'APPROVED' as TemplateStatus,
    purpose: t.purpose,
    body: withBrand(t.body),
    bodyParamCount: countBodyParams(t.body),
    buttons: t.buttons.map((b) => ({ ...b })),
    rejectedReason: null,
  }));
}

/** Template in the Graph `message_templates` listing shape. */
export function graphTemplateView(t: TemplateInfo): Record<string, unknown> {
  const components: Record<string, unknown>[] = [{ type: 'BODY', text: t.body }];
  if (t.buttons.length > 0) components.push({ type: 'BUTTONS', buttons: t.buttons });
  return {
    name: t.name,
    language: t.language,
    status: t.status,
    category: t.category,
    id: t.id,
    components,
    ...(t.rejectedReason ? { rejected_reason: t.rejectedReason } : {}),
  };
}

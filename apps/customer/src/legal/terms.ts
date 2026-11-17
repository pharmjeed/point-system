/**
 * «الشروط والأحكام» of the customer app (C-24; DEC-614 … DEC-618), the pure part: the shape of the versioned terms
 * document (`terms.ar.ts`, `terms.en.ts`), the rendering of a clause (the brand, the plan's values, the numbers of the
 * sections it refers to) and the Markdown published as `docs/v2/store/TERMS_AR.md` / `TERMS_EN.md`.
 *
 * ⚠ LEGAL REVIEW: the text of the terms is a draft written from the subscriptions annex. It must be reviewed by a
 * lawyer before the app is published or the text is put on the website (DEC-615). Never show this note to customers.
 *
 * No React Native and no other module of the app here: the Markdown is generated from the same objects in node.
 */

export type TermsLocale = 'ar' | 'en';

/**
 * The plan values a clause may name. Without a plan in context (C-19, C-04) each reads as a rule of «the plan» with
 * the current student plan's value in brackets; opened from a counted-day plan (C-09, C-14) it is that plan's value.
 */
export const TERMS_TOKENS = [
  'serviceDays',
  'serviceWeek',
  'offDays',
  'price',
  'dailyLimit',
  'freezeLimit',
  'freezeDays',
] as const;
export type TermsToken = (typeof TERMS_TOKENS)[number];
export type TermsValues = Readonly<Record<TermsToken, string>>;

export interface TermsSection {
  /** stable anchor (`terms-section-<id>`, the TOC and the `{§id}` references) */
  id: string;
  title: string;
  clauses: readonly string[];
}

export interface TermsDocument {
  locale: TermsLocale;
  /** = `SUBSCRIPTION_TERMS_VERSION` of `@point/shared/customer`, recorded with every purchase consent */
  version: string;
  /** `YYYY-MM-DD` of the last change of the text */
  updatedAt: string;
  title: string;
  /** «آخر تحديث: {date} · الإصدار {version}» */
  updated: string;
  intro: string;
  /** the heading of the table of contents */
  contents: string;
  /** the value of each token when no plan is in context: the current student plan's, as a rule of the plan */
  generic: TermsValues;
  sections: readonly TermsSection[];
}

/** «2026-11-17» → «17 نوفمبر 2026» / «17 November 2026». */
export function termsDate(iso: string, locale: TermsLocale): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const months =
    locale === 'ar'
      ? [
          'يناير',
          'فبراير',
          'مارس',
          'أبريل',
          'مايو',
          'يونيو',
          'يوليو',
          'أغسطس',
          'سبتمبر',
          'أكتوبر',
          'نوفمبر',
          'ديسمبر',
        ]
      : [
          'January',
          'February',
          'March',
          'April',
          'May',
          'June',
          'July',
          'August',
          'September',
          'October',
          'November',
          'December',
        ];
  return `${d} ${months[m - 1] ?? ''} ${y}`;
}

/** The section number of each id (1-based, the order of the document). */
export function sectionNumbers(doc: Pick<TermsDocument, 'sections'>): Readonly<Record<string, number>> {
  return Object.fromEntries(doc.sections.map((s, i) => [s.id, i + 1]));
}

/**
 * A clause (or any text of the document) as the customer reads it: `{brand}`, the plan tokens, and `{§id}` → the
 * number of that section. An unknown placeholder stays visible so a mistake is noticed (and a test fails).
 */
export function renderTermsText(
  text: string,
  doc: Pick<TermsDocument, 'sections' | 'generic'>,
  brand: string,
  values: TermsValues = doc.generic,
): string {
  const numbers = sectionNumbers(doc);
  const out = text.replace(/\{(§?)([\w-]+)\}/g, (whole, ref: string, key: string) => {
    if (ref) return numbers[key] !== undefined ? String(numbers[key]) : whole;
    if (key === 'brand') return brand;
    return (TERMS_TOKENS as readonly string[]).includes(key) ? values[key as TermsToken] : whole;
  });
  // a value opening an English sentence («the other days …») starts it with a capital; Arabic has no case
  return out.charAt(0).toUpperCase() + out.slice(1);
}

export interface RenderedSection {
  id: string;
  number: number;
  title: string;
  clauses: ReadonlyArray<{ number: string; text: string }>;
}

export interface RenderedTerms {
  title: string;
  updated: string;
  intro: string;
  contents: string;
  version: string;
  sections: RenderedSection[];
}

/** The whole document as the screen and the Markdown show it. */
export function renderTerms(
  doc: TermsDocument,
  brand: string,
  values: TermsValues = doc.generic,
  /** the screen isolates the version inside the Arabic line (a bidi isolate); the Markdown keeps it bare */
  isolateValue: (value: string) => string = (value) => value,
): RenderedTerms {
  const text = (s: string) => renderTermsText(s, doc, brand, values);
  return {
    title: text(doc.title),
    updated: text(doc.updated)
      .replace('{date}', termsDate(doc.updatedAt, doc.locale))
      .replace('{version}', isolateValue(doc.version)),
    intro: text(doc.intro),
    contents: text(doc.contents),
    version: doc.version,
    sections: doc.sections.map((s, i) => ({
      id: s.id,
      number: i + 1,
      title: text(s.title),
      clauses: s.clauses.map((c, j) => ({ number: `${i + 1}.${j + 1}`, text: text(c) })),
    })),
  };
}

/**
 * `docs/v2/store/TERMS_AR.md` / `TERMS_EN.md`: the same text with the generic values, for the website and the legal
 * review (a test keeps the files identical to this output; `TERMS_DOCS_WRITE=1` rewrites them).
 */
export function termsMarkdown(doc: TermsDocument, brand: string): string {
  const r = renderTerms(doc, brand);
  const lines: string[] = [
    `<!-- Generated from apps/customer/src/legal/terms.${doc.locale}.ts (C-24, DEC-617): edit the app's text, then run TERMS_DOCS_WRITE=1 pnpm --filter @point/customer test. Legal review required before publishing (DEC-615). -->`,
    '',
    `# ${r.title}`,
    '',
    `**${r.updated}**`,
    '',
    r.intro,
    '',
    `## ${r.contents}`,
    '',
    ...r.sections.map((s) => `${s.number}. [${s.title}](#${s.id})`),
    '',
  ];
  for (const s of r.sections) {
    lines.push(`<a id="${s.id}"></a>`, '', `## ${s.number}. ${s.title}`, '');
    for (const c of s.clauses) lines.push(`- **${c.number}** ${c.text}`);
    lines.push('');
  }
  return lines.join('\n');
}

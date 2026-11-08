import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BRAND_DEFAULTS,
  W09_VARIANTS,
  WA_TEMPLATES,
  WA_TEMPLATE_DEFINITIONS,
  WA_TEMPLATE_NAMES,
  WaSendJobPayloadSchema,
  lintWaCatalog,
  renderWaText,
  waMessageText,
  waTemplateById,
  type WaTemplateDef,
} from '../src/index.js';
import { backticks, readDoc, repoPath, section, tableRows } from './docs.js';

const doc14 = readDoc('14_Notification_Matrix_Templates.md');
const finalTexts = section(doc14, '## 4.');
const br = (s: string) => s.replace(/<br>/g, '\n');

describe('PNT-039 — W-01 … W-12 texts equal 14 §4 word for word', () => {
  const rows = tableRows(finalTexts);

  it('templates and single-text replies', () => {
    const fromDoc = rows
      .filter((r) => /^W-\d\d$/.test(r[0] ?? ''))
      .map((r) => ({ id: r[0], name: backticks(r[1] ?? '')[0], text: br(r[2] ?? '') }));
    const fromCode = WA_TEMPLATES.filter((t) => t.id !== 'W-09' && t.id !== 'W-11').map((t) => ({
      id: t.id,
      name: t.name,
      text: t.body_ar,
    }));
    expect(fromCode).toEqual(fromDoc);
  });

  it('W-11 received / invalid', () => {
    const w11 = rows.filter((r) => (r[0] ?? '').startsWith('W-11'));
    expect(w11.map((r) => br(r[2] ?? ''))).toEqual([
      waMessageText('W-11', 'received'),
      waMessageText('W-11', 'invalid'),
    ]);
    expect(waTemplateById('W-11').body_ar).toBe(waMessageText('W-11', 'received'));
  });

  it('W-09 by ticket state (example ticket 125)', () => {
    const start = finalTexts.findIndex((l) => l.includes('reply_current_status'));
    const states = tableRows(finalTexts.slice(start));
    expect(states).toHaveLength(W09_VARIANTS.length);
    // row order of 14 §4 = W09_VARIANTS order
    expect(states.map((r) => r[1])).toEqual(
      W09_VARIANTS.map((v) => renderWaText(waMessageText('W-09', v), ['125'])),
    );
    expect(states.map((r) => backticks(r[0] ?? '')[0] ?? null)).toEqual([
      null,
      'requested',
      'assigned',
      'assigned_waiting',
      'retrieving',
      'ready',
      'delivered',
      'voided',
    ]);
  });

  it('the simulator catalog carries the same approved texts', () => {
    const fixture = JSON.parse(
      readFileSync(repoPath('tools/wa-simulator/fixtures/templates.json'), 'utf8'),
    ) as {
      templates: {
        purpose: string;
        name: string;
        language: string;
        category: string;
        body: string;
        buttons: unknown[];
      }[];
    };
    expect(
      fixture.templates.map((t) => ({
        id: t.purpose,
        name: t.name,
        language: t.language,
        category: t.category,
        body: t.body,
        buttons: t.buttons,
      })),
    ).toEqual(
      WA_TEMPLATES.filter((t) => t.kind === 'template').map((t) => ({
        id: t.id,
        name: t.name,
        language: 'ar',
        category: 'UTILITY',
        body: t.body_ar,
        buttons: t.button ? [{ type: 'QUICK_REPLY', text: t.button.text }] : [],
      })),
    );
  });
});

describe('PNT-039 — catalog linter (12 §8.3, AC-18)', () => {
  const clone = (): WaTemplateDef[] => WA_TEMPLATES.map((t) => ({ ...t }));
  const withChange = (id: string, change: Partial<WaTemplateDef>) =>
    clone().map((t) => (t.id === id ? { ...t, ...change } : t));

  it('the catalog is valid', () => {
    expect(lintWaCatalog()).toEqual([]);
  });

  it('a second button, a URL button or another button text is refused', () => {
    const button = WA_TEMPLATES[0]!.button!;
    expect(lintWaCatalog(withChange('W-02', { button }))).toContainEqual(
      expect.stringContaining('only W-01'),
    );
    expect(lintWaCatalog(withChange('W-01', { button: { ...button, type: 'URL' as never } }))).toContainEqual(
      expect.stringContaining('forbidden URL'),
    );
    expect(
      lintWaCatalog(withChange('W-01', { button: { ...button, text: 'اطلب' as never } })),
    ).toContainEqual(expect.stringContaining('QUICK_REPLY'));
  });

  it('the staff brand, links and emojis never reach a customer text', () => {
    const staff = BRAND_DEFAULTS.BRAND_STAFF_NAME_AR;
    expect(
      lintWaCatalog(withChange('W-04', { body_ar: `${staff} — جارٍ إحضار سيارتك رقم {{1}} الآن.` })),
    ).toContainEqual(expect.stringContaining('staff brand'));
    expect(
      lintWaCatalog(withChange('W-06', { body_ar: 'تم تسليم سيارتك رقم {{1}}. https://example.com شكرًا.' })),
    ).toContainEqual(expect.stringContaining('links'));
    expect(lintWaCatalog(withChange('W-06', { body_ar: 'تم تسليم سيارتك رقم {{1}}. 🚗' }))).toContainEqual(
      expect.stringContaining('emojis'),
    );
    expect(
      lintWaCatalog(withChange('W-10', { body_ar: 'اضغط زر طلب السيارة في رسالة تذكرتك.' })),
    ).toContainEqual(expect.stringContaining('quoted'));
  });

  it('variables, examples and edges are checked', () => {
    expect(
      lintWaCatalog(withChange('W-02', { body_ar: 'تم تسجيل طلب سيارتك رقم {{1}} و{{3}}.' })),
    ).toContainEqual(expect.stringContaining('W-02: body has'));
    expect(lintWaCatalog(withChange('W-02', { body_ar: '{{1}} تم تسجيل طلب سيارتك.' }))).toContainEqual(
      expect.stringContaining('start or end'),
    );
    expect(lintWaCatalog(withChange('W-05', { example: ['125'] }))).toContainEqual(
      expect.stringContaining('examples'),
    );
    expect(lintWaCatalog(withChange('W-12', { body_ar: 'تم إيقاف الرسائل {{1}} للرقم.' }))).toContainEqual(
      expect.stringContaining('session replies have no variables'),
    );
    expect(lintWaCatalog(withChange('W-03', { category: 'MARKETING' }))).toContainEqual(
      expect.stringContaining('UTILITY'),
    );
  });

  it('W-01 names the customer brand', () => {
    expect(
      lintWaCatalog(withChange('W-01', { body_ar: 'قاعة {{1}} — تذكرة {{2}}: {{3}}. اضغط «طلب السيارة».' })),
    ).toEqual(['W-01 must name the customer brand (it opens every conversation)']);
  });
});

describe('PNT-039 — creation definitions (12 §8.2) and the send job payload', () => {
  it('W-01 … W-08 with BODY examples; W-01 alone has the QUICK_REPLY', () => {
    expect(WA_TEMPLATE_DEFINITIONS.map((d) => d.name)).toEqual([...WA_TEMPLATE_NAMES]);
    for (const d of WA_TEMPLATE_DEFINITIONS) {
      const def = WA_TEMPLATES.find((t) => t.name === d.name)!;
      expect(d).toMatchObject({ language: 'ar', category: 'UTILITY' });
      const body = d.components.find((c) => c.type === 'BODY') as {
        text: string;
        example?: { body_text: string[][] };
      };
      expect(body.text).toBe(def.body_ar);
      expect(body.example?.body_text[0] ?? []).toEqual([...def.example]);
      const buttons = d.components.filter((c) => c.type === 'BUTTONS');
      expect(buttons).toEqual(
        def.button ? [{ type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'طلب السيارة' }] }] : [],
      );
    }
  });

  it('the job payload carries ids and flags only (DEC-38)', () => {
    const keys = Object.keys(WaSendJobPayloadSchema.shape);
    expect(keys).toEqual([
      'notification_id',
      'cycle_id',
      'claim_code_id',
      'link_version',
      'variant',
      'inbound_message_id',
      'early',
    ]);
    expect(keys.filter((k) => /phone|wa_id|token|secret|ciphertext/.test(k))).toEqual([]);
    expect(
      WaSendJobPayloadSchema.safeParse({ notification_id: '0190d2a4-1111-7000-8000-000000000001' }).success,
    ).toBe(true);
    expect(WaSendJobPayloadSchema.safeParse({ notification_id: 'x' }).success).toBe(false);
  });

  it('renderWaText fills {{n}} and leaves unknown variables', () => {
    expect(renderWaText(waTemplateById('W-05').body_ar, ['125', '482731'])).toContain('رمز التسليم: 482731');
    expect(renderWaText('a {{1}} b {{2}}', ['x'])).toBe('a x b {{2}}');
  });
});

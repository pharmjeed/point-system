import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BRAND_DEFAULTS,
  W09_VARIANTS,
  WA_BRAND_TOKEN,
  WA_CUSTOMER_OTP_LANGUAGES,
  WA_CUSTOMER_OTP_TEMPLATE_NAME,
  WA_LINK_PREFILLED_TEXT,
  WA_TEMPLATES,
  WA_TEMPLATE_DEFINITIONS,
  WA_TEMPLATE_SOURCES,
  WA_TEMPLATE_SOURCES_V2,
  WA_TEMPLATE_NAMES,
  WA_TEMPLATE_NAMES_V2,
  WA_TEMPLATES_V2,
  WA_TEMPLATE_DEFINITIONS_V2,
  WA_APP_LINE_TOKEN,
  waTemplateParams,
  WaSendJobPayloadSchema,
  customerOtpMessage,
  lintWaCatalog,
  renderWaText,
  waCatalog,
  waMessageText,
  waTemplateById,
  type WaTemplateDef,
} from '../src/index.js';
import { CUSTOMER_OTP_TTL_S } from '../src/customer/index.js';
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

  it('the simulator catalog carries the same approved texts (with the {brand} token, DEC-470)', () => {
    const fixture = JSON.parse(
      readFileSync(repoPath('tools/wa-simulator/fixtures/templates.json'), 'utf8'),
    ) as {
      templates: {
        purpose: string;
        set: string;
        name: string;
        language: string;
        category: string;
        body: string;
        buttons: unknown[];
      }[];
    };
    // both template sets, v1 then v2 (DEC-555)
    expect(
      fixture.templates.map((t) => ({
        id: t.purpose,
        set: t.set,
        name: t.name,
        language: t.language,
        category: t.category,
        body: t.body,
        buttons: t.buttons,
      })),
    ).toEqual(
      [...WA_TEMPLATE_SOURCES, ...WA_TEMPLATE_SOURCES_V2]
        .filter((t) => t.kind === 'template')
        .map((t) => ({
          id: t.id,
          set: t.set,
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

  it('a staff-only brand, links and emojis never reach a customer text', () => {
    // a deployment whose customer brand differs from the staff brand keeps the V1 rule (DEC-470)
    const staff = BRAND_DEFAULTS.BRAND_STAFF_NAME_AR;
    const distinct = { customer: ['CUSTOMER_X'], staff: [staff, BRAND_DEFAULTS.BRAND_STAFF_NAME_EN] };
    const custom = waCatalog('CUSTOMER_X').templates.map((t) => ({ ...t }));
    expect(lintWaCatalog(custom, distinct)).toEqual([]);
    expect(
      lintWaCatalog(
        custom.map((t) =>
          t.id === 'W-04' ? { ...t, body_ar: `${staff} — جارٍ إحضار سيارتك رقم {{1}} الآن.` } : t,
        ),
        distinct,
      ),
    ).toContainEqual(expect.stringContaining('staff brand'));
    // V2-D01: with the defaults the customer brand is the staff brand, and naming it is the rule
    expect(BRAND_DEFAULTS.BRAND_CUSTOMER_NAME_AR).toBe(BRAND_DEFAULTS.BRAND_STAFF_NAME_AR);
    expect(
      lintWaCatalog(withChange('W-04', { body_ar: `${staff} — جارٍ إحضار سيارتك رقم {{1}} الآن.` })),
    ).toEqual([]);
    expect(
      lintWaCatalog(withChange('W-04', { body_ar: `${WA_BRAND_TOKEN} — جارٍ إحضار سيارتك رقم {{1}} الآن.` })),
    ).toContainEqual(expect.stringContaining('not filled in'));
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

describe('DEC-470 — the customer brand comes from configuration (canon §1, V2-D01)', () => {
  it('every source text that names the business carries the token, never a literal brand', () => {
    const texts = WA_TEMPLATE_SOURCES.flatMap((t) => [t.body_ar, ...Object.values(t.variants ?? {})]);
    for (const t of texts) {
      expect(t).not.toContain(BRAND_DEFAULTS.BRAND_CUSTOMER_NAME_AR);
    }
    expect(
      waTemplateById('W-01').body_ar.startsWith(`${BRAND_DEFAULTS.BRAND_CUSTOMER_NAME_AR} — {{1}}`),
    ).toBe(true);
  });

  it('waCatalog fills the configured brand in bodies, variants, Meta definitions and the QR text', () => {
    const c = waCatalog('BRAND_X');
    expect(c.customerBrandAr).toBe('BRAND_X');
    expect(c.byId('W-01').body_ar.startsWith('BRAND_X — {{1}} — تذكرة {{2}}')).toBe(true);
    expect(c.messageText('W-09', 'delivered')).toBe('تم تسليم سيارتك رقم {{1}}. شكرًا لاختيارك BRAND_X.');
    expect(c.messageText('W-10')).toContain('مرحبًا بك في BRAND_X.');
    expect(c.messageText('W-12')).toContain('تم إيقاف رسائل BRAND_X');
    const body = c.definitions[0]!.components[0] as { text: string };
    expect(body.text).toBe(c.byId('W-01').body_ar);
    expect(c.linkPrefilledText).toBe('ربط تذكرة BRAND_X {{1}}');
    expect(JSON.stringify(c.templates)).not.toContain(WA_BRAND_TOKEN);
    expect(lintWaCatalog(c.templates, { customer: ['BRAND_X'], staff: ['STAFF_X'] })).toEqual([]);
    // names, kinds and variables do not depend on the brand (Meta template names stay, canon §11)
    expect(c.templates.map((t) => [t.name, t.kind, t.variables])).toEqual(
      WA_TEMPLATES.map((t) => [t.name, t.kind, t.variables]),
    );
  });

  it('the default exports are the catalog of the default brand; a blank brand falls back to it', () => {
    expect(waCatalog()).toBe(waCatalog(BRAND_DEFAULTS.BRAND_CUSTOMER_NAME_AR));
    expect(waCatalog('  ')).toBe(waCatalog());
    expect(WA_TEMPLATES).toBe(waCatalog().templates);
    expect(WA_LINK_PREFILLED_TEXT).toBe(`ربط تذكرة ${BRAND_DEFAULTS.BRAND_CUSTOMER_NAME_AR} {{1}}`);
  });
});

describe('V2-010 — the customer app sign-in template (AUTHENTICATION, DEC-460, DEC-496)', () => {
  const c = waCatalog('BRAND_X');

  it('is a Meta AUTHENTICATION template with a copy-code button, outside W-01 … W-12', () => {
    expect(c.customerOtp).toMatchObject({
      name: WA_CUSTOMER_OTP_TEMPLATE_NAME,
      category: 'AUTHENTICATION',
      languages: ['ar', 'en'],
      button: { type: 'OTP', otp_type: 'COPY_CODE' },
      code_expiration_minutes: CUSTOMER_OTP_TTL_S / 60,
      brand: 'BRAND_X',
    });
    expect(c.templates.map((t) => t.name)).not.toContain(WA_CUSTOMER_OTP_TEMPLATE_NAME);
    // the W catalog keeps its single button «طلب السيارة»
    expect(lintWaCatalog(c.templates, { customer: ['BRAND_X'], staff: ['STAFF_X'] })).toEqual([]);
    for (const lang of WA_CUSTOMER_OTP_LANGUAGES) {
      expect(c.customerOtp.body[lang]).toMatch(/^\{\{1\}\} /);
      expect(c.customerOtp.body[lang]).not.toMatch(/https?:|sms/i);
    }
  });

  it('Meta creation bodies: one per language, preset body with the security line, the expiry footer, COPY_CODE', () => {
    expect(c.authDefinitions.map((d) => [d.name, d.language, d.category])).toEqual([
      [WA_CUSTOMER_OTP_TEMPLATE_NAME, 'ar', 'AUTHENTICATION'],
      [WA_CUSTOMER_OTP_TEMPLATE_NAME, 'en', 'AUTHENTICATION'],
    ]);
    expect(c.authDefinitions[0]!.message_send_ttl_seconds).toBe(CUSTOMER_OTP_TTL_S);
    expect(c.authDefinitions[0]!.components).toEqual([
      { type: 'BODY', add_security_recommendation: true },
      { type: 'FOOTER', code_expiration_minutes: 5 },
      { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'نسخ الرمز' }] },
    ]);
  });

  it('the send body carries the code in the body and the button, and the simulator has the same template', () => {
    const m = customerOtpMessage('966512345678', 'ar', '123456');
    expect(m.template.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: '123456' }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '123456' }] },
    ]);
    const fixture = JSON.parse(
      readFileSync(repoPath('tools/wa-simulator/fixtures/templates.json'), 'utf8'),
    ) as {
      authTemplates: { name: string; language: string; category: string; body: string; buttons: unknown[] }[];
    };
    expect(fixture.authTemplates).toEqual(
      WA_CUSTOMER_OTP_LANGUAGES.map((language) => ({
        purpose: 'C-OTP',
        name: WA_CUSTOMER_OTP_TEMPLATE_NAME,
        language,
        category: 'AUTHENTICATION',
        body: c.customerOtp.body[language],
        buttons: [{ type: 'OTP', text: c.customerOtp.button.text[language] }],
      })),
    );
  });
});

describe('V2-050 — the v2 template set, the live-set switch and the app line (DEC-555 … DEC-558)', () => {
  const doc14v2 = section(doc14, '## 4ب.');
  const v2 = waCatalog('BRAND_X', { set: 'v2' });
  const link = 'https://apps.example.org/point';
  const brands = { customer: ['BRAND_X'], staff: ['STAFF_X'] };

  it('the v2 bodies equal 14 §4ب word for word (default brand), with the session replies of §4', () => {
    const fromDoc = tableRows(doc14v2)
      .filter((r) => /^W-\d\d$/.test(r[0] ?? ''))
      .map((r) => ({ id: r[0], name: backticks(r[1] ?? '')[0], text: br(r[2] ?? '') }));
    expect(
      WA_TEMPLATES_V2.filter((t) => t.kind === 'template').map((t) => ({
        id: t.id,
        name: t.name,
        text: t.body_ar,
      })),
    ).toEqual(fromDoc);
    expect(WA_TEMPLATES_V2.filter((t) => t.kind === 'template').map((t) => t.name)).toEqual([
      ...WA_TEMPLATE_NAMES_V2,
    ]);
    // W-09 … W-12 are one set: the same texts in v1 and v2
    expect(WA_TEMPLATES_V2.filter((t) => t.kind === 'session')).toEqual(
      WA_TEMPLATES.filter((t) => t.kind === 'session'),
    );
  });

  it('the v2 set is valid for the linter: one button «طلب السيارة», UTILITY, no links, ≤ 1024, examples', () => {
    expect(lintWaCatalog(WA_TEMPLATES_V2)).toEqual([]);
    expect(lintWaCatalog(v2.templates, brands)).toEqual([]);
    expect(v2.templates.filter((t) => t.button).map((t) => t.id)).toEqual(['W-01']);
    for (const t of v2.templates.filter((x) => x.kind === 'template')) {
      expect(t).toMatchObject({ set: 'v2', category: 'UTILITY', language: 'ar' });
      expect(t.body_ar.length).toBeLessThanOrEqual(1024);
    }
    // a v2 name in a v1 catalog (mixed sets) is refused
    const mixed = WA_TEMPLATES.map((t) => (t.id === 'W-02' ? WA_TEMPLATES_V2[1]! : t));
    expect(lintWaCatalog(mixed)).toContainEqual(expect.stringContaining('differ from canon'));
  });

  it('every message names its venue; W-01 adds the operator line and keeps opening with the brand', () => {
    for (const t of WA_TEMPLATE_SOURCES_V2.filter((x) => x.kind === 'template'))
      expect(t.variable_names).toContain('venue_name');
    expect(v2.byId('W-01').body_ar.startsWith('BRAND_X — {{1}} — تذكرة {{2}}\nتشغيل: {{3}}')).toBe(true);
    expect(v2.byId('W-06').body_ar).toBe('تم تسليم سيارتك رقم {{1}} في {{2}}. شكرًا لاختيارك BRAND_X.');
  });

  it('the sender fills each set from the same named facts (waTemplateParams)', () => {
    const facts = {
      venue_name: 'قاعة ريماس',
      display_number: '125',
      operator_name: 'شركة ريماس للضيافة',
      vehicle_description: 'تويوتا كامري بيضاء — لوحة 4821',
      claim_code: '482731',
    };
    expect(waTemplateParams(waCatalog().byId('W-01'), facts)).toEqual([
      'قاعة ريماس',
      '125',
      'تويوتا كامري بيضاء — لوحة 4821',
    ]);
    expect(waTemplateParams(v2.byId('W-01'), facts)).toEqual([
      'قاعة ريماس',
      '125',
      'شركة ريماس للضيافة',
      'تويوتا كامري بيضاء — لوحة 4821',
    ]);
    expect(waTemplateParams(waCatalog().byId('W-05'), facts)).toEqual(['125', '482731']);
    expect(waTemplateParams(v2.byId('W-05'), facts)).toEqual(['125', 'قاعة ريماس', '482731']);
    expect(renderWaText(v2.byId('W-05').body_ar, waTemplateParams(v2.byId('W-05'), facts))).toContain(
      'في قاعة ريماس.\nرمز التسليم: 482731',
    );
    // the Meta examples are the same facts in the same order
    for (const t of WA_TEMPLATES_V2.filter((x) => x.kind === 'template'))
      expect(t.example).toEqual(waTemplateParams(t, facts));
  });

  it('the live set chooses names, texts and definitions; the sync follows the live set and every later one', () => {
    const v1 = waCatalog('BRAND_X');
    expect(v1.templateSet).toBe('v1');
    expect(v1.templateNames).toEqual([...WA_TEMPLATE_NAMES]);
    expect(v1.syncDefinitions.map((d) => d.name)).toEqual([...WA_TEMPLATE_NAMES, ...WA_TEMPLATE_NAMES_V2]);
    expect(v1.isLiveTemplate('masaf_ticket_issued_v1')).toBe(true);
    expect(v1.isLiveTemplate('point_ticket_issued_v2')).toBe(false);
    expect(v2.templateNames).toEqual([...WA_TEMPLATE_NAMES_V2]);
    expect(v2.definitions.map((d) => d.name)).toEqual([...WA_TEMPLATE_NAMES_V2]);
    expect(v2.syncDefinitions).toEqual(v2.definitions);
    expect(v2.isLiveTemplate('point_vehicle_ready_v2')).toBe(true);
    // the v2 definitions synced by a v1 server carry the configured brand too
    const synced = v1.syncDefinitions.find((d) => d.name === 'point_ticket_issued_v2')!;
    expect((synced.components[0] as { text: string }).text).toBe(v2.byId('W-01').body_ar);
    // W-01 keeps its single QUICK_REPLY in both sets
    expect(v2.definitions[0]!.components[1]).toEqual({
      type: 'BUTTONS',
      buttons: [{ type: 'QUICK_REPLY', text: 'طلب السيارة' }],
    });
    // the sign-in template is the same in both sets (DEC-557)
    expect(v2.authDefinitions).toEqual(v1.authDefinitions);
    expect(WA_TEMPLATE_DEFINITIONS_V2.map((d) => d.name)).toEqual([...WA_TEMPLATE_NAMES_V2]);
    expect(waCatalog('BRAND_X', { set: 'v2' })).toBe(v2);
  });

  it('the app line: only in W-09 «delivered» and W-10, only with CUSTOMER_APP_LINK, never in a template', () => {
    const withLink = waCatalog('BRAND_X', { set: 'v2', appLink: link });
    const line = `\n\nلطلب سيارتك ومتابعتها في زيارتك القادمة، حمّل تطبيق BRAND_X: ${link}`;
    expect(withLink.appLink).toBe(link);
    expect(withLink.messageText('W-09', 'delivered')).toBe(
      `تم تسليم سيارتك رقم {{1}}. شكرًا لاختيارك BRAND_X.${line}`,
    );
    expect(withLink.messageText('W-10')).toBe(`${v2.messageText('W-10')}${line}`);
    const carrying = withLink.templates.flatMap((t) =>
      [t.body_ar, ...Object.values(t.variants ?? {})].filter((x) => x.includes(link)).map(() => t.id),
    );
    expect(carrying).toEqual(['W-09', 'W-10']);
    expect(withLink.definitions).toEqual(v2.definitions);
    expect(JSON.stringify(withLink.authDefinitions)).not.toContain(link);
    // no link → the texts of 14 §4 exactly, and no token is left
    expect(v2.messageText('W-09', 'delivered')).toBe('تم تسليم سيارتك رقم {{1}}. شكرًا لاختيارك BRAND_X.');
    expect(JSON.stringify(withLink.templates)).not.toContain(WA_APP_LINE_TOKEN);
    expect(JSON.stringify(v2.templates)).not.toContain(WA_APP_LINE_TOKEN);
    // the linter allows the configured link in a session reply only, and only as https
    expect(lintWaCatalog(withLink.templates, brands, { appLink: link })).toEqual([]);
    expect(lintWaCatalog(withLink.templates, brands)).toContainEqual(expect.stringContaining('links'));
    expect(
      lintWaCatalog(
        withLink.templates.map((t) => (t.id === 'W-06' ? { ...t, body_ar: `${t.body_ar} ${link}` } : t)),
        brands,
        { appLink: link },
      ),
    ).toContainEqual('W-06: links are not allowed');
    expect(lintWaCatalog(v2.templates, brands, { appLink: 'sa.point.app://home' })).toContainEqual(
      'the app link must be an https URL',
    );
    expect(waCatalog('BRAND_X', { set: 'v2', appLink: '  ' })).toBe(v2);
  });

  it('the Meta submission sheet docs/whatsapp-templates-v2.md carries the code definitions verbatim (DEC-559)', () => {
    const sheet = readDoc('whatsapp-templates-v2.md');
    const blocks = [...sheet.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]!) as unknown);
    const d = waCatalog(undefined, { set: 'v2' });
    expect(blocks).toEqual([...d.definitions, ...d.authDefinitions]);
    const bodies = [...sheet.matchAll(/المتن \(Body\):\n\n```text\n([\s\S]*?)\n```/g)].map((m) => m[1]);
    expect(bodies).toEqual(d.templates.filter((t) => t.kind === 'template').map((t) => t.body_ar));
  });
});

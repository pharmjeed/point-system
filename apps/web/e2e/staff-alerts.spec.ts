import { expect, test, type Page } from '@playwright/test';
import {
  alertFixture,
  MockApi,
  mockStaffApi,
  roleMe,
  STAFF_USER_ID,
  warningAlertFixture,
} from './support/api';
import { runOnlyAt390 } from './support/checks';
import { FakeRealtime } from './support/fake/realtime';

/**
 * S-04 — مركز التنبيهات (PNT-075, 14 §7–§10): nothing sounds before the unlock tap; a critical alert plays the
 * escalation sound and repeats every 60 s; «إقرار» stops it at once; «حل» needs a resolution note. Audio is a
 * recording fake (`window.Audio`), so the test sees every play/pause and whether it was the muted unlock.
 */
runOnlyAt390();

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const log: Array<{ src: string; op: 'play' | 'pause'; muted: boolean }> = [];
    (window as unknown as { __audioLog: typeof log }).__audioLog = log;
    class FakeAudio {
      src: string;
      muted = false;
      preload = '';
      currentTime = 0;
      constructor(src: string) {
        this.src = src;
      }
      play() {
        log.push({ src: this.src, op: 'play', muted: this.muted });
        return Promise.resolve();
      }
      pause() {
        log.push({ src: this.src, op: 'pause', muted: this.muted });
      }
    }
    (window as unknown as { Audio: unknown }).Audio = FakeAudio;
  });
});

/** Audible plays/pauses of one sound file (the muted unlock of each element is not counted). */
async function count(page: Page, file: string, op: 'play' | 'pause'): Promise<number> {
  return page.evaluate(
    ([f, o]) =>
      (
        window as unknown as { __audioLog: Array<{ src: string; op: string; muted: boolean }> }
      ).__audioLog.filter((e) => e.src.endsWith(f as string) && e.op === o && !e.muted).length,
    [file, op],
  );
}

test('acknowledging a critical alert stops the escalation sound; no repeat follows', async ({ page }) => {
  await page.clock.install();
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api);
  await api.install();
  await page.goto('/ops/alerts');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('مركز التنبيهات');
  const critical = page.locator('li[data-alert-id="al-47"]');
  await expect(critical).toContainText('طلب لم يُقبل في الوقت المحدد');
  await expect(critical).toContainText('#47');

  // autoplay rules: silent until the tap
  await page.clock.runFor(70_000);
  expect(await count(page, 'point-escalation.mp3', 'play')).toBe(0);

  await page.getByRole('button', { name: 'تفعيل صوت التنبيهات' }).click();
  await expect.poll(() => count(page, 'point-test.mp3', 'play')).toBe(1);
  await expect.poll(() => count(page, 'point-escalation.mp3', 'play')).toBe(1);
  await expect(page.getByRole('button', { name: 'تفعيل صوت التنبيهات' })).toHaveCount(0);

  await page.clock.runFor(60_000);
  await expect.poll(() => count(page, 'point-escalation.mp3', 'play')).toBe(2);

  await critical.getByRole('button', { name: 'إقرار' }).click();
  await expect(critical).toContainText('أُقِرّ');
  await expect.poll(() => count(page, 'point-escalation.mp3', 'pause')).toBeGreaterThan(0);
  const ack = api.callsTo('POST', '/v1/alerts/al-47/acknowledge');
  expect(ack).toHaveLength(1);
  expect(ack[0]?.headers['idempotency-key']).toBeTruthy();
  expect(ack[0]?.body).toEqual({ note: null });

  await page.clock.runFor(5 * 60_000);
  expect(await count(page, 'point-escalation.mp3', 'play')).toBe(2);
});

test('PNT-065 (staff): `alert.updated` over the socket marks the alert «أُقِرّ» and stops the escalation before the next refresh; `alert.raised` re-reads the list', async ({
  page,
}) => {
  await page.clock.install();
  // the socket payloads are checked against the canon schemas: ids are UUIDs there
  const alertId = crypto.randomUUID();
  const venueId = crypto.randomUUID();
  const api = new MockApi(page, roleMe('supervisor'));
  const state = mockStaffApi(api, { alerts: [alertFixture({ id: alertId, venue_id: venueId })] });
  const hub = FakeRealtime.standalone();
  api.realtime = hub;
  await api.install();
  await page.goto('/ops/alerts');
  const critical = page.locator(`li[data-alert-id="${alertId}"]`);
  await expect(critical).toContainText('طلب لم يُقبل في الوقت المحدد');
  await page.getByRole('button', { name: 'تفعيل صوت التنبيهات' }).click();
  await expect.poll(() => count(page, 'point-escalation.mp3', 'play')).toBe(1);
  await expect.poll(() => hub.connectedUsers()).toEqual([STAFF_USER_ID]);

  // another supervisor acknowledges it: the server publishes alert.updated (07 §4.2) — no poll needed
  const acknowledged = {
    ...state.alerts[0],
    status: 'acknowledged',
    acknowledged_at: new Date().toISOString(),
    acknowledged_by: crypto.randomUUID(),
  };
  state.alerts = [acknowledged];
  const reads = api.callsTo('GET', '/v1/alerts').length;
  hub.emit(
    STAFF_USER_ID,
    'alert.updated',
    { cause: 'alert.acknowledged', ...acknowledged },
    { venueId, aggregate: { type: 'alert', id: alertId, version: null } },
  );
  await expect(critical).toContainText('أُقِرّ');
  await expect.poll(() => count(page, 'point-escalation.mp3', 'pause')).toBeGreaterThan(0);
  await expect.poll(() => api.callsTo('GET', '/v1/alerts').length).toBeGreaterThan(reads); // then re-read

  // a new alert: alert.raised invalidates the lists, the warning shows and plays its reminder once
  const warningId = crypto.randomUUID();
  const warning = warningAlertFixture({ id: warningId, venue_id: venueId });
  state.alerts = [acknowledged, warning];
  hub.emit(
    STAFF_USER_ID,
    'alert.raised',
    { cause: 'alert.raised', ...warning },
    { venueId, aggregate: { type: 'alert', id: warningId, version: null } },
  );
  await expect(page.locator(`li[data-alert-id="${warningId}"]`)).toBeVisible();
  await expect.poll(() => count(page, 'point-reminder.mp3', 'play')).toBe(1);
  await page.clock.runFor(5 * 60_000);
  expect(await count(page, 'point-escalation.mp3', 'play')).toBe(1);
});

test('the escalation repeats at most 3 times; a new warning plays the reminder once', async ({ page }) => {
  await page.clock.install();
  const api = new MockApi(page, roleMe('supervisor'));
  const state = mockStaffApi(api, { alerts: [alertFixture()] });
  await api.install();
  await page.goto('/ops');
  await page.getByRole('button', { name: 'تفعيل صوت التنبيهات' }).click();
  await expect.poll(() => count(page, 'point-escalation.mp3', 'play')).toBe(1);
  for (let i = 0; i < 6; i += 1) await page.clock.runFor(60_000);
  await expect.poll(() => count(page, 'point-escalation.mp3', 'play')).toBe(4);

  // acknowledged elsewhere (another supervisor): the next refresh stops it, then a warning arrives
  state.alerts = [alertFixture({ status: 'acknowledged' }), warningAlertFixture()];
  await page.clock.runFor(16_000);
  await expect.poll(() => count(page, 'point-reminder.mp3', 'play')).toBe(1);
  await page.clock.runFor(60_000);
  expect(await count(page, 'point-reminder.mp3', 'play')).toBe(1);
  expect(await count(page, 'point-escalation.mp3', 'play')).toBe(4);
});

test('«حل» needs a resolution note of 3 characters or more', async ({ page }) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api);
  await api.install();
  await page.goto('/ops/alerts');
  const warning = page.locator('li[data-alert-id="al-45"]');
  await warning.getByRole('button', { name: 'حل' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'حل التنبيه' });
  const confirm = dialog.getByRole('button', { name: 'تأكيد' });
  const note = dialog.getByLabel('ملاحظة الحل');
  await expect(confirm).toBeDisabled();
  await expect(dialog).toContainText('اكتب ملاحظة الحل.');
  await note.fill('  تم ');
  await expect(confirm).toBeDisabled();
  await note.fill('أُعيد إسناد الطلب لسائق متاح');
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(dialog).toBeHidden();
  const calls = api.callsTo('POST', '/v1/alerts/al-45/resolve');
  expect(calls).toHaveLength(1);
  expect(calls[0]?.body).toEqual({ note: 'أُعيد إسناد الطلب لسائق متاح' });
  expect(calls[0]?.headers['idempotency-key']).toBeTruthy();
  // the open + acknowledged list no longer has it after the refresh
  await expect(page.locator('li[data-alert-id="al-45"]')).toHaveCount(0);

  // «محلولة» shows it read-only (no «إقرار»/«حل»)
  await page.getByRole('group', { name: 'الحالة' }).getByRole('button', { name: 'محلولة' }).click();
  const resolved = page.locator('li[data-alert-id="al-45"]');
  await expect(resolved).toContainText('محلول');
  await expect(resolved.getByRole('button')).toHaveCount(0);
});

test('without alert.manage the alerts are read-only', async ({ page }) => {
  const api = new MockApi(page, roleMe('supervisor', { remove: ['alert.manage'] }));
  mockStaffApi(api);
  await api.install();
  await page.goto('/ops/alerts');
  const critical = page.locator('li[data-alert-id="al-47"]');
  await expect(critical).toContainText('طلب لم يُقبل في الوقت المحدد');
  await expect(critical.getByRole('button')).toHaveCount(0);
  await expect(critical.getByRole('link', { name: 'فتح' })).toBeVisible();
});

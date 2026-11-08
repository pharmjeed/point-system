import type { Page } from '@playwright/test';

/**
 * A stand-in `Notification` for the permission specs (PNT-070 acceptance 2, AC-22): it counts every
 * `requestPermission()` call and answers with the chosen permission, so a spec proves that nothing asks for
 * the permission on load and that the answer after a tap is handled. Headless Chromium has no prompt to
 * click.
 */
export async function stubNotifications(
  page: Page,
  options: { permission?: NotificationPermission; answer?: NotificationPermission } = {},
): Promise<void> {
  await page.addInitScript(
    ({ permission, answer }) => {
      const state = { permission, answer, calls: 0 };
      (window as unknown as { __notifications: typeof state }).__notifications = state;
      class StubNotification {
        static get permission() {
          return state.permission;
        }
        static requestPermission(callback?: (p: NotificationPermission) => void) {
          state.calls += 1;
          state.permission = state.answer;
          callback?.(state.answer);
          return Promise.resolve(state.answer);
        }
      }
      Object.defineProperty(window, 'Notification', { value: StubNotification, configurable: true });
    },
    { permission: options.permission ?? 'default', answer: options.answer ?? 'granted' },
  );
}

export function permissionRequests(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __notifications: { calls: number } }).__notifications.calls,
  );
}

/** `display-mode: standalone` (the app opened from the home screen) for `matchMedia`. */
export async function standaloneDisplay(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = (query: string) =>
      query.includes('display-mode: standalone')
        ? ({
            matches: true,
            media: query,
            onchange: null,
            addEventListener() {},
            removeEventListener() {},
            addListener() {},
            removeListener() {},
            dispatchEvent: () => false,
          } as MediaQueryList)
        : original(query);
  });
}

import { describe, expect, it } from 'vitest';
import { isIos, permissionForServer } from '@/lib/deviceChecks';
import { fitWithin } from '@/lib/photos';

describe('D-03 device checks', () => {
  it('detects iPhone / iPad (and iPadOS that reports a Mac)', () => {
    expect(
      isIos('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'),
    ).toBe(true);
    expect(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Mobile/15E148')).toBe(
      true,
    );
    expect(
      isIos('Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36'),
    ).toBe(false);
  });

  it('maps the local state to devices.notification_permission (07 NotificationPermission)', () => {
    expect(permissionForServer('on')).toBe('granted');
    expect(permissionForServer('denied')).toBe('denied');
    expect(permissionForServer('unsupported')).toBe('unsupported');
    expect(permissionForServer('off')).toBe('default');
    expect(permissionForServer('needsInstall')).toBe('default');
  });
});

describe('D-06 photo size (02: longest edge 1600 px, never enlarged)', () => {
  it('scales the longest edge down and keeps the aspect ratio', () => {
    expect(fitWithin(4032, 3024, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3024, 4032, 1600)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin(1280, 960, 1600)).toEqual({ width: 1280, height: 960 });
    expect(fitWithin(4000, 1, 1280)).toEqual({ width: 1280, height: 1 });
  });
});

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { newIdempotencyKey } from '@/api/command';
import { updateDevice, type PushSubscriptionBody } from '@/api/field';
import { queryKeys } from '@/api/queryClient';
import type { Me } from '@/api/types';
import {
  displayMode,
  notificationCheck,
  permissionForServer,
  requestNotifications,
  type NotificationCheck,
} from '@/lib/deviceChecks';
import { existingSubscription, pushSupported, subscribePush, vapidPublicKey } from '@/lib/push';
import { track } from '@/lib/telemetry';

/**
 * The device's notification permission and Web Push subscription, shared by the driver shell (D-03, D-14,
 * the frame) and the staff shell (the menu, the frame; realtime:RT-5): the permission is asked only from a
 * tap (05 §15.3, 14 §6.4.1) and the result is recorded on the session's device (`Me.session.device_id`) with
 * `PUT /v1/me/devices/{deviceId}`. The server pushes `escalation` alerts to supervisors, admins and the owner
 * (14 §6.1), so the staff need the same path as the drivers.
 */

/** Devices whose existing subscription was sent again in this app session. */
const relinked = new Set<string>();

/**
 * PNT-072: every sign-in links a new `devices` row with no push endpoint, so a user who granted the
 * permission once would stop receiving Web Push from the next sign-in on. The frame sends the subscription
 * this browser already holds to the session's device — no permission prompt and no new subscription (14
 * §6.4.1: those come from a tap only) — when `missing` (the driver's snapshot says the server has none; the
 * staff frame has no such flag and sends it once per device and app session).
 */
export function usePushRelink(me: Me, missing: boolean): void {
  const qc = useQueryClient();
  const deviceId = me.session.device_id ?? null;
  useEffect(() => {
    if (!deviceId || !missing || relinked.has(deviceId) || notificationCheck() !== 'on') return;
    relinked.add(deviceId);
    void (async () => {
      const subscription = await existingSubscription();
      if (!subscription) return; // none yet: the tap offers «تفعيل الإشعارات» / «إعداد»
      await updateDevice(
        deviceId,
        { notification_permission: 'granted', display_mode: displayMode(), push_subscription: subscription },
        newIdempotencyKey(),
      );
      void qc.invalidateQueries({ queryKey: queryKeys.home, exact: true }); // checks.push_enabled
    })().catch(() => relinked.delete(deviceId)); // offline: the next render tries again
  }, [deviceId, missing, qc]);
}

export function useNotificationSetup(
  me: Me,
  /** 15 §8 `notification_permission_changed.context`: D-03, D-14 / the staff menu, or a banner. */
  context: 'duty_start' | 'account' | 'banner' = 'account',
): {
  check: NotificationCheck;
  pending: boolean;
  enable: () => void;
  /** Whether the last setup sent a subscription (PNT-072). */
  subscribed: boolean | null;
} {
  const qc = useQueryClient();
  const [check, setCheck] = useState<NotificationCheck>(() => notificationCheck());
  const [pending, setPending] = useState(false);
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const deviceId = me.session.device_id ?? null;

  // from the tap only: requestPermission() runs before the first await (05 §15.3, PNT-070 acceptance 2)
  const enable = () => {
    setPending(true);
    const before = permissionForServer(notificationCheck());
    void requestNotifications()
      .then(async (next) => {
        setCheck(next);
        const after = permissionForServer(next);
        if (after !== before) track('notification_permission_changed', { from: before, to: after, context });
        let subscription: PushSubscriptionBody | null = null;
        if (next === 'on') subscription = await subscribePush();
        setSubscribed(next === 'on' ? !!subscription : null);
        // 15 §8 push_subscription_changed: only where this build can push at all (a key, a worker, the API)
        if (next === 'on' && vapidPublicKey() && pushSupported())
          track(
            'push_subscription_changed',
            subscription ? { status: 'subscribed' } : { status: 'failed', error_name: 'unknown' },
          );
        if (!deviceId) return;
        await updateDevice(
          deviceId,
          {
            notification_permission: permissionForServer(next),
            display_mode: displayMode(),
            ...(subscription ? { push_subscription: subscription } : {}),
          },
          newIdempotencyKey(),
        ).catch(() => undefined);
        void qc.invalidateQueries({ queryKey: queryKeys.home, exact: true }); // checks.push_enabled
      })
      .finally(() => setPending(false));
  };
  return { check, pending, enable, subscribed };
}

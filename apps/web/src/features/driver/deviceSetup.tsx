import { useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { newIdempotencyKey } from '@/api/command';
import { recordAudioTest, updateDevice, type PushSubscriptionBody } from '@/api/field';
import { queryKeys } from '@/api/queryClient';
import type { AudioTestResult, Me } from '@/api/types';
import { Dialog } from '@/components';
import { d03 } from '@/i18n/ar';
import { runAudioTest } from '@/lib/audio';
import {
  displayMode,
  notificationCheck,
  permissionForServer,
  requestNotifications,
  type NotificationCheck,
} from '@/lib/deviceChecks';
import { subscribePush } from '@/lib/push';
import { heartbeatNow } from '@/realtime/manager';
import { useFieldStore, type AudioCheck } from '@/stores/field';

/**
 * The device checks shared by D-03 and D-14 (02 D-03 «تدفق اختبار الصوت» / «تدفق الإشعارات», D-14 «الصوت
 * والإشعارات: التدفق نفسه في D-03»; PNT-066, PNT-070, PNT-072). Both start only from a tap: the AudioContext is
 * created inside it, and `Notification.requestPermission()` is called inside it (05 §15.3) — never on load.
 * Results are recorded on the session's device (`Me.session.device_id`): `POST /v1/me/audio-test` and
 * `PUT /v1/me/devices/{deviceId}` with the permission, the display mode and the Web Push subscription.
 */
export function useAudioCheck(me: Me): {
  audio: AudioCheck;
  testedAt: string | null;
  test: () => void;
  dialog: ReactNode;
} {
  const audio = useFieldStore((s) => s.audio);
  const testedAt = useFieldStore((s) => s.audioTestedAt);
  const setAudio = useFieldStore((s) => s.setAudio);
  const [heardOpen, setHeardOpen] = useState(false);
  const deviceId = me.session.device_id ?? null;

  const record = (result: AudioTestResult) => {
    if (deviceId)
      void recordAudioTest({ device_id: deviceId, result }, newIdempotencyKey()).catch(() => undefined);
  };

  // Must stay synchronous up to runAudioTest(): the AudioContext is created inside the tap (02 D-03).
  const test = () => {
    void runAudioTest().then((outcome) => {
      heartbeatNow(); // `audio_unlocked` changed
      if (outcome === 'blocked') {
        setAudio('blocked');
        record('blocked');
      } else setHeardOpen(true);
    });
  };

  const dialog = (
    <Dialog
      open={heardOpen}
      onOpenChange={setHeardOpen}
      title={d03.heardQuestion}
      confirmLabel={d03.heardYes}
      cancelLabel={d03.heardNo}
      onConfirm={() => {
        setHeardOpen(false);
        setAudio('ok');
        record('heard');
      }}
      onCancel={() => {
        setHeardOpen(false);
        setAudio('notHeard');
        record('not_heard');
      }}
      onDismiss={() => setHeardOpen(false)}
    />
  );
  return { audio, testedAt, test, dialog };
}

export function useNotificationSetup(me: Me): {
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
    void requestNotifications()
      .then(async (next) => {
        setCheck(next);
        let subscription: PushSubscriptionBody | null = null;
        if (next === 'on') subscription = await subscribePush();
        setSubscribed(next === 'on' ? !!subscription : null);
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

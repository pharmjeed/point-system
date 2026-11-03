import { useState, type ReactNode } from 'react';
import { newIdempotencyKey } from '@/api/command';
import { recordAudioTest } from '@/api/field';
import type { AudioTestResult, DriverHome, Me } from '@/api/types';
import { Dialog } from '@/components';
import { d03 } from '@/i18n/ar';
import { runAudioTest } from '@/lib/audio';
import { usePushRelink as useDevicePushRelink, useNotificationSetup } from '@/features/session/pushSetup';
import type { NotificationCheck } from '@/lib/deviceChecks';
import { pushSupported, vapidPublicKey } from '@/lib/push';
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

/**
 * 14 §5.1 «الإشعارات لا تصل لجهازك — أعد تفعيلها»: the permission is granted here, the build can push, but the
 * server holds no subscription for this session's device (a new sign-in links a new device; 14 §6.6 a dropped
 * one). D-03 and D-14 then offer «إعداد» (a tap that subscribes).
 */
export function pushNotReaching(
  check: NotificationCheck,
  home: DriverHome | undefined,
  subscribed: boolean | null,
): boolean {
  return (
    check === 'on' &&
    !!vapidPublicKey() &&
    pushSupported() &&
    home?.checks.push_enabled === false &&
    subscribed !== true
  );
}

/**
 * PNT-072: the frame re-links the subscription this browser already holds when the snapshot says the server
 * has none for the session's device (the shared hook, also used by the staff frame).
 */
export function usePushRelink(me: Me, home: DriverHome | undefined): void {
  useDevicePushRelink(me, home?.checks.push_enabled === false);
}

export { useNotificationSetup };

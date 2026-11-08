/**
 * The push state of this device for C-12's offer and C-19's switch (V2-016, DEC-519): the OS permission, whether this
 * session registered its token, and whether the build can receive pushes at all (an EAS project id).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { appConfig } from '../config';
import { CommandKey } from '../features/commandKey';
import type { PushPermission } from '../features/push';
import { flags, newIdempotencyKey } from '../session/secureStore';
import { useSession } from '../session/SessionProvider';
import { disablePush, enablePush, pushPermission, type EnableResult } from './notifications';

export interface PushState {
  available: boolean;
  permission: PushPermission;
  registered: boolean;
  ready: boolean;
}

export function usePush(channelName: string) {
  const session = useSession();
  const key = useRef(new CommandKey(newIdempotencyKey)).current;
  const [state, setState] = useState<PushState>({
    available: appConfig.push.projectId !== null,
    permission: 'undetermined',
    registered: false,
    ready: false,
  });

  const refresh = useCallback(async () => {
    const [permission, registered] = await Promise.all([
      pushPermission().catch((): PushPermission => 'undetermined'),
      flags.pushRegistered(),
    ]);
    setState((s) => ({ ...s, permission, registered, ready: true }));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enable = useCallback(async (): Promise<EnableResult> => {
    const r = await enablePush(session.api, {
      projectId: appConfig.push.projectId,
      channelName,
      idempotencyKey: key.for('enable'),
    });
    key.reset();
    if (r === 'enabled') await flags.setPushRegistered(true);
    await refresh();
    return r;
  }, [session.api, channelName, key, refresh]);

  const disable = useCallback(async () => {
    await disablePush(session.api, key.for('disable'));
    key.reset();
    await flags.setPushRegistered(false);
    await refresh();
  }, [session.api, key, refresh]);

  return { state, enable, disable, refresh };
}

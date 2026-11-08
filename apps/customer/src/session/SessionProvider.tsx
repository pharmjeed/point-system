/**
 * The signed-in state of the app: the API client, the account as the server last returned it, and the two device
 * flags of journey R1. Screens ask `destination()` where to go next (src/features/onboarding.ts).
 */
import type { CustomerMe } from '@point/shared/customer';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createApi, type ApiBundle } from '../api';
import { SignedOutError } from '../api/errors';
import { appConfig } from '../config';
import { nextDestination, type Destination } from '../features/onboarding';
import { deviceId, flags, securePassStore } from './secureStore';

type Phase = 'loading' | 'ready' | 'offline';

interface SessionValue extends ApiBundle {
  phase: Phase;
  me: CustomerMe | null;
  /** Retries the start-up read after a network failure. */
  reload(): void;
  /** Stores the account the server returned and answers where R1 continues. */
  setMe(me: CustomerMe): Promise<Destination>;
  markWelcomeSeen(): Promise<void>;
  markVehiclePromptDone(): Promise<void>;
  signOut(): Promise<void>;
  /** C-20: the account is gone (the client already dropped the tokens); the app starts R1 over at C-01. */
  forgetAccount(): void;
  /** Where R1 continues with the current (or given) state. */
  destination(next?: {
    me?: CustomerMe | null;
    welcomeSeen?: boolean;
    vehiclePromptDone?: boolean;
  }): Destination;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [bundle, setBundle] = useState<ApiBundle | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [me, setMeState] = useState<CustomerMe | null>(null);
  const [welcomeSeen, setWelcomeSeen] = useState(false);
  const [vehiclePromptDone, setVehiclePromptDone] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const signedOutRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setPhase('loading');
      const current = bundle ?? createApi(appConfig, await deviceId(), () => signedOutRef.current());
      if (!bundle) setBundle(current);
      setWelcomeSeen(await flags.welcomeSeen());
      try {
        if (await current.api.hasSession()) {
          const account = await current.api.me();
          if (cancelled) return;
          setMeState(account);
          setVehiclePromptDone(await flags.vehiclePromptDone(account.id));
        }
        if (!cancelled) setPhase('ready');
      } catch (e) {
        if (cancelled) return;
        if (e instanceof SignedOutError) {
          setMeState(null);
          setPhase('ready');
        } else {
          setPhase('offline');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // `bundle` is created once on the first run; a retry (`attempt`) only re-reads the account.
  }, [attempt]);

  signedOutRef.current = () => setMeState(null);

  const setMe = useCallback(
    async (account: CustomerMe): Promise<Destination> => {
      const promptDone = await flags.vehiclePromptDone(account.id);
      setMeState(account);
      setVehiclePromptDone(promptDone);
      return nextDestination({ me: account, welcomeSeen, vehiclePromptDone: promptDone });
    },
    [welcomeSeen],
  );

  const value = useMemo<SessionValue | null>(() => {
    if (!bundle) return null;
    return {
      ...bundle,
      phase,
      me,
      reload: () => setAttempt((n) => n + 1),
      setMe,
      markWelcomeSeen: async () => {
        await flags.setWelcomeSeen();
        setWelcomeSeen(true);
      },
      markVehiclePromptDone: async () => {
        if (me) await flags.setVehiclePromptDone(me.id);
        setVehiclePromptDone(true);
      },
      signOut: async () => {
        // the server drops this session's push token with it (V2-016, DEC-519)
        await bundle.api.logout();
        await securePassStore.clear().catch(() => undefined);
        await flags.setPushRegistered(false).catch(() => undefined);
        bundle.events.close();
        setMeState(null);
      },
      forgetAccount: () => {
        void securePassStore.clear().catch(() => undefined);
        void flags.setPushRegistered(false).catch(() => undefined);
        bundle.events.close();
        setMeState(null);
      },
      destination: (next = {}) =>
        nextDestination({
          me: next.me === undefined ? me : next.me,
          welcomeSeen: next.welcomeSeen ?? welcomeSeen,
          vehiclePromptDone: next.vehiclePromptDone ?? vehiclePromptDone,
        }),
    };
  }, [bundle, phase, me, setMe, welcomeSeen, vehiclePromptDone]);

  if (!value) return null;
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession outside SessionProvider');
  return value;
}

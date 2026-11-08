import { useCallback, useRef, useState } from 'react';
import { CommandSession, type CommandRunOptions } from '@/api/command';

/**
 * Command button state (03 §4.1): idle → pending («جارٍ…», double-submit blocked) → server answer.
 * Each hook instance owns one CommandSession, so a retry after a network failure resends the same
 * Idempotency-Key and body; changing the inputs produces a new key.
 *
 *   const start = useCommand((body: StartDuty, key) => api.post('/v1/me/duty/start', { body, idempotencyKey: key }));
 *   <Button loading={start.pending} onClick={() => start.run({})}>…</Button>
 */
export function useCommand<TInput, TResult>(
  send: (input: TInput, idempotencyKey: string) => Promise<TResult>,
  options?: CommandRunOptions,
  /** A session shared beyond this component (the intake step-1 save resent from the next screen). */
  shared?: CommandSession<TInput>,
) {
  const sessionRef = useRef<CommandSession<TInput> | null>(null);
  if (!sessionRef.current) sessionRef.current = new CommandSession<TInput>();
  const sharedRef = useRef(shared);
  sharedRef.current = shared;
  const sendRef = useRef(send);
  sendRef.current = send;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const run = useCallback(
    async (input: TInput): Promise<TResult> => {
      const session = (sharedRef.current ?? sessionRef.current) as CommandSession<TInput>;
      setPending(true);
      setError(null);
      try {
        return await session.run(input, (i, key) => sendRef.current(i, key), options);
      } catch (e) {
        setError(e);
        throw e;
      } finally {
        setPending(session.busy);
      }
    },
    [options],
  );

  const reset = useCallback(() => {
    (sharedRef.current ?? sessionRef.current)?.reset();
    setError(null);
  }, []);

  return { run, pending, error, reset };
}

/**
 * Double-submit guard for non-idempotent submits (login, MFA, secret change): a second press while the
 * first request is in flight returns the same promise and sends nothing.
 */
export function useSubmitGuard() {
  const inFlight = useRef<Promise<unknown> | null>(null);
  const [pending, setPending] = useState(false);
  const guard = useCallback(<T>(task: () => Promise<T>): Promise<T> => {
    if (inFlight.current) return inFlight.current as Promise<T>;
    setPending(true);
    const p = task().finally(() => {
      inFlight.current = null;
      setPending(false);
    });
    inFlight.current = p;
    return p;
  }, []);
  return { guard, pending };
}

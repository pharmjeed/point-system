import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { ApiError, displayMessage } from '@/api/errors';
import type { FieldError } from '@/api/types';
import { useCommand } from '@/hooks/useCommand';
import { staff } from '@/i18n/ar.staff';
import { useUiStore } from '@/stores/ui';

/**
 * A staff command (03 §4.1): `useCommand` (one Idempotency-Key per intent, same key on retry) + the shared
 * reply handling of 02 §1.9 / 08 §3:
 * - 2xx → success toast (3 s, DEC-87) and invalidation of the affected queries (the reply is the truth);
 * - business errors → the server's `message_ar` in place (DEC-80), fields of VALIDATION_FAILED /
 *   REASON_REQUIRED per input; VERSION_CONFLICT / INVALID_STATE_TRANSITION / *_NOT_FOUND refetch the entity;
 * - PERMISSION_DENIED is toasted by RootLayout (which also refetches /v1/me); `onPermissionDenied` lets the
 *   caller close its dialog.
 */
export interface StaffCommandOptions<TResult> {
  invalidate?: QueryKey[];
  successMessage?: string | null;
  onSuccess?: (result: TResult) => void | Promise<void>;
  onPermissionDenied?: () => void;
}

const REFETCH_CODES = [
  'VERSION_CONFLICT',
  'INVALID_STATE_TRANSITION',
  'TICKET_NOT_FOUND',
  'RESOURCE_NOT_FOUND',
  'TICKET_CLOSED',
  'EVENT_ALREADY_CLOSED',
  'TRANSFER_ALREADY_PENDING',
  'PAYMENT_ALREADY_RECORDED',
  'PAYMENT_ALREADY_REVERSED',
  'HANDOVER_NOT_READY',
];

/** Field errors keyed by the dotted path of `details.fields` (08 §4.3); REASON_REQUIRED → `reason`. */
export function fieldErrorsOf(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError)) return {};
  const out: Record<string, string> = {};
  if (error.code === 'REASON_REQUIRED') out.reason = error.message_ar;
  if (error.code === 'VALIDATION_FAILED' || error.code === 'PHONE_INVALID') {
    const fields: FieldError[] = error.fields;
    for (const f of fields) if (!out[f.field]) out[f.field] = f.message_ar || error.message_ar;
    const single = typeof error.details.field === 'string' ? error.details.field : null;
    if (single && !out[single]) out[single] = error.message_ar;
  }
  return out;
}

export function useStaffCommand<TInput, TResult>(
  send: (input: TInput, key: string) => Promise<TResult>,
  options: StaffCommandOptions<TResult> = {},
) {
  const qc = useQueryClient();
  const pushToast = useUiStore((s) => s.pushToast);
  const command = useCommand(send);
  const [error, setError] = useState<unknown>(null);

  const run = useCallback(
    async (input: TInput): Promise<TResult | undefined> => {
      setError(null);
      try {
        const result = await command.run(input);
        if (options.successMessage !== null)
          pushToast({ message: options.successMessage ?? staff.done, tone: 'success' });
        await options.onSuccess?.(result);
        for (const key of options.invalidate ?? []) void qc.invalidateQueries({ queryKey: key });
        return result;
      } catch (e) {
        setError(e);
        if (e instanceof ApiError) {
          if (e.code === 'PERMISSION_DENIED') options.onPermissionDenied?.();
          if (REFETCH_CODES.includes(e.code))
            for (const key of options.invalidate ?? []) void qc.invalidateQueries({ queryKey: key });
        }
        return undefined;
      }
    },
    [command, options, pushToast, qc],
  );

  const reset = useCallback(() => {
    command.reset();
    setError(null);
  }, [command]);

  const apiError = error instanceof ApiError ? error : null;
  const fields = fieldErrorsOf(error);
  return {
    run,
    pending: command.pending,
    error,
    apiError,
    /** Text for the form-level error line (server `message_ar`, or the network text). */
    message: error ? displayMessage(error) : null,
    fields,
    reset,
  };
}

import type { ReactNode, Ref, TextareaHTMLAttributes } from 'react';
import { Field } from './Field';

export interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  ref?: Ref<HTMLTextAreaElement>;
}

/** Multi-line field with the TextField rules; the mandatory reason in Dialog (`REASON_REQUIRED`). */
export function TextArea({ id, label, hint, error, disabled, rows = 3, ref, ...rest }: TextAreaProps) {
  return (
    <Field id={id} label={label} hint={hint} error={error} disabled={disabled}>
      {(describedBy) => (
        <textarea
          {...rest}
          ref={ref}
          id={id}
          rows={rows}
          className="pt-textarea"
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
        />
      )}
    </Field>
  );
}

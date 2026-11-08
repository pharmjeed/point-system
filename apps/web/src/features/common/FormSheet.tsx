import type { ReactNode } from 'react';
import { Banner, Button, Sheet } from '@/components';
import { ui } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import type { FormErrors } from './formErrors';

export interface FormSheetProps {
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  submitLabel: string;
  /** The command; the button shows «جارٍ…» and is disabled until it settles (03 §4.1). */
  onSubmit: () => Promise<unknown> | void;
  pending?: boolean;
  errors?: FormErrors;
  children: ReactNode;
}

/**
 * A create/edit form in a bottom sheet (03 §3.14 `Sheet`): fields, the form-level error with its follow-up
 * code (02 §1.6), and one primary button. Inputs survive a failed command; the sheet stays open while the
 * command runs.
 */
export function FormSheet({
  id,
  open,
  onOpenChange,
  title,
  submitLabel,
  onSubmit,
  pending,
  errors,
  children,
}: FormSheetProps) {
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
      title={title}
    >
      <form
        id={id}
        className="flex flex-col gap-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!pending) void onSubmit();
        }}
      >
        {children}
        {errors?.form ? (
          <Banner
            kind="error"
            rounded
            message={errors.form}
            detail={errors.requestId ? fmt(ui.requestId, { id: errors.requestId }) : undefined}
          />
        ) : null}
        <Button type="submit" fullWidth loading={pending} id={`${id}-submit`}>
          {submitLabel}
        </Button>
      </form>
    </Sheet>
  );
}

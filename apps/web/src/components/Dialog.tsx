import * as RadixDialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import { buttons, components } from '@/i18n/ar';
import { Button } from './Button';
import { FieldError } from './Field';
import { TextArea } from './TextArea';

export interface DialogProps {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  title: string;
  body?: ReactNode;
  children?: ReactNode;
  /** Shows the mandatory reason field (`REASON_REQUIRED`, 03 §3.14). */
  reasonRequired?: boolean;
  reason?: string;
  onReasonChange?: (reason: string) => void;
  /** Confirm button in `danger` for destructive actions. */
  destructive?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Hide the cancel button (e.g. an acknowledgement dialog). */
  hideCancel?: boolean;
  loading?: boolean;
  disabled?: boolean;
  error?: ReactNode;
  onConfirm?: () => void | Promise<unknown>;
  onCancel?: () => void;
  /** Static rendering inside the page (component gallery). */
  inline?: boolean;
  id?: string;
}

function DialogContent(props: DialogProps & { titleNode: ReactNode; descriptionNode: ReactNode }) {
  const { id = 'dlg', reasonRequired, reason, onReasonChange, error, children } = props;
  return (
    <>
      {props.titleNode}
      {props.descriptionNode}
      {children}
      {reasonRequired ? (
        <TextArea
          id={`${id}-reason`}
          label={components.dialog.reason}
          value={reason ?? ''}
          rows={2}
          error={error}
          onChange={(e) => onReasonChange?.(e.target.value)}
        />
      ) : error ? (
        <FieldError role="alert">{error}</FieldError>
      ) : null}
      <div className="pt-dialog__actions">
        {props.onConfirm ? (
          <Button
            variant={props.destructive ? 'danger' : 'primary'}
            fullWidth
            loading={props.loading}
            disabled={props.disabled}
            onClick={props.onConfirm}
          >
            {props.confirmLabel ?? buttons.confirm}
          </Button>
        ) : null}
        {props.hideCancel ? null : (
          <Button variant="secondary" fullWidth disabled={props.loading} onClick={props.onCancel}>
            {props.cancelLabel ?? buttons.cancel}
          </Button>
        )}
      </div>
    </>
  );
}

/**
 * Confirmation of irreversible actions (03 §3.14, §4.5) on Radix Dialog: focus moves into the dialog and
 * is trapped; Escape/cancel return it to the opener (02 §7.10).
 */
export function Dialog(props: DialogProps) {
  const { id = 'dlg', inline, title, body } = props;
  if (inline) {
    return (
      <div className="pt-dialog-backdrop pt-dialog-backdrop--inline">
        <div className="pt-dialog" role="alertdialog" aria-modal="false" aria-labelledby={`${id}-t`}>
          <DialogContent
            {...props}
            titleNode={
              <h2 className="pt-dialog__title" id={`${id}-t`}>
                {title}
              </h2>
            }
            descriptionNode={body ? <p className="pt-dialog__body">{body}</p> : null}
          />
        </div>
      </div>
    );
  }
  return (
    <RadixDialog.Root
      open={props.open}
      onOpenChange={(open) => {
        if (!open && props.loading) return; // keep it open while the command runs
        props.onOpenChange?.(open);
        if (!open) props.onCancel?.();
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="pt-dialog-backdrop" />
        <RadixDialog.Content
          className="pt-dialog"
          role="alertdialog"
          {...(body ? {} : { 'aria-describedby': undefined })}
          onPointerDownOutside={(e) => e.preventDefault()}
        >
          <DialogContent
            {...props}
            titleNode={<RadixDialog.Title className="pt-dialog__title">{title}</RadixDialog.Title>}
            descriptionNode={
              body ? (
                <RadixDialog.Description className="pt-dialog__body">{body}</RadixDialog.Description>
              ) : null
            }
          />
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

import { Dialog } from '@/components';
import { buttons } from '@/i18n/ar';
import { s05 } from '@/i18n/ar.staff';
import { fmt } from '@/i18n/fmt';

/**
 * The temporary PIN from `POST /v1/drivers` or `/reset-secret`, shown once (02 S-05/S-06). It lives in this
 * component's props only — never in a query cache, URL or browser storage — and is gone when the dialog
 * closes.
 */
export function TempSecretDialog({
  name,
  secret,
  onClose,
}: {
  name: string;
  secret: string | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      id="temp-secret"
      open={secret !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={name}
      body={secret ? fmt(s05.tempSecret, { secret }) : undefined}
      confirmLabel={buttons.gotIt}
      hideCancel
      onConfirm={onClose}
      onCancel={onClose}
    />
  );
}

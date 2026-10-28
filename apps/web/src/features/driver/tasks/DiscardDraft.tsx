import { useState } from 'react';
import { useNavigate } from 'react-router';
import { displayMessage, isApiError } from '@/api/errors';
import { discardDraft } from '@/api/field';
import type { TicketDetail } from '@/api/types';
import { paths } from '@/app/paths';
import { Button, Dialog } from '@/components';
import { useCommand } from '@/hooks/useCommand';
import { buttons, d05 } from '@/i18n/ar';
import { useUiStore } from '@/stores/ui';
import { useIntakeStore } from '../intakeStore';
import { useRefreshHome } from '../useDriverHome';

/**
 * «إلغاء» in the D-05/D-06 header (02 D-05): «إلغاء الاستلام؟» → `POST /v1/tickets/{id}/discard-draft`.
 * An empty draft is voided («أُلغي الاستلام» → D-04); a draft with data answers DRAFT_HAS_DATA and stays the
 * driver's current task until a supervisor voids it (DEC-20).
 */
export function DiscardDraft({ ticket, disabled }: { ticket: TicketDetail; disabled?: boolean }) {
  const navigate = useNavigate();
  const refresh = useRefreshHome();
  const pushToast = useUiStore((s) => s.pushToast);
  const clear = useIntakeStore((s) => s.clear);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [hasData, setHasData] = useState<string | null>(null);
  const discard = useCommand((body: { expected_version: number }, key: string) =>
    discardDraft(ticket.id, body, key),
  );

  const onConfirm = async () => {
    try {
      await discard.run({ expected_version: ticket.version });
      setConfirmOpen(false);
      clear(ticket.id);
      pushToast({ message: d05.canceled, tone: 'success' });
      void refresh();
      navigate(paths.driverHome, { replace: true });
    } catch (error) {
      if (isApiError(error, 'DRAFT_HAS_DATA')) {
        setConfirmOpen(false);
        setHasData(displayMessage(error));
      }
    }
  };

  return (
    <>
      <Button
        variant="ghost"
        compact
        id="intake-cancel"
        disabled={disabled}
        onClick={() => setConfirmOpen(true)}
      >
        {buttons.cancel}
      </Button>
      <Dialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={d05.cancelTitle}
        destructive
        confirmLabel={d05.cancelConfirm}
        cancelLabel={d05.cancelKeep}
        loading={discard.pending}
        error={
          discard.error && !isApiError(discard.error, 'DRAFT_HAS_DATA')
            ? displayMessage(discard.error)
            : undefined
        }
        onConfirm={onConfirm}
        onCancel={() => {
          setConfirmOpen(false);
          discard.reset();
        }}
      />
      <Dialog
        open={hasData !== null}
        onOpenChange={(open) => {
          if (!open) setHasData(null);
        }}
        title={hasData ?? ''}
        confirmLabel={buttons.gotIt}
        hideCancel
        onConfirm={() => setHasData(null)}
      />
    </>
  );
}

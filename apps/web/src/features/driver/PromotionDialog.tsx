import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import type { TaskCard } from '@/api/types';
import { Dialog } from '@/components';
import { d04 } from '@/i18n/ar';
import { withTicket } from '@/i18n/fmtNode';
import { playSound } from '@/lib/audio';
import { driverPaths } from './fieldModel';

/**
 * «بدأت مهمتك التالية: #131» → «الانتقال» to D-10 (02 D-04, D-08, D-11). Plays `next_due` when the sound
 * was unlocked in D-03; nothing otherwise (PNT-066 owns the blocked-audio banner).
 */
export function PromotionDialog({
  task,
  title = d04.promoted,
  onClose,
}: {
  task: TaskCard | null;
  title?: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const taskId = task?.task.id;
  useEffect(() => {
    if (taskId) void playSound('next_due');
  }, [taskId]);
  return (
    <Dialog
      open={!!task}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={task ? withTicket(title, task.ticket.display_number) : ''}
      confirmLabel={d04.goToTask}
      hideCancel
      onConfirm={() => {
        onClose();
        if (task) navigate(driverPaths.task(task.task.id));
      }}
    />
  );
}

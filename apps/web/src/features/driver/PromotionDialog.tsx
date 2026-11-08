import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import type { TaskCard } from '@/api/types';
import { Dialog } from '@/components';
import { d04 } from '@/i18n/ar';
import { withTicket } from '@/i18n/fmtNode';
import { playSound } from '@/lib/audio';
import { useFieldStore } from '@/stores/field';
import { driverPaths } from './fieldModel';

/** Promotions whose `next_due` already played (the frame remounts between the task screens and the tabs). */
const played = new Set<string>();

/**
 * «بدأت مهمتك التالية: #131» → «الانتقال» to D-10 (02 D-04, D-08, D-11). Plays `next_due` (with the Android
 * vibration) once per promotion when the sound is unlocked; otherwise nothing is attempted and the D-15 د
 * banner is on screen.
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
    if (!taskId || played.has(taskId)) return;
    played.add(taskId);
    void playSound('next_due', { key: `task:${taskId}` });
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

/**
 * The frame's dialog: the promotion of the field store, on every driver screen (02 D-04), from its `showAt`
 * on (02 D-11: two seconds after «تم تسليم #125»).
 */
export function FramePromotion() {
  const promotion = useFieldStore((s) => s.promotion);
  const setPromotion = useFieldStore((s) => s.setPromotion);
  const showAt = promotion?.showAt ?? 0;
  const [, setTick] = useState(0);
  useEffect(() => {
    const wait = showAt - Date.now();
    if (wait <= 0) return;
    const timer = setTimeout(() => setTick((n) => n + 1), wait + 20);
    return () => clearTimeout(timer);
  }, [showAt]);
  const due = promotion && showAt <= Date.now() ? promotion : null;
  return <PromotionDialog task={due?.card ?? null} title={due?.title} onClose={() => setPromotion(null)} />;
}

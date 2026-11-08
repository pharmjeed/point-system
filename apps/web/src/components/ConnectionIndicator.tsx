import type { ConnectionState } from '@/api/types';
import { connectionState, ui } from '@/i18n/ar';
import { cx } from '@/lib/cx';
import { Icon } from './Icon';
import { CONNECTION_ICON } from './statusMaps';

export interface ConnectionIndicatorProps {
  state: ConnectionState;
  /** Formatted time of the last sync; shown when not online (03 §3.3). */
  lastSync?: string | null;
  /** Opens the connection Sheet (02 §1.3). Makes the indicator a 44px button. */
  onClick?: () => void;
}

/**
 * Dot + icon + text. The dot uses --pt-conn-*; the text uses the -text roles because amber on white is
 * below 3:1 (design system note). Independent of tasks: it never changes availability by itself.
 */
export function ConnectionIndicator({ state, lastSync, onClick }: ConnectionIndicatorProps) {
  const content = (
    <>
      <span className="pt-conn__dot" aria-hidden="true" />
      <Icon icon={CONNECTION_ICON[state]} size={16} />
      <span>{connectionState[state]}</span>
      {state !== 'online' && lastSync ? (
        <span className="pt-conn__sync">
          {ui.lastSyncLabel} <bdi dir="ltr">{lastSync}</bdi>
        </span>
      ) : null}
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        className={cx('pt-conn', `pt-conn--${state}`)}
        onClick={onClick}
        aria-live="polite"
      >
        {content}
      </button>
    );
  }
  return (
    <span className={cx('pt-conn', `pt-conn--${state}`)} role="status" aria-live="polite">
      {content}
    </span>
  );
}

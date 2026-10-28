import { ui } from '@/i18n/ar';

export interface SkeletonProps {
  variant?: 'card' | 'line';
  withAction?: boolean;
  width?: string;
}

/** First load only; later syncs keep the old data visible with an indicator (03 §3.14). */
export function Skeleton({ variant = 'card', withAction, width }: SkeletonProps) {
  if (variant === 'line') {
    return (
      <span className="pt-skel pt-skel--line" style={{ inlineSize: width ?? '100%' }} aria-hidden="true" />
    );
  }
  return (
    <div className="pt-skel-card" aria-busy="true" aria-label={ui.loadingPage} role="status">
      <span className="pt-skel pt-skel--chip" />
      <span className="pt-skel pt-skel--title" />
      <span className="pt-skel pt-skel--line" style={{ inlineSize: '80%' }} />
      <span className="pt-skel pt-skel--line" style={{ inlineSize: '55%' }} />
      {withAction ? <span className="pt-skel pt-skel--btn" /> : null}
    </div>
  );
}

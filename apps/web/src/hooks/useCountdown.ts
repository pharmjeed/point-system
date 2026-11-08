import { useEffect, useState } from 'react';
import { serverNow } from '@/lib/serverClock';

const secondsLeft = (untilMs: number | null) =>
  untilMs === null ? 0 : Math.max(0, Math.ceil((untilMs - serverNow()) / 1000));

/** Whole seconds left until `untilMs` (server time), ticking every second; 0 when passed or null. */
export function useCountdown(untilMs: number | null): number {
  const [left, setLeft] = useState(() => secondsLeft(untilMs));
  useEffect(() => {
    setLeft(secondsLeft(untilMs));
    if (untilMs === null) return;
    const timer = setInterval(() => {
      const next = secondsLeft(untilMs);
      setLeft(next);
      if (next <= 0) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [untilMs]);
  return left;
}

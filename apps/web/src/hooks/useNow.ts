import { useEffect, useState } from 'react';
import { serverNow } from '@/lib/serverClock';

/** Server-corrected "now" (02 §1.7), re-rendering every `intervalMs` while mounted. */
export function useServerNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => serverNow());
  useEffect(() => {
    const timer = setInterval(() => setNow(serverNow()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

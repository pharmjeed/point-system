/**
 * Incoming links before routing (V2-052, DEC-566): universal links / App Links under `/app` and the gateway's
 * 3-D Secure return (src/features/links.ts). Never throws: an unreadable link leaves the app where it is.
 */
import { systemPathFor } from '../features/links';

export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string | null {
  try {
    return systemPathFor(path, initial);
  } catch {
    return initial ? '/' : null;
  }
}

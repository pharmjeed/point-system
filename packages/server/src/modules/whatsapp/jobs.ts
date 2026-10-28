import type { JobHandler } from '../../core/outbox/dispatcher.js';
import { waProcessInboundHandler } from './application/inbound-processor.js';
import { waSendHandler } from './application/sender.js';
import { defaultWhatsappRuntime, WhatsappRuntime } from './runtime.js';

/**
 * worker process: `job.wa_send` (PNT-042) and `job.wa_process_inbound` (PNT-041). The runtime is built
 * lazily from the validated process environment unless one is given (tests, other hosts).
 */
export function whatsappJobs(
  opts: { runtime?: WhatsappRuntime | (() => WhatsappRuntime) } = {},
): JobHandler[] {
  const given = opts.runtime;
  const runtime =
    given instanceof WhatsappRuntime
      ? () => given
      : typeof given === 'function'
        ? given
        : defaultWhatsappRuntime;
  return [waSendHandler(runtime), waProcessInboundHandler(runtime)];
}

import { waCatalog, type WaCatalog } from '@point/shared';

/**
 * The customer copy of this process for the code that runs outside a WhatsappRuntime — the early template checks of
 * the commands (`assertTemplateApproved`, `assertCodeMessageSendable`, 08 §4.13) must test the template the sender
 * will send, i.e. the live set of `WA_TEMPLATE_SET` (DEC-555). Every WhatsappRuntime (api module, worker) registers
 * its catalog when it is built from the process configuration; before that the default catalog (`v1`) applies.
 */
let live: WaCatalog = waCatalog();

export function setLiveWaCatalog(catalog: WaCatalog): void {
  live = catalog;
}

export function liveWaCatalog(): WaCatalog {
  return live;
}

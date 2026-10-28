import { startDirectLink } from '../../modules/whatsapp/index.js';
import { registerCustomerLinkingHook, type CustomerLinkingHook } from '../hooks.js';
import { eventActor } from '../shared.js';

/**
 * SubmitIntake's direct WhatsApp link (PNT-043, 11 TT-03, 12 §7.1): the whatsapp LinkService moves the ticket
 * to `pending_send` (WA_TEMPLATE_NOT_APPROVED when the W-01 template is not approved) and emits
 * `ticket.wa_link_changed {method: direct}`; SubmitIntake then emits `ticket.intake_submitted` with
 * `pending_send` and the NotificationPlanner plans one W-01 (key `wa:W-01:{ticket}:lv{n}`).
 */
export const directLinkAtSubmit: CustomerLinkingHook = {
  async onIntakeSubmitted(tx, { ticket, actor }) {
    return startDirectLink(tx, ticket, { actor: eventActor(actor) });
  },
};

export function installCustomerLinking(): void {
  registerCustomerLinkingHook(directLinkAtSubmit);
}

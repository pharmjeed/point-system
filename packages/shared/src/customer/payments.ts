/**
 * Paying a visit in the app and the saved cards (V2-022 / V2-023; docs/v2/01 R4, C-10, C-12, C-17, C-18; docs/v2/04
 * §2, §3; DEC-521 … DEC-525). The card never reaches the server (SAQ-A, V2-D08): the device tokenizes it with the
 * gateway's publishable key (Moyasar `POST /v1/tokens`) or hands over the Apple Pay token, and the server only ever
 * sends `{ type: 'token', token }` / `{ type: 'applepay', token }` to the gateway (DEC-510). The amount is decided by
 * the server (the ticket's fee, VAT included — DEC-521), never by the app.
 */
import { z } from 'zod';
import { OnlinePaymentStatusSchema } from '../canon/payments-online.js';

/** A gateway token as `customer_payment_methods.gateway_token` accepts it, and never a card number. */
const GatewayTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,128}$/)
  .refine((t) => !/[0-9]{13,}/.test(t), { message: 'looks like a card number' });

/** Where the money comes from (C-10): a card tokenized on the device, Apple Pay, or a saved card (C-18). */
export const CustomerPaymentSourceSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('token'), token: GatewayTokenSchema }),
  // the Apple Pay payment token as PassKit hands it over (opaque, encrypted for the gateway); never stored
  z.strictObject({ type: z.literal('applepay'), token: z.string().min(1).max(16_000) }),
  z.strictObject({ type: z.literal('saved'), payment_method_id: z.uuid() }),
]);
export type CustomerPaymentSource = z.infer<typeof CustomerPaymentSourceSchema>;

/**
 * `POST /v1/customer/visits/{ticketId}/pay` (Idempotency-Key). `save_card` keeps a tokenized card for later
 * (C-18) once it is paid; it needs the explicit `card_on_file` consent at the version in force
 * (`card_on_file_version`, else CUSTOMER_CONSENT_REQUIRED / CUSTOMER_CONSENT_VERSION_STALE).
 */
export const CustomerVisitPayBodySchema = z
  .strictObject({
    source: CustomerPaymentSourceSchema,
    save_card: z.boolean().optional(),
    card_on_file_version: z.string().min(1).max(40).optional(),
  })
  .refine((b) => !b.save_card || b.source.type === 'token', {
    message: 'only a card tokenized on the device can be saved',
    path: ['save_card'],
  });
export type CustomerVisitPayBody = z.infer<typeof CustomerVisitPayBodySchema>;

/**
 * The simplified-invoice data of a paid visit (C-17), computed from the payment itself — nothing is stored for it
 * before the e-invoicing provider exists (V2-040, ZATCA): seller, place, amounts with the VAT apart, card.
 */
export const CustomerReceiptSchema = z.object({
  payment_id: z.uuid(),
  issued_at: z.iso.datetime({ offset: true }),
  seller_name_ar: z.string(),
  seller_name_en: z.string(),
  venue_name_ar: z.string(),
  venue_name_en: z.string().nullable(),
  operator_name_ar: z.string(),
  operator_name_en: z.string().nullable(),
  description: z.literal('visit'),
  amount_halalas: z.number().int(),
  net_halalas: z.number().int(),
  vat_halalas: z.number().int(),
  vat_rate_bp: z.number().int(),
  refunded_halalas: z.number().int(),
  currency: z.literal('SAR'),
  card_brand: z.string().nullable(),
  card_last4: z.string().nullable(),
});
export type CustomerReceipt = z.infer<typeof CustomerReceiptSchema>;

/**
 * A visit payment as the app sees it: the answer of the pay command and of `GET /v1/customer/payments/{id}` (the
 * app polls it after 3-D Secure — the return to `callback_url` itself changes nothing, DEC-512). `transaction_url`
 * is the gateway's 3-D Secure page while the payment waits for it; the app opens it in an in-app browser and
 * stops when the browser reaches `callback_url`.
 */
export const CustomerVisitPaymentSchema = z.object({
  payment_id: z.uuid(),
  ticket_id: z.uuid(),
  status: OnlinePaymentStatusSchema,
  amount_halalas: z.number().int(),
  vat_halalas: z.number().int(),
  currency: z.literal('SAR'),
  card_brand: z.string().nullable(),
  card_last4: z.string().nullable(),
  failure_code: z.string().nullable(),
  transaction_url: z.string().nullable(),
  callback_url: z.string(),
  paid_at: z.iso.datetime({ offset: true }).nullable(),
  /** C-18: the card kept by `save_card` once the payment is paid */
  saved_payment_method_id: z.uuid().nullable(),
  receipt: CustomerReceiptSchema.nullable(),
});
export type CustomerVisitPayment = z.infer<typeof CustomerVisitPaymentSchema>;

// ---- C-18 saved cards (V2-023) ----

/** A saved card: the gateway token stays on the server; the app sees brand, last 4 digits and expiry only. */
export const CustomerPaymentMethodSchema = z.object({
  id: z.uuid(),
  brand: z.string().nullable(),
  last4: z.string().nullable(),
  expires_month: z.number().int().nullable(),
  expires_year: z.number().int().nullable(),
  is_default: z.boolean(),
  created_at: z.iso.datetime({ offset: true }),
});
export type CustomerPaymentMethod = z.infer<typeof CustomerPaymentMethodSchema>;

export const CustomerPaymentMethodListSchema = z.object({ items: z.array(CustomerPaymentMethodSchema) });
export type CustomerPaymentMethodList = z.infer<typeof CustomerPaymentMethodListSchema>;

/**
 * `POST /v1/customer/payment-methods` (Idempotency-Key): a card tokenized on the device (Moyasar `save_only`), saved
 * with the explicit `card_on_file` consent at the version in force. The server reads brand/last4/expiry from the
 * gateway, never from the app.
 */
export const CustomerPaymentMethodCreateBodySchema = z.strictObject({
  token: GatewayTokenSchema,
  card_on_file_version: z.string().min(1).max(40).optional(),
  make_default: z.boolean().optional(),
});
export type CustomerPaymentMethodCreateBody = z.infer<typeof CustomerPaymentMethodCreateBodySchema>;

/** `PATCH /v1/customer/payment-methods/{paymentMethodId}`: makes this card the default one. */
export const CustomerPaymentMethodPatchBodySchema = z.strictObject({ is_default: z.literal(true) });
export type CustomerPaymentMethodPatchBody = z.infer<typeof CustomerPaymentMethodPatchBodySchema>;

export const CustomerPaymentMethodRemovedSchema = z.object({
  payment_method_id: z.uuid(),
  removed_at: z.iso.datetime({ offset: true }),
});
export type CustomerPaymentMethodRemoved = z.infer<typeof CustomerPaymentMethodRemovedSchema>;

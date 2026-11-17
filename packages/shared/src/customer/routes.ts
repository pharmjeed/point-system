/**
 * The customer routes delivered with V2-011's contracts (05 §1, DEC-482). `auth`: `public` (no token) or
 * `customer` (`Authorization: Bearer <access_token>`). `idempotency: 'required'` = every write command takes an
 * `Idempotency-Key` (07 rules, 05 preamble); the sign-in calls are rate limited instead, as `/v1/auth/login`.
 */
import type { z } from 'zod';
import type { RateLimitClass } from '../canon/routes.js';
import { CustomerConsentsBodySchema, CustomerMePatchBodySchema, CustomerMeSchema } from './account.js';
import {
  CustomerAuthResultSchema,
  CustomerLogoutBodySchema,
  CustomerLogoutResultSchema,
  CustomerOtpChallengeSchema,
  CustomerOtpRequestBodySchema,
  CustomerOtpVerifyBodySchema,
  CustomerRefreshBodySchema,
  CustomerTokensSchema,
} from './auth.js';
import {
  CustomerAccountDeleteBodySchema,
  CustomerAccountDeletedSchema,
  CustomerReauthSchema,
  CustomerReauthVerifyBodySchema,
} from './deletion.js';
import { CustomerHomeSchema } from './home.js';
import { CustomerLocationDetailSchema, CustomerLocationListSchema } from './locations.js';
import { CustomerPassSchema } from './pass-contract.js';
import { CustomerDeviceBodySchema, CustomerDeviceSchema } from './notifications.js';
import {
  CustomerHandoverCodeSchema,
  CustomerVisitDetailSchema,
  CustomerVisitListSchema,
  CustomerVisitRatingBodySchema,
  CustomerVisitRatingSchema,
  CustomerVisitRequestBodySchema,
  CustomerVisitRequestResultSchema,
} from './visits.js';
import {
  CustomerPaymentMethodCreateBodySchema,
  CustomerPaymentMethodListSchema,
  CustomerPaymentMethodPatchBodySchema,
  CustomerPaymentMethodRemovedSchema,
  CustomerPaymentMethodSchema,
  CustomerVisitPayBodySchema,
  CustomerOnlinePaymentSchema,
} from './payments.js';
import {
  CustomerVehicleCreateBodySchema,
  CustomerVehicleListSchema,
  CustomerVehicleRemovedSchema,
  CustomerVehicleSchema,
} from './vehicles.js';
import {
  CustomerSubscribeBodySchema,
  CustomerSubscriptionCheckoutSchema,
  CustomerSubscriptionCommandBodySchema,
  CustomerSubscriptionListSchema,
  CustomerSubscriptionPayBodySchema,
  CustomerSubscriptionSchema,
  CustomerSubscriptionVehiclesBodySchema,
  CustomerSubscriptionApplyBodySchema,
  CustomerSubscriptionFreezeBodySchema,
} from './subscriptions.js';
import { CustomerInvoiceDetailSchema, CustomerInvoiceListSchema } from './invoices.js';
import {
  CustomerComplaintCreateBodySchema,
  CustomerComplaintListSchema,
  CustomerComplaintSchema,
} from './complaints.js';

export interface CustomerRouteDef {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path template, e.g. `/v1/customer/vehicles/{vehicleId}`. */
  path: string;
  auth: 'public' | 'customer';
  idempotency: 'required' | 'none';
  /**
   * `x-rate-limit-class` (07 §1.9; V2-010, DEC-499): `auth` per client address on the sign-in calls (the code
   * request has its own per-number and per-device limits on top), `write`/`read` per account.
   */
  rateLimitClass: RateLimitClass;
  body?: z.ZodType;
  /** Schema of `data` in the success envelope. */
  data: z.ZodType;
}

export const CUSTOMER_ROUTES = {
  otpRequest: {
    method: 'POST',
    path: '/v1/customer/auth/otp',
    auth: 'public',
    idempotency: 'none',
    rateLimitClass: 'auth',
    body: CustomerOtpRequestBodySchema,
    data: CustomerOtpChallengeSchema,
  },
  otpVerify: {
    method: 'POST',
    path: '/v1/customer/auth/verify',
    auth: 'public',
    idempotency: 'none',
    rateLimitClass: 'auth',
    body: CustomerOtpVerifyBodySchema,
    data: CustomerAuthResultSchema,
  },
  refresh: {
    method: 'POST',
    path: '/v1/customer/auth/refresh',
    auth: 'public',
    idempotency: 'none',
    rateLimitClass: 'auth',
    body: CustomerRefreshBodySchema,
    data: CustomerTokensSchema,
  },
  logout: {
    method: 'POST',
    path: '/v1/customer/auth/logout',
    auth: 'customer',
    idempotency: 'none',
    rateLimitClass: 'write',
    body: CustomerLogoutBodySchema,
    data: CustomerLogoutResultSchema,
  },
  me: {
    method: 'GET',
    path: '/v1/customer/me',
    auth: 'customer',
    idempotency: 'none',
    rateLimitClass: 'read',
    data: CustomerMeSchema,
  },
  mePatch: {
    method: 'PATCH',
    path: '/v1/customer/me',
    auth: 'customer',
    idempotency: 'required',
    rateLimitClass: 'write',
    body: CustomerMePatchBodySchema,
    data: CustomerMeSchema,
  },
  consents: {
    method: 'POST',
    path: '/v1/customer/consents',
    auth: 'customer',
    idempotency: 'required',
    rateLimitClass: 'write',
    body: CustomerConsentsBodySchema,
    data: CustomerMeSchema,
  },
  vehicles: {
    method: 'GET',
    path: '/v1/customer/vehicles',
    auth: 'customer',
    idempotency: 'none',
    rateLimitClass: 'read',
    data: CustomerVehicleListSchema,
  },
  vehicleCreate: {
    method: 'POST',
    path: '/v1/customer/vehicles',
    auth: 'customer',
    idempotency: 'required',
    rateLimitClass: 'write',
    body: CustomerVehicleCreateBodySchema,
    data: CustomerVehicleSchema,
  },
  locations: {
    method: 'GET',
    path: '/v1/customer/locations',
    auth: 'customer',
    idempotency: 'none',
    rateLimitClass: 'read',
    data: CustomerLocationListSchema,
  },
  location: {
    method: 'GET',
    path: '/v1/customer/locations/{venueId}',
    auth: 'customer',
    idempotency: 'none',
    rateLimitClass: 'read',
    data: CustomerLocationDetailSchema,
  },
  home: {
    method: 'GET',
    path: '/v1/customer/home',
    auth: 'customer',
    idempotency: 'none',
    rateLimitClass: 'read',
    data: CustomerHomeSchema,
  },
  // ---- V2-012 (C-15) and V2-017 (C-20): remove a vehicle, re-verify, delete the account (DEC-505, DEC-507)
  vehicleDelete: {
    method: 'DELETE',
    path: '/v1/customer/vehicles/{vehicleId}',
    auth: 'customer',
    idempotency: 'required',
    rateLimitClass: 'write',
    data: CustomerVehicleRemovedSchema,
  },
  reauthVerify: {
    method: 'POST',
    path: '/v1/customer/auth/reauth/verify',
    auth: 'customer',
    idempotency: 'none',
    rateLimitClass: 'auth',
    body: CustomerReauthVerifyBodySchema,
    data: CustomerReauthSchema,
  },
  meDelete: {
    method: 'DELETE',
    path: '/v1/customer/me',
    auth: 'customer',
    idempotency: 'required',
    rateLimitClass: 'write',
    body: CustomerAccountDeleteBodySchema,
    data: CustomerAccountDeletedSchema,
  },
  // --- V2-013 (DEC-500): the entry pass, C-11 ---
  pass: {
    method: 'GET',
    path: '/v1/customer/pass',
    auth: 'customer',
    idempotency: 'none',
    rateLimitClass: 'read',
    data: CustomerPassSchema,
  },
  // --- end V2-013 ---
  // --- V2-015 (C-12, C-16, C-13) and V2-016 (push): DEC-516 … DEC-520 ---
  visits: {
    method: 'GET',
    path: '/v1/customer/visits',
    auth: 'customer',
    idempotency: 'none',
    rateLimitClass: 'read',
    data: CustomerVisitListSchema,
  },
  visit: {
    method: 'GET',
    path: '/v1/customer/visits/{ticketId}',
    auth: 'customer',
    idempotency: 'none',
    rateLimitClass: 'read',
    data: CustomerVisitDetailSchema,
  },
  visitRequest: {
    method: 'POST',
    path: '/v1/customer/visits/{ticketId}/request',
    auth: 'customer',
    idempotency: 'required',
    rateLimitClass: 'write',
    body: CustomerVisitRequestBodySchema,
    data: CustomerVisitRequestResultSchema,
  },
  visitHandoverCode: {
    method: 'GET',
    path: '/v1/customer/visits/{ticketId}/handover-code',
    auth: 'customer',
    idempotency: 'none',
    rateLimitClass: 'read',
    data: CustomerHandoverCodeSchema,
  },
  visitRating: {
    method: 'POST',
    path: '/v1/customer/visits/{ticketId}/rating',
    auth: 'customer',
    idempotency: 'required',
    rateLimitClass: 'write',
    body: CustomerVisitRatingBodySchema,
    data: CustomerVisitRatingSchema,
  },
  devices: {
    method: 'POST',
    path: '/v1/customer/devices',
    auth: 'customer',
    idempotency: 'required',
    rateLimitClass: 'write',
    body: CustomerDeviceBodySchema,
    data: CustomerDeviceSchema,
  },
  // --- end V2-015 / V2-016 ---
  // --- V2-022 / V2-023 (DEC-521 … DEC-525): paying a visit (C-10/C-12) and the saved cards (C-18) ---
  visitPay: {
    method: 'POST',
    path: '/v1/customer/visits/{ticketId}/pay',
    auth: 'customer',
    idempotency: 'required',
    rateLimitClass: 'write',
    body: CustomerVisitPayBodySchema,
    data: CustomerOnlinePaymentSchema,
  },
  payment: {
    method: 'GET',
    path: '/v1/customer/payments/{paymentId}',
    auth: 'customer',
    idempotency: 'none',
    rateLimitClass: 'read',
    data: CustomerOnlinePaymentSchema,
  },
  paymentMethods: {
    method: 'GET',
    path: '/v1/customer/payment-methods',
    auth: 'customer',
    idempotency: 'none',
    rateLimitClass: 'read',
    data: CustomerPaymentMethodListSchema,
  },
  paymentMethodCreate: {
    method: 'POST',
    path: '/v1/customer/payment-methods',
    auth: 'customer',
    idempotency: 'required',
    rateLimitClass: 'write',
    body: CustomerPaymentMethodCreateBodySchema,
    data: CustomerPaymentMethodSchema,
  },
  paymentMethodPatch: {
    method: 'PATCH',
    path: '/v1/customer/payment-methods/{paymentMethodId}',
    auth: 'customer',
    idempotency: 'required',
    rateLimitClass: 'write',
    body: CustomerPaymentMethodPatchBodySchema,
    data: CustomerPaymentMethodSchema,
  },
  paymentMethodDelete: {
    method: 'DELETE',
    path: '/v1/customer/payment-methods/{paymentMethodId}',
    auth: 'customer',
    idempotency: 'required',
    rateLimitClass: 'write',
    data: CustomerPaymentMethodRemovedSchema,
  },
  // --- end V2-022 / V2-023 ---
  // --- V2-032 (DEC-532, DEC-534): the subscriptions — C-09 subscribe, C-10 pay, C-14 cancel / resume / vehicles ---
  subscriptions: {
    method: 'GET',
    path: '/v1/customer/subscriptions',
    auth: 'customer',
    idempotency: 'none',
    rateLimitClass: 'read',
    data: CustomerSubscriptionListSchema,
  },
  subscribe: {
    method: 'POST',
    path: '/v1/customer/subscriptions',
    auth: 'customer',
    idempotency: 'required',
    rateLimitClass: 'write',
    body: CustomerSubscribeBodySchema,
    data: CustomerSubscriptionCheckoutSchema,
  },
  subscription: {
    method: 'GET',
    path: '/v1/customer/subscriptions/{subscriptionId}',
    auth: 'customer',
    idempotency: 'none',
    rateLimitClass: 'read',
    data: CustomerSubscriptionSchema,
  },
  subscriptionPay: {
    method: 'POST',
    path: '/v1/customer/subscriptions/{subscriptionId}/pay',
    auth: 'customer',
    idempotency: 'required',
    rateLimitClass: 'write',
    body: CustomerSubscriptionPayBodySchema,
    data: CustomerSubscriptionCheckoutSchema,
  },
  subscriptionCancel: {
    method: 'POST',
    path: '/v1/customer/subscriptions/{subscriptionId}/cancel',
    auth: 'customer',
    idempotency: 'required',
    rateLimitClass: 'write',
    body: CustomerSubscriptionCommandBodySchema,
    data: CustomerSubscriptionSchema,
  },
  subscriptionResume: {
    method: 'POST',
    path: '/v1/customer/subscriptions/{subscriptionId}/resume',
    auth: 'customer',
    idempotency: 'required',
    rateLimitClass: 'write',
    body: CustomerSubscriptionCommandBodySchema,
    data: CustomerSubscriptionSchema,
  },
  subscriptionVehicles: {
    method: 'PUT',
    path: '/v1/customer/subscriptions/{subscriptionId}/vehicles',
    auth: 'customer',
    idempotency: 'required',
    rateLimitClass: 'write',
    body: CustomerSubscriptionVehiclesBodySchema,
    data: CustomerSubscriptionSchema,
  },
  // --- end V2-032 ---
  // --- V2-036 (DEC-594, DEC-596): the subscriptions annex — eligibility application, the customer's freeze ---
  subscriptionApply: {
    method: 'POST',
    path: '/v1/customer/subscriptions/apply',
    auth: 'customer',
    idempotency: 'required',
    rateLimitClass: 'write',
    body: CustomerSubscriptionApplyBodySchema,
    data: CustomerSubscriptionSchema,
  },
  subscriptionFreeze: {
    method: 'POST',
    path: '/v1/customer/subscriptions/{subscriptionId}/freeze',
    auth: 'customer',
    idempotency: 'required',
    rateLimitClass: 'write',
    body: CustomerSubscriptionFreezeBodySchema,
    data: CustomerSubscriptionSchema,
  },
  subscriptionUnfreeze: {
    method: 'POST',
    path: '/v1/customer/subscriptions/{subscriptionId}/unfreeze',
    auth: 'customer',
    idempotency: 'required',
    rateLimitClass: 'write',
    body: CustomerSubscriptionCommandBodySchema,
    data: CustomerSubscriptionSchema,
  },
  // --- end V2-036 ---
  // --- V2-037 (DEC-603, DEC-604): complaints with a reference number (C-21, C-22) ---
  complaints: {
    method: 'GET',
    path: '/v1/customer/complaints',
    auth: 'customer',
    idempotency: 'none',
    rateLimitClass: 'read',
    data: CustomerComplaintListSchema,
  },
  complaintCreate: {
    method: 'POST',
    path: '/v1/customer/complaints',
    auth: 'customer',
    idempotency: 'required',
    rateLimitClass: 'write',
    body: CustomerComplaintCreateBodySchema,
    data: CustomerComplaintSchema,
  },
  complaint: {
    method: 'GET',
    path: '/v1/customer/complaints/{complaintId}',
    auth: 'customer',
    idempotency: 'none',
    rateLimitClass: 'read',
    data: CustomerComplaintSchema,
  },
  // --- end V2-037 ---
  // --- V2-040: C-17 the customer's invoices and credit notes (DEC-548) ---
  invoices: {
    method: 'GET',
    path: '/v1/customer/invoices',
    auth: 'customer',
    idempotency: 'none',
    rateLimitClass: 'read',
    data: CustomerInvoiceListSchema,
  },
  invoice: {
    method: 'GET',
    path: '/v1/customer/invoices/{invoiceId}',
    auth: 'customer',
    idempotency: 'none',
    rateLimitClass: 'read',
    data: CustomerInvoiceDetailSchema,
  },
  // --- end V2-040 ---
} as const satisfies Record<string, CustomerRouteDef>;

export type CustomerRouteKey = keyof typeof CUSTOMER_ROUTES;

/** Every customer route lives under this prefix; no staff or platform route may (V2-010, DEC-497). */
export const CUSTOMER_PATH_PREFIX = '/v1/customer/';

export function isCustomerPath(path: string): boolean {
  return path.startsWith(CUSTOMER_PATH_PREFIX) || path === '/v1/customer';
}

const CUSTOMER_BY_KEY = new Map<string, CustomerRouteDef>(
  Object.values(CUSTOMER_ROUTES).map((r) => [`${r.method} ${r.path}`, r]),
);

/** The customer route of a method and canon path template (`/v1/customer/locations/{venueId}`). */
export function findCustomerRoute(method: string, path: string): CustomerRouteDef | undefined {
  return CUSTOMER_BY_KEY.get(`${method.toUpperCase()} ${path}`);
}

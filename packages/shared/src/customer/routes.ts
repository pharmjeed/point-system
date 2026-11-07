/**
 * The customer routes delivered with V2-011's contracts (05 §1, DEC-482). `auth`: `public` (no token) or
 * `customer` (`Authorization: Bearer <access_token>`). `idempotency: 'required'` = every write command takes an
 * `Idempotency-Key` (07 rules, 05 preamble); the sign-in calls are rate limited instead, as `/v1/auth/login`.
 */
import type { z } from 'zod';
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
import { CustomerHomeSchema } from './home.js';
import { CustomerLocationDetailSchema, CustomerLocationListSchema } from './locations.js';
import {
  CustomerVehicleCreateBodySchema,
  CustomerVehicleListSchema,
  CustomerVehicleSchema,
} from './vehicles.js';

export interface CustomerRouteDef {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Path template, e.g. `/v1/customer/vehicles/{vehicleId}`. */
  path: string;
  auth: 'public' | 'customer';
  idempotency: 'required' | 'none';
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
    body: CustomerOtpRequestBodySchema,
    data: CustomerOtpChallengeSchema,
  },
  otpVerify: {
    method: 'POST',
    path: '/v1/customer/auth/verify',
    auth: 'public',
    idempotency: 'none',
    body: CustomerOtpVerifyBodySchema,
    data: CustomerAuthResultSchema,
  },
  refresh: {
    method: 'POST',
    path: '/v1/customer/auth/refresh',
    auth: 'public',
    idempotency: 'none',
    body: CustomerRefreshBodySchema,
    data: CustomerTokensSchema,
  },
  logout: {
    method: 'POST',
    path: '/v1/customer/auth/logout',
    auth: 'customer',
    idempotency: 'none',
    body: CustomerLogoutBodySchema,
    data: CustomerLogoutResultSchema,
  },
  me: {
    method: 'GET',
    path: '/v1/customer/me',
    auth: 'customer',
    idempotency: 'none',
    data: CustomerMeSchema,
  },
  mePatch: {
    method: 'PATCH',
    path: '/v1/customer/me',
    auth: 'customer',
    idempotency: 'required',
    body: CustomerMePatchBodySchema,
    data: CustomerMeSchema,
  },
  consents: {
    method: 'POST',
    path: '/v1/customer/consents',
    auth: 'customer',
    idempotency: 'required',
    body: CustomerConsentsBodySchema,
    data: CustomerMeSchema,
  },
  vehicles: {
    method: 'GET',
    path: '/v1/customer/vehicles',
    auth: 'customer',
    idempotency: 'none',
    data: CustomerVehicleListSchema,
  },
  vehicleCreate: {
    method: 'POST',
    path: '/v1/customer/vehicles',
    auth: 'customer',
    idempotency: 'required',
    body: CustomerVehicleCreateBodySchema,
    data: CustomerVehicleSchema,
  },
  locations: {
    method: 'GET',
    path: '/v1/customer/locations',
    auth: 'customer',
    idempotency: 'none',
    data: CustomerLocationListSchema,
  },
  location: {
    method: 'GET',
    path: '/v1/customer/locations/{venueId}',
    auth: 'customer',
    idempotency: 'none',
    data: CustomerLocationDetailSchema,
  },
  home: {
    method: 'GET',
    path: '/v1/customer/home',
    auth: 'customer',
    idempotency: 'none',
    data: CustomerHomeSchema,
  },
} as const satisfies Record<string, CustomerRouteDef>;

export type CustomerRouteKey = keyof typeof CUSTOMER_ROUTES;

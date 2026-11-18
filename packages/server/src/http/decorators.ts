import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Permission, PlatformPermission } from '@point/shared';

export const PUBLIC_KEY = 'point:public';
export const PERMISSION_KEY = 'point:permission';
export const PLATFORM_PERMISSION_KEY = 'point:platform_permission';
export const COMMAND_KEY = 'point:command';
export const AUTH_SELF_KEY = 'point:auth_self';
export const CUSTOMER_KEY = 'point:customer';

/** Route without a session (login, MFA verify, webhooks, health). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** Canon §10 permission required by the route (checked by PermissionGuard; boot fails if a route has none). */
export const RequirePermission = (permission: Permission) => SetMetadata(PERMISSION_KEY, permission);

/**
 * V2 platform permission (docs/v2/02 §2.1) required by a `/v1/platform/*` route (DEC-462). The guard then reads the
 * platform session cookie only — never the staff one — and checks the platform role matrix. A route carries either
 * this or @RequirePermission, never both (the boot audit refuses it).
 */
export const RequirePlatformPermission = (permission: PlatformPermission) =>
  SetMetadata(PLATFORM_PERMISSION_KEY, permission);

/**
 * V2 customer route (`/v1/customer/*`, V2-010, DEC-497): the guard reads the `Authorization: Bearer` access token
 * of a customer account only — never a staff or platform cookie — and no permission matrix applies (the account
 * reaches its own data only). A route carries this or a staff/platform permission, never both (boot audit).
 */
export const RequireCustomer = () => SetMetadata(CUSTOMER_KEY, true);

export interface CommandMeta {
  /** ✓ in canon §9: Idempotency-Key is mandatory */
  idempotent: boolean;
  /** operation stored with the key, e.g. 'POST /v1/task-offers/{offerId}/accept' */
  operation: string;
  /**
   * The route accepts an Idempotency-Key and ignores it (never stored, never replayed): a descriptive write that
   * keeps no audit row and whose answer must stay fresh (POST /v1/me/heartbeat: canon §9 «—», server_time).
   */
  ignoreKey?: boolean;
}

/**
 * Marks a state-changing route: the handler runs inside one transaction opened by the CommandInterceptor
 * (L0 idempotency claim first when a key is present) and receives it through @CurrentTx().
 */
export const Command = (operation: string, opts: { idempotent?: boolean; ignoreKey?: boolean } = {}) => {
  const idempotent = opts.idempotent ?? true;
  if (opts.ignoreKey && idempotent)
    throw new Error(`${operation}: a ✓ command cannot ignore its Idempotency-Key`);
  return SetMetadata(COMMAND_KEY, {
    idempotent,
    operation,
    ...(opts.ignoreKey ? { ignoreKey: true } : {}),
  } satisfies CommandMeta);
};

export const CurrentTx = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const tx = ctx.switchToHttp().getRequest().tx;
  if (!tx) throw new Error('@CurrentTx() used on a route without @Command()');
  return tx;
});

export const CurrentActor = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().actor ?? null,
);

/** The platform account of a @RequirePlatformPermission route (PlatformActorContext), or null. */
export const CurrentPlatformActor = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().platformActor ?? null,
);

/** The customer account of a @RequireCustomer route (CustomerActorContext), or null. */
export const CurrentCustomer = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().customerActor ?? null,
);

export const RequestId = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().requestId as string,
);

/** Handlers return `created(data)` for 201 responses. */
export class WithStatus<T> {
  constructor(
    readonly status: number,
    readonly data: T,
    /** kept with the Idempotency-Key and replayed instead of `data` (CommandSuccess.stored, DEC-485) */
    readonly stored?: unknown,
  ) {}
}
export const created = <T>(data: T) => new WithStatus(201, data);
/**
 * A response with a one-time secret (DEC-485): `data` goes to the caller once; `stored` (the same response without
 * the secret) is what the idempotency key keeps and a replay returns.
 */
export const oneTimeResponse = <T>(data: T, stored: unknown, status = 200) =>
  new WithStatus(status, data, stored);
export const noContent = () => new WithStatus(204, null);

/** A fully built response body (already enveloped) that the envelope interceptor passes through. */
export class RawBody {
  constructor(readonly body: unknown) {}
}

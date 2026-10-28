import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Permission } from '@point/shared';

export const PUBLIC_KEY = 'point:public';
export const PERMISSION_KEY = 'point:permission';
export const COMMAND_KEY = 'point:command';
export const AUTH_SELF_KEY = 'point:auth_self';

/** Route without a session (login, MFA verify, webhooks, health). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** Canon §10 permission required by the route (checked by PermissionGuard; boot fails if a route has none). */
export const RequirePermission = (permission: Permission) => SetMetadata(PERMISSION_KEY, permission);

export interface CommandMeta {
  /** ✓ in canon §9: Idempotency-Key is mandatory */
  idempotent: boolean;
  /** operation stored with the key, e.g. 'POST /v1/task-offers/{offerId}/accept' */
  operation: string;
}

/**
 * Marks a state-changing route: the handler runs inside one transaction opened by the CommandInterceptor
 * (L0 idempotency claim first when a key is present) and receives it through @CurrentTx().
 */
export const Command = (operation: string, opts: { idempotent?: boolean } = {}) =>
  SetMetadata(COMMAND_KEY, { idempotent: opts.idempotent ?? true, operation } satisfies CommandMeta);

export const CurrentTx = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const tx = ctx.switchToHttp().getRequest().tx;
  if (!tx) throw new Error('@CurrentTx() used on a route without @Command()');
  return tx;
});

export const CurrentActor = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().actor ?? null,
);

export const RequestId = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().requestId as string,
);

/** Handlers return `created(data)` for 201 responses. */
export class WithStatus<T> {
  constructor(
    readonly status: number,
    readonly data: T,
  ) {}
}
export const created = <T>(data: T) => new WithStatus(201, data);
export const noContent = () => new WithStatus(204, null);

/** A fully built response body (already enveloped) that the envelope interceptor passes through. */
export class RawBody {
  constructor(readonly body: unknown) {}
}

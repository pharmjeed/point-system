import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants.js';
import { RequestMethod } from '@nestjs/common';
import { isPlatformPath } from '@point/shared';
import { isCustomerPath } from '@point/shared/customer';
import {
  COMMAND_KEY,
  CUSTOMER_KEY,
  PERMISSION_KEY,
  PLATFORM_PERMISSION_KEY,
  PUBLIC_KEY,
  type CommandMeta,
} from '../../http/decorators.js';

export interface DeclaredRoute {
  method: string;
  path: string;
  permission: string | null;
  /** V2: the platform permission of a `/v1/platform/*` route (DEC-462) */
  platformPermission: string | null;
  /** V2-010: a `/v1/customer/*` route authorized by the customer Bearer token (DEC-497) */
  customer: boolean;
  public: boolean;
  command: CommandMeta | null;
  handler: string;
}

/** Lists every HTTP route with its declared permission (used at boot and by the permission-matrix tests). */
export function collectRoutes(
  discovery: DiscoveryService,
  scanner: MetadataScanner,
  reflector: Reflector,
): DeclaredRoute[] {
  const out: DeclaredRoute[] = [];
  for (const wrapper of discovery.getControllers()) {
    const instance = wrapper.instance as object | undefined;
    if (!instance) continue;
    const cls = instance.constructor;
    const base = String(Reflect.getMetadata(PATH_METADATA, cls) ?? '');
    const proto = Object.getPrototypeOf(instance);
    for (const name of scanner.getAllMethodNames(proto)) {
      const fn = proto[name];
      const sub = Reflect.getMetadata(PATH_METADATA, fn);
      if (sub === undefined) continue;
      const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, fn) as number] ?? 'GET';
      const path =
        '/' +
        [base, String(sub)]
          .map((p) => p.replace(/^\/|\/$/g, ''))
          .filter(Boolean)
          .join('/');
      out.push({
        method,
        path: path.replace(/:([A-Za-z]+)/g, '{$1}'),
        permission: reflector.getAllAndOverride<string>(PERMISSION_KEY, [fn, cls]) ?? null,
        platformPermission: reflector.getAllAndOverride<string>(PLATFORM_PERMISSION_KEY, [fn, cls]) ?? null,
        customer: !!reflector.getAllAndOverride<boolean>(CUSTOMER_KEY, [fn, cls]),
        public: !!reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [fn, cls]),
        command: reflector.get<CommandMeta>(COMMAND_KEY, fn) ?? null,
        handler: `${cls.name}.${name}`,
      });
    }
  }
  return out;
}

/**
 * Problems that stop the boot: a route with no permission (PNT-013 AC3), and the V2 separation (DEC-462) — a
 * `/v1/platform/*` route carries a platform permission (or @Public) and never a staff one; a platform permission is
 * only allowed on a `/v1/platform/*` route. V2-010 (DEC-497): a `/v1/customer/*` route is @RequireCustomer (or @Public)
 * and carries no staff or platform permission; @RequireCustomer is only allowed on a `/v1/customer/*` route.
 */
export function routeProblems(routes: readonly DeclaredRoute[]): string[] {
  const out: string[] = [];
  for (const r of routes) {
    const where = `${r.method} ${r.path} (${r.handler})`;
    if (!r.public && !r.permission && !r.platformPermission && !r.customer)
      out.push(`no @RequirePermission/@Public: ${where}`);
    if (r.permission && r.platformPermission) out.push(`staff and platform permission together: ${where}`);
    if (isPlatformPath(r.path) && r.permission) out.push(`staff permission on a platform route: ${where}`);
    if (!isPlatformPath(r.path) && r.platformPermission)
      out.push(`platform permission off /v1/platform: ${where}`);
    if (isCustomerPath(r.path) && (r.permission || r.platformPermission))
      out.push(`staff or platform permission on a customer route: ${where}`);
    if (!isCustomerPath(r.path) && r.customer) out.push(`customer authorization off /v1/customer: ${where}`);
    if (r.customer && r.public) out.push(`customer route marked @Public: ${where}`);
  }
  return out;
}

/** PNT-013 AC3: the application does not boot if a route has no declared permission (or @Public). */
@Injectable()
export class RouteAudit implements OnApplicationBootstrap {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onApplicationBootstrap() {
    const bad = routeProblems(collectRoutes(this.discovery, this.scanner, this.reflector));
    if (bad.length) throw new Error(`route declarations refused:\n${bad.map((b) => `  ${b}`).join('\n')}`);
  }
}

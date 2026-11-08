import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants.js';
import { RequestMethod } from '@nestjs/common';
import { COMMAND_KEY, PERMISSION_KEY, PUBLIC_KEY, type CommandMeta } from '../../http/decorators.js';

export interface DeclaredRoute {
  method: string;
  path: string;
  permission: string | null;
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
        public: !!reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [fn, cls]),
        command: reflector.get<CommandMeta>(COMMAND_KEY, fn) ?? null,
        handler: `${cls.name}.${name}`,
      });
    }
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
    const bad = collectRoutes(this.discovery, this.scanner, this.reflector).filter(
      (r) => !r.public && !r.permission,
    );
    if (bad.length) {
      throw new Error(
        `routes without @RequirePermission/@Public:\n${bad.map((r) => `  ${r.method} ${r.path} (${r.handler})`).join('\n')}`,
      );
    }
  }
}

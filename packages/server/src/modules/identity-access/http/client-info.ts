import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { ClientInfo } from '../application/auth-service.js';

export const Client = createParamDecorator((_: unknown, ctx: ExecutionContext): ClientInfo => {
  const req = ctx.switchToHttp().getRequest<Request & { requestId: string }>();
  return { ip: req.ip ?? null, userAgent: req.header('user-agent') ?? null, requestId: req.requestId };
});

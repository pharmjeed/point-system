import { Body, Controller, Get, Inject, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { PlatformActorContext } from '../../../core/actor-context/platform-actor.js';
import type { Env } from '../../../core/config/env.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import {
  Command,
  CurrentPlatformActor,
  CurrentTx,
  Public,
  RequirePlatformPermission,
  noContent,
} from '../../../http/decorators.js';
import { DATABASE, ENV } from '../../../http/tokens.js';
import { zodBody } from '../../../http/zod-pipe.js';
import type { ClientInfo } from '../../identity-access/application/auth-service.js';
import { Client } from '../../identity-access/http/client-info.js';
import { PlatformAuthService } from '../application/platform-auth-service.js';
import { clearPlatformSessionCookie, setPlatformSessionCookie } from '../application/platform-sessions.js';
import { buildPlatformMe } from '../application/platform-views.js';
import {
  PlatformLoginBody,
  PlatformMfaConfirmBody,
  PlatformMfaVerifyBody,
  PlatformSecretChangeBody,
} from './schemas.js';

/** V2-002 — platform sign-in, MFA, password change, logout and `GET /v1/platform/me` (PLATFORM_ROUTES). */
@Controller('v1/platform')
export class PlatformAuthController {
  constructor(
    private readonly auth: PlatformAuthService,
    @Inject(ENV) private readonly env: Env,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  @Post('auth/login')
  @Public()
  @Command('POST /v1/platform/auth/login', { idempotent: false })
  async login(
    @CurrentTx() tx: Tx,
    @Body(zodBody(PlatformLoginBody)) body: PlatformLoginBody,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { result, session } = await this.auth.login(tx, body, client);
    if (session) setPlatformSessionCookie(res, this.env, session);
    return result;
  }

  @Post('auth/mfa/verify')
  @Public()
  @Command('POST /v1/platform/auth/mfa/verify', { idempotent: false })
  async verify(
    @CurrentTx() tx: Tx,
    @Body(zodBody(PlatformMfaVerifyBody)) body: PlatformMfaVerifyBody,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { me, session } = await this.auth.verifyMfa(tx, body, client);
    setPlatformSessionCookie(res, this.env, session);
    return me;
  }

  @Post('auth/mfa/setup')
  @RequirePlatformPermission('platform.self')
  @Command('POST /v1/platform/auth/mfa/setup', { idempotent: false })
  setup(
    @CurrentTx() tx: Tx,
    @CurrentPlatformActor() actor: PlatformActorContext,
    @Client() client: ClientInfo,
  ) {
    return this.auth.mfaSetup(tx, actor, client);
  }

  @Post('auth/mfa/confirm')
  @RequirePlatformPermission('platform.self')
  @Command('POST /v1/platform/auth/mfa/confirm', { idempotent: false })
  confirm(
    @CurrentTx() tx: Tx,
    @CurrentPlatformActor() actor: PlatformActorContext,
    @Body(zodBody(PlatformMfaConfirmBody)) body: PlatformMfaConfirmBody,
    @Client() client: ClientInfo,
  ) {
    return this.auth.mfaConfirm(tx, actor, body, client);
  }

  @Post('auth/secret/change')
  @RequirePlatformPermission('platform.self')
  @Command('POST /v1/platform/auth/secret/change', { idempotent: false })
  async changeSecret(
    @CurrentTx() tx: Tx,
    @CurrentPlatformActor() actor: PlatformActorContext,
    @Body(zodBody(PlatformSecretChangeBody)) body: PlatformSecretChangeBody,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { me, session } = await this.auth.changeSecret(tx, actor, body, client);
    setPlatformSessionCookie(res, this.env, session);
    return me;
  }

  @Post('auth/logout')
  @RequirePlatformPermission('platform.self')
  @Command('POST /v1/platform/auth/logout', { idempotent: false })
  async logout(
    @CurrentTx() tx: Tx,
    @CurrentPlatformActor() actor: PlatformActorContext,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logout(tx, actor, client);
    clearPlatformSessionCookie(res, this.env);
    return noContent();
  }

  @Get('me')
  @RequirePlatformPermission('platform.self')
  me(@CurrentPlatformActor() actor: PlatformActorContext) {
    return buildPlatformMe(this.db, this.env, actor.sessionId, actor.userId);
  }
}

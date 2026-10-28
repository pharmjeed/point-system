import { Body, Controller, Get, Inject, Param, Post, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import type { Env } from '../../../core/config/env.js';
import type { Tx } from '../../../core/db/tx.js';
import type { Database } from '../../../core/db/database.js';
import {
  Command,
  CurrentActor,
  CurrentTx,
  Public,
  RequestId,
  RequirePermission,
  created,
  noContent,
} from '../../../http/decorators.js';
import { DATABASE, ENV } from '../../../http/tokens.js';
import { zodBody } from '../../../http/zod-pipe.js';
import { AuthService, type ClientInfo } from '../application/auth-service.js';
import { MeService } from '../application/me-service.js';
import { clearSessionCookie, setSessionCookie } from '../application/sessions.js';
import { Client } from './client-info.js';
import {
  AudioTestBody,
  DeviceRegisterBody,
  DeviceUpdateBody,
  HeartbeatBody,
  LoginBody,
  MfaConfirmBody,
  MfaVerifyBody,
  SecretChangeBody,
} from './schemas.js';

/** Canon §9.1 — sign-in, session and device (PNT-011, PNT-012, PNT-014). */
@Controller('v1')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly me: MeService,
    @Inject(ENV) private readonly env: Env,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  @Post('auth/login')
  @Public()
  @Command('POST /v1/auth/login', { idempotent: false })
  async login(
    @CurrentTx() tx: Tx,
    @Body(zodBody(LoginBody)) body: LoginBody,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { result, session } = await this.auth.login(tx, body, client);
    if (session) setSessionCookie(res, this.env, session);
    return result;
  }

  @Post('auth/mfa/verify')
  @Public()
  @Command('POST /v1/auth/mfa/verify', { idempotent: false })
  async verify(
    @CurrentTx() tx: Tx,
    @Body(zodBody(MfaVerifyBody)) body: MfaVerifyBody,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { me, session } = await this.auth.verifyMfa(tx, body, client);
    setSessionCookie(res, this.env, session);
    return me;
  }

  @Post('auth/mfa/setup')
  @RequirePermission('auth.self')
  @Command('POST /v1/auth/mfa/setup', { idempotent: false })
  setup(@CurrentTx() tx: Tx, @CurrentActor() actor: ActorContext, @Client() client: ClientInfo) {
    return this.auth.mfaSetup(tx, actor, client);
  }

  @Post('auth/mfa/confirm')
  @RequirePermission('auth.self')
  @Command('POST /v1/auth/mfa/confirm', { idempotent: false })
  confirm(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @Body(zodBody(MfaConfirmBody)) body: MfaConfirmBody,
    @Client() client: ClientInfo,
  ) {
    return this.auth.mfaConfirm(tx, actor, body, client);
  }

  @Post('auth/secret/change')
  @RequirePermission('auth.self')
  @Command('POST /v1/auth/secret/change', { idempotent: false })
  async changeSecret(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @Body(zodBody(SecretChangeBody)) body: SecretChangeBody,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { me, session } = await this.auth.changeSecret(tx, actor, body, client);
    setSessionCookie(res, this.env, session);
    return me;
  }

  @Post('auth/logout')
  @RequirePermission('auth.self')
  @Command('POST /v1/auth/logout', { idempotent: false })
  async logout(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logout(tx, actor, client);
    clearSessionCookie(res, this.env);
    return noContent();
  }

  @Get('me')
  @RequirePermission('auth.self')
  getMe(@CurrentActor() actor: ActorContext) {
    return this.me.me(this.db, actor);
  }

  @Post('me/devices')
  @RequirePermission('auth.self')
  @Command('POST /v1/me/devices', { idempotent: false })
  async registerDevice(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @Body(zodBody(DeviceRegisterBody)) body: DeviceRegisterBody,
    @Client() client: ClientInfo,
    @RequestId() requestId: string,
  ) {
    return created(await this.me.registerDevice(tx, actor, body, client.userAgent ?? undefined, requestId));
  }

  @Put('me/devices/:deviceId')
  @RequirePermission('auth.self')
  @Command('PUT /v1/me/devices/{deviceId}', { idempotent: false })
  updateDevice(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @Param('deviceId') deviceId: string,
    @Body(zodBody(DeviceUpdateBody)) body: DeviceUpdateBody,
    @RequestId() requestId: string,
  ) {
    return this.me.updateDevice(tx, actor, deviceId, body, requestId);
  }

  @Post('me/audio-test')
  @RequirePermission('auth.self')
  @Command('POST /v1/me/audio-test', { idempotent: false })
  audioTest(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @Body(zodBody(AudioTestBody)) body: AudioTestBody,
    @RequestId() requestId: string,
  ) {
    return this.me.audioTest(tx, actor, body, requestId);
  }

  @Post('me/heartbeat')
  @RequirePermission('auth.self')
  @Command('POST /v1/me/heartbeat', { idempotent: false })
  heartbeat(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @Body(zodBody(HeartbeatBody)) body: HeartbeatBody,
  ) {
    return this.me.heartbeat(tx, actor, body);
  }
}

type LoginBody = import('zod').infer<typeof LoginBody>;
type MfaVerifyBody = import('zod').infer<typeof MfaVerifyBody>;
type MfaConfirmBody = import('zod').infer<typeof MfaConfirmBody>;
type SecretChangeBody = import('zod').infer<typeof SecretChangeBody>;
type DeviceRegisterBody = import('zod').infer<typeof DeviceRegisterBody>;
type DeviceUpdateBody = import('zod').infer<typeof DeviceUpdateBody>;
type AudioTestBody = import('zod').infer<typeof AudioTestBody>;
type HeartbeatBody = import('zod').infer<typeof HeartbeatBody>;

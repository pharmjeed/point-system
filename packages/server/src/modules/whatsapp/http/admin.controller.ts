import {
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  Post,
  Put,
  Req,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { Command, CurrentActor, CurrentTx, RequestId, RequirePermission } from '../../../http/decorators.js';
import { DATABASE } from '../../../http/tokens.js';
import { zodBody } from '../../../http/zod-pipe.js';
import { WhatsappChannelAdmin, WhatsappChannelPutBody } from '../application/channel-admin.js';
import { WhatsappTemplates, type RemoteSync } from '../application/templates.js';

type SyncRequest = {
  actor?: ActorContext;
  header(name: string): string | undefined;
  waTemplateSync?: RemoteSync;
};

/**
 * The Graph calls of `POST /v1/admin/whatsapp/templates/sync` happen here, after authentication and the
 * permission check but before the command transaction opens (no network inside a transaction, 05 §7.4).
 * A key that already completed is replayed by the command runner without calling Meta again.
 */
@Injectable()
export class TemplateSyncPrefetchGuard implements CanActivate {
  constructor(
    private readonly templates: WhatsappTemplates,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<SyncRequest>();
    const actor = req.actor;
    if (!actor) return true; // the AuthGuard already refused anonymous calls
    const key = req.header('Idempotency-Key');
    if (key) {
      const done = await this.db.query(
        `SELECT 1 FROM idempotency_keys WHERE user_id = $1 AND key = $2 AND status = 'completed' AND expires_at > $3`,
        [actor.userId, key, this.db.clock.now()],
      );
      if (done.rowCount) return true;
    }
    req.waTemplateSync = await this.templates.fetchRemote(this.db, actor.orgId);
    return true;
  }
}

/** Canon §9.7 — the single WhatsApp channel and its templates (PNT-038, PNT-039). Owner/admin only. */
@Controller('v1/admin/whatsapp')
export class WhatsappAdminController {
  constructor(
    private readonly channel: WhatsappChannelAdmin,
    private readonly templates: WhatsappTemplates,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  @Get('channel')
  @RequirePermission('wa.channel_read')
  getChannel(@CurrentActor() actor: ActorContext) {
    return this.channel.get(this.db, actor);
  }

  @Put('channel')
  @RequirePermission('wa.channel_manage')
  @Command('PUT /v1/admin/whatsapp/channel')
  putChannel(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @Body(zodBody(WhatsappChannelPutBody)) body: WhatsappChannelPutBody,
    @RequestId() rid: string,
  ) {
    return this.channel.put(tx, actor, body, rid);
  }

  @Get('templates')
  @RequirePermission('wa.channel_read')
  listTemplates(@CurrentActor() actor: ActorContext) {
    return this.templates.list(this.db, actor.orgId);
  }

  @Post('templates/sync')
  @RequirePermission('wa.templates_manage')
  @UseGuards(TemplateSyncPrefetchGuard)
  @Command('POST /v1/admin/whatsapp/templates/sync')
  syncTemplates(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @Req() req: SyncRequest,
    @RequestId() rid: string,
  ) {
    if (!req.waTemplateSync) throw new Error('template sync prefetch did not run');
    return this.templates.applySync(tx, actor, req.waTemplateSync, rid);
  }
}

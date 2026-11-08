import { Body, Controller, Get, Put } from '@nestjs/common';
import { orgSettingsEditableSchema, type OrgSettingsEditable } from '@point/shared';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import type { Tx } from '../../../core/db/tx.js';
import { Command, CurrentActor, CurrentTx, RequirePermission } from '../../../http/decorators.js';
import { OrgSettingsService } from '../application/org-settings.service.js';
import type { CommandMeta } from '../application/support.js';
import { CommandContext, input } from './support.js';

/** Canon §9.7: organization settings — `org.settings_manage` is the owner's only (canon §10, DEC-39). */
@Controller('v1/admin/org-settings')
export class OrgSettingsController {
  constructor(private readonly settings: OrgSettingsService) {}

  @Get()
  @RequirePermission('org.settings_manage')
  get(@CurrentActor() actor: ActorContext) {
    return this.settings.get(actor);
  }

  @Put()
  @RequirePermission('org.settings_manage')
  @Command('PUT /v1/admin/org-settings')
  put(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @CommandContext() meta: CommandMeta,
    @Body(input(orgSettingsEditableSchema)) body: OrgSettingsEditable,
  ) {
    return this.settings.put(tx, actor, meta, body);
  }
}

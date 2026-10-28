import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import {
  Command,
  CurrentActor,
  CurrentTx,
  RequestId,
  RequirePermission,
  created,
} from '../../../http/decorators.js';
import { zodBody } from '../../../http/zod-pipe.js';
import { IncidentsService } from '../application/incidents.service.js';
import { CreateIncidentBody, ListIncidentsQuery, UpdateIncidentBody } from './schemas.js';

const incidentIdParam = new ParseUUIDPipe({
  exceptionFactory: () => new AppError('RESOURCE_NOT_FOUND', { resource: 'incident' }),
});

const CREATE_INCIDENT = 'POST /v1/incidents';
const PATCH_INCIDENT = 'PATCH /v1/incidents/{incidentId}';

/** Canon §9.7 — internal incidents (PNT-083, S-12). */
@Controller('v1/incidents')
export class IncidentsController {
  constructor(private readonly incidents: IncidentsService) {}

  @Get()
  @RequirePermission('incident.read')
  list(@CurrentActor() actor: ActorContext, @Query(zodBody(ListIncidentsQuery)) q: ListIncidentsQuery) {
    return this.incidents.list(actor, q);
  }

  @Post()
  @RequirePermission('incident.create')
  @Command(CREATE_INCIDENT)
  async create(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() requestId: string,
    @Body(zodBody(CreateIncidentBody)) body: CreateIncidentBody,
  ) {
    return created(await this.incidents.create(tx, actor, { operation: CREATE_INCIDENT, requestId }, body));
  }

  @Get(':incidentId')
  @RequirePermission('incident.read')
  get(@CurrentActor() actor: ActorContext, @Param('incidentId', incidentIdParam) incidentId: string) {
    return this.incidents.get(actor, incidentId);
  }

  @Patch(':incidentId')
  @RequirePermission('incident.manage')
  @Command(PATCH_INCIDENT)
  update(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() requestId: string,
    @Param('incidentId', incidentIdParam) incidentId: string,
    @Body(zodBody(UpdateIncidentBody)) body: UpdateIncidentBody,
  ) {
    return this.incidents.update(tx, actor, { operation: PATCH_INCIDENT, requestId }, incidentId, body);
  }
}

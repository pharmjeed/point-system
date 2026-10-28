import { Body, Controller, Get, Header, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import type { Tx } from '../../../core/db/tx.js';
import {
  Command,
  CurrentActor,
  CurrentTx,
  RequestId,
  RequirePermission,
  created,
} from '../../../http/decorators.js';
import { zodBody } from '../../../http/zod-pipe.js';
import {
  COMPLETE_UPLOAD_OPERATION,
  CompleteMediaUploadBody,
  CompleteMediaUploadUseCase,
  type MediaCompletionPlan,
} from '../application/complete-media-upload.js';
import { MediaReadUrlQuery } from '../application/media-read-url.js';
import {
  REQUEST_UPLOAD_OPERATION,
  RequestMediaUploadUseCase,
  type MediaCommandContext,
  type MediaUploadRequest,
} from '../application/request-media-upload.js';
import { MediaCompletionPlanParam, MediaCompletionPreparer } from './media-completion.preparer.js';
import { MediaUploadRequestPipe } from './media-upload-request.pipe.js';

/** Private inspection photos (07 §2.2, canon §9.2; PNT-027). */
@Controller('v1')
export class MediaController {
  constructor(
    private readonly requestUpload: RequestMediaUploadUseCase,
    private readonly completion: CompleteMediaUploadUseCase,
    private readonly readUrl: MediaReadUrlQuery,
  ) {}

  @Post('tickets/:ticketId/media')
  @RequirePermission('ticket.intake')
  @Command(REQUEST_UPLOAD_OPERATION)
  async request(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() requestId: string,
    @Req() req: Request,
    @Param('ticketId') ticketId: string,
    @Body(MediaUploadRequestPipe) body: MediaUploadRequest,
  ) {
    return created(
      await this.requestUpload.execute(tx, actor, ticketId, body, commandContext(req, requestId)),
    );
  }

  @Post('media/:mediaId/complete')
  @RequirePermission('ticket.intake')
  @Command(COMPLETE_UPLOAD_OPERATION)
  @UseGuards(MediaCompletionPreparer) // the storage phase, before the command transaction opens
  async complete(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() requestId: string,
    @Req() req: Request,
    @Param('mediaId') mediaId: string,
    @Body(zodBody(CompleteMediaUploadBody)) _body: CompleteMediaUploadBody,
    @MediaCompletionPlanParam() plan: MediaCompletionPlan | undefined,
  ) {
    return this.completion.finalize(tx, actor, mediaId, plan, commandContext(req, requestId));
  }

  @Get('media/:mediaId/url')
  @RequirePermission('ticket.read_photos')
  @Header('Cache-Control', 'private, no-store')
  async url(
    @CurrentActor() actor: ActorContext,
    @RequestId() requestId: string,
    @Param('mediaId') mediaId: string,
  ) {
    return this.readUrl.execute(actor, mediaId, requestId);
  }
}

function commandContext(req: Request, requestId: string): MediaCommandContext {
  return { requestId, ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null };
}

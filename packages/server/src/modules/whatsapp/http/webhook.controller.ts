import { Controller, Get, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public, RawBody } from '../../../http/decorators.js';
import { WhatsappWebhookIntake } from '../application/webhook-intake.js';

/**
 * Canon §9.8 — `/webhooks/whatsapp` (PNT-040). Public (Meta has no session) and CSRF-exempt by path; the
 * GET handshake compares the verify token in constant time, the POST verifies X-Hub-Signature-256 over
 * the raw body before anything is parsed, stores it and answers 200 `{"ok":true}` (duplicates included).
 */
@Controller('webhooks/whatsapp')
export class WhatsappWebhookController {
  constructor(private readonly intake: WhatsappWebhookIntake) {}

  @Get()
  @Public()
  async verify(@Query() query: Record<string, unknown>, @Res({ passthrough: true }) res: Response) {
    const challenge = await this.intake.verifyChallenge(query);
    res.type('text/plain');
    return new RawBody(challenge);
  }

  @Post()
  @Public()
  @HttpCode(200)
  async receive(@Req() req: Request & { rawBody?: Buffer }) {
    await this.intake.receive(req.rawBody, req.header('x-hub-signature-256'));
    return new RawBody({ ok: true });
  }
}

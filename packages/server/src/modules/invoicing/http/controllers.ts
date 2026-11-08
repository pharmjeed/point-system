import { Controller, Get, Header, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { PlatformInvoicesQuerySchema, type PlatformInvoicesQuery } from '@point/shared';
import type { Request } from 'express';
import type { CustomerActorContext } from '../../../core/actor-context/customer-actor.js';
import type { Clock } from '../../../core/clock/clock.js';
import type { Database } from '../../../core/db/database.js';
import {
  CurrentCustomer,
  Public,
  RawBody,
  RequireCustomer,
  RequirePlatformPermission,
} from '../../../http/decorators.js';
import { CLOCK, DATABASE } from '../../../http/tokens.js';
import { zodBody } from '../../../http/zod-pipe.js';
import { customerInvoice, customerInvoices, PlatformInvoicesConsole } from '../application/reads.js';
import { receiveProviderCallback } from '../application/submission.js';
import { InvoicingRuntime } from '../runtime.js';

/** P-10 «الفواتير» (V2-040, PLATFORM_ROUTES; DEC-548): every invoice and credit note, the provider's status, the PDF. */
@Controller('v1/platform/invoices')
export class PlatformInvoicesController {
  constructor(private readonly console: PlatformInvoicesConsole) {}

  @Get()
  @RequirePlatformPermission('platform.invoice_read')
  list(@Query(zodBody(PlatformInvoicesQuerySchema)) q: PlatformInvoicesQuery) {
    return this.console.list(q);
  }

  @Get(':invoiceId')
  @RequirePlatformPermission('platform.invoice_read')
  @Header('Cache-Control', 'private, no-store')
  detail(@Param('invoiceId') invoiceId: string) {
    return this.console.detail(invoiceId);
  }
}

/** C-17 «الفواتير» (V2-040, CUSTOMER_ROUTES; DEC-548): the account's simplified invoices and credit notes. */
@Controller('v1/customer')
export class CustomerInvoicesController {
  constructor(
    private readonly rt: InvoicingRuntime,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get('invoices')
  @RequireCustomer()
  list(@CurrentCustomer() actor: CustomerActorContext) {
    return customerInvoices(this.db, actor.accountId);
  }

  @Get('invoices/:invoiceId')
  @RequireCustomer()
  @Header('Cache-Control', 'private, no-store')
  detail(@CurrentCustomer() actor: CustomerActorContext, @Param('invoiceId') invoiceId: string) {
    return customerInvoice(this.db, this.rt.storage(), this.rt.env, this.clock, actor.accountId, invoiceId);
  }
}

/**
 * Canon §9.8 V2 row — `POST /webhooks/einvoicing` (V2-040, DEC-543): the provider's asynchronous status of a
 * document. Public (the provider has no session) and CSRF-exempt by path; the raw body is read as bytes
 * (bootstrap.ts) and its `X-Einvoice-Signature` checked before anything is parsed; 200 with no body.
 */
@Controller('webhooks/einvoicing')
export class EinvoiceWebhookController {
  constructor(
    private readonly rt: InvoicingRuntime,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  @Post()
  @Public()
  @HttpCode(200)
  async receive(@Req() req: Request & { rawBody?: Buffer }) {
    await receiveProviderCallback(
      this.db,
      this.rt,
      req.rawBody,
      req.header('X-Einvoice-Signature') ?? undefined,
    );
    return new RawBody('');
  }
}

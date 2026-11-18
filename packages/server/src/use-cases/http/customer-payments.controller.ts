import {
  Body,
  Controller,
  createParamDecorator,
  Delete,
  Get,
  Inject,
  Injectable,
  Module,
  Param,
  Patch,
  Post,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { CUSTOMER_ROUTES } from '@point/shared/customer';
import type { Request } from 'express';
import type { z } from 'zod';
import type { CustomerActorContext } from '../../core/actor-context/customer-actor.js';
import type { Clock } from '../../core/clock/clock.js';
import type { Env } from '../../core/config/env.js';
import type { Database } from '../../core/db/database.js';
import type { Tx } from '../../core/db/tx.js';
import { validateIdempotencyKey } from '../../core/idempotency/command-runner.js';
import { Command, CurrentCustomer, CurrentTx, RequireCustomer, created } from '../../http/decorators.js';
import { CLOCK, DATABASE, ENV } from '../../http/tokens.js';
import { zodBody } from '../../http/zod-pipe.js';
import type { ClientInfo } from '../../modules/identity-access/application/auth-service.js';
import { Client } from '../../modules/identity-access/http/client-info.js';
import { PaymentsOnlineHttpModule, PaymentsRuntime } from '../../modules/payments-online/index.js';
import {
  getCustomerPayment,
  listPaymentMethods,
  PaymentMethodsUseCase,
  VisitPayUseCase,
  type PaymentMethodPlan,
  type VisitPayPlan,
} from '../customer-payments.js';

const R = CUSTOMER_ROUTES;
type Out<S extends z.ZodType> = z.output<S>;

const PAY_PLAN = Symbol('customer.visitPayPlan');
const CARD_PLAN = Symbol('customer.paymentMethodPlan');
type Req = Request & {
  customerActor?: CustomerActorContext;
  requestId?: string;
  [PAY_PLAN]?: VisitPayPlan;
  [CARD_PLAN]?: PaymentMethodPlan;
};

/** The Idempotency-Key of a customer command that has not been answered yet, or null (skip the network phase). */
async function freshKey(db: Database, clock: Clock, req: Req): Promise<string | null> {
  if (!req.customerActor) return null;
  let key: string;
  try {
    key = validateIdempotencyKey(req.header('Idempotency-Key') ?? undefined);
  } catch {
    return null; // the interceptor answers IDEMPOTENCY_KEY_REQUIRED / VALIDATION_FAILED
  }
  const known = await db.query(
    `SELECT 1 FROM customer_idempotency_keys WHERE account_id = $1 AND key = $2 AND expires_at > $3`,
    [req.customerActor.accountId, key, clock.now()],
  );
  return (known.rowCount ?? 0) > 0 ? null : key;
}

/**
 * The gateway phase of `POST /v1/customer/visits/{ticketId}/pay` (DEC-96 pattern, DEC-521): after the session guard,
 * before the command transaction. It never rejects: the plan (the payment, or the error) is answered by the handler
 * inside the command transaction, so a deterministic 4xx is stored with the Idempotency-Key and a 5xx is not.
 */
@Injectable()
export class VisitPayPreparer implements CanActivate {
  constructor(
    private readonly pay: VisitPayUseCase,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Req>();
    delete req[PAY_PLAN];
    const key = await freshKey(this.db, this.clock, req);
    if (!key || !req.customerActor) return true;
    const plan = await this.pay.prepare(
      req.customerActor.accountId,
      String(req.params.ticketId ?? ''),
      req.body,
      key,
      req.requestId ?? null,
    );
    if (plan) req[PAY_PLAN] = plan;
    return true;
  }
}

/** The gateway read of `POST /v1/customer/payment-methods` (the token's brand/last4/expiry), before the command. */
@Injectable()
export class PaymentMethodPreparer implements CanActivate {
  constructor(
    private readonly cards: PaymentMethodsUseCase,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Req>();
    delete req[CARD_PLAN];
    if (!(await freshKey(this.db, this.clock, req))) return true;
    const plan = await this.cards.prepareCreate(req.body);
    if (plan) req[CARD_PLAN] = plan;
    return true;
  }
}

const PayPlan = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<Req>()[PAY_PLAN],
);
const CardPlan = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<Req>()[CARD_PLAN],
);

/**
 * V2-022 / V2-023 (DEC-521 … DEC-525): paying a visit in the app (C-12 → C-10) and the saved cards (C-18), in
 * `CUSTOMER_ROUTES` (Bearer, Idempotency-Key on every write). The visit read/request/code/rating routes of C-12 are
 * another module's; this one only adds the payment.
 */
@Controller('v1/customer')
export class CustomerPaymentsController {
  constructor(
    private readonly pay: VisitPayUseCase,
    private readonly cards: PaymentMethodsUseCase,
    @Inject(ENV) private readonly env: Env,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  @Post('visits/:ticketId/pay')
  @RequireCustomer()
  @Command('POST /v1/customer/visits/{ticketId}/pay')
  @UseGuards(VisitPayPreparer) // the gateway phase, before the command transaction opens
  async payVisit(
    @CurrentTx() tx: Tx,
    @CurrentCustomer() actor: CustomerActorContext,
    @Body(zodBody(R.visitPay.body)) _body: Out<typeof R.visitPay.body>,
    @PayPlan() plan: VisitPayPlan | undefined,
    @Client() client: ClientInfo,
  ) {
    return created(await this.pay.finalize(tx, actor, plan, client));
  }

  @Get('payments/:paymentId')
  @RequireCustomer()
  payment(@CurrentCustomer() actor: CustomerActorContext, @Param('paymentId') paymentId: string) {
    return getCustomerPayment(this.db, this.env, actor.accountId, paymentId);
  }

  @Get('payment-methods')
  @RequireCustomer()
  paymentMethods(@CurrentCustomer() actor: CustomerActorContext) {
    return listPaymentMethods(this.db, actor.accountId);
  }

  @Post('payment-methods')
  @RequireCustomer()
  @Command('POST /v1/customer/payment-methods')
  @UseGuards(PaymentMethodPreparer)
  async addPaymentMethod(
    @CurrentTx() tx: Tx,
    @CurrentCustomer() actor: CustomerActorContext,
    @Body(zodBody(R.paymentMethodCreate.body)) body: Out<typeof R.paymentMethodCreate.body>,
    @CardPlan() plan: PaymentMethodPlan | undefined,
    @Client() client: ClientInfo,
  ) {
    return created(await this.cards.create(tx, actor, body, plan, client));
  }

  @Patch('payment-methods/:paymentMethodId')
  @RequireCustomer()
  @Command('PATCH /v1/customer/payment-methods/{paymentMethodId}')
  setDefault(
    @CurrentTx() tx: Tx,
    @CurrentCustomer() actor: CustomerActorContext,
    @Param('paymentMethodId') id: string,
    @Body(zodBody(R.paymentMethodPatch.body)) _body: Out<typeof R.paymentMethodPatch.body>,
    @Client() client: ClientInfo,
  ) {
    return this.cards.setDefault(tx, actor, id, client);
  }

  @Delete('payment-methods/:paymentMethodId')
  @RequireCustomer()
  @Command('DELETE /v1/customer/payment-methods/{paymentMethodId}')
  removePaymentMethod(
    @CurrentTx() tx: Tx,
    @CurrentCustomer() actor: CustomerActorContext,
    @Param('paymentMethodId') id: string,
    @Client() client: ClientInfo,
  ) {
    return this.cards.remove(tx, actor, id, client);
  }
}

@Module({
  imports: [PaymentsOnlineHttpModule],
  controllers: [CustomerPaymentsController],
  providers: [
    {
      provide: VisitPayUseCase,
      inject: [DATABASE, ENV, PaymentsRuntime],
      useFactory: (db: Database, env: Env, rt: PaymentsRuntime) => new VisitPayUseCase(db, env, rt),
    },
    {
      provide: PaymentMethodsUseCase,
      inject: [ENV, PaymentsRuntime],
      useFactory: (env: Env, rt: PaymentsRuntime) => new PaymentMethodsUseCase(env, rt),
    },
    VisitPayPreparer,
    PaymentMethodPreparer,
  ],
})
export class CustomerPaymentsHttpModule {}

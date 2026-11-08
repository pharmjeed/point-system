import {
  Body,
  Controller,
  createParamDecorator,
  Get,
  Header,
  Inject,
  Injectable,
  Param,
  Post,
  Put,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { CUSTOMER_ROUTES } from '@point/shared/customer';
import type { Request } from 'express';
import type { z } from 'zod';
import type { CustomerActorContext } from '../../../core/actor-context/customer-actor.js';
import type { Clock } from '../../../core/clock/clock.js';
import type { Env } from '../../../core/config/env.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import { validateIdempotencyKey } from '../../../core/idempotency/command-runner.js';
import { Command, CurrentCustomer, CurrentTx, RequireCustomer, created } from '../../../http/decorators.js';
import { CLOCK, DATABASE, ENV } from '../../../http/tokens.js';
import { zodBody } from '../../../http/zod-pipe.js';
import type { ClientInfo } from '../../identity-access/application/auth-service.js';
import { Client } from '../../identity-access/http/client-info.js';
import { SubscriptionCheckout, type CheckoutPlan } from '../application/checkout.js';
import { SubscriptionCommands } from '../application/commands.js';
import { UUID } from '../application/rows.js';
import { customerSubscriptions } from '../application/views.js';

const R = CUSTOMER_ROUTES;
type Out<S extends z.ZodType> = z.output<S>;

const PLAN = Symbol('customer.subscriptionCheckoutPlan');
type Req = Request & { customerActor?: CustomerActorContext; requestId?: string; [PLAN]?: CheckoutPlan };

/** The Idempotency-Key of a customer command not answered yet, or null (the interceptor answers). */
async function freshKey(db: Database, clock: Clock, req: Req): Promise<string | null> {
  if (!req.customerActor) return null;
  let key: string;
  try {
    key = validateIdempotencyKey(req.header('Idempotency-Key') ?? undefined);
  } catch {
    return null;
  }
  const known = await db.query(
    `SELECT 1 FROM customer_idempotency_keys WHERE account_id = $1 AND key = $2 AND expires_at > $3`,
    [req.customerActor.accountId, key, clock.now()],
  );
  return (known.rowCount ?? 0) > 0 ? null : key;
}

/**
 * The gateway phase of `POST /v1/customer/subscriptions` and `…/{subscriptionId}/pay` (DEC-96 pattern, as V2-022's
 * pay): after the session guard, before the command transaction; it never rejects — the handler answers the plan.
 */
@Injectable()
export class SubscriptionCheckoutPreparer implements CanActivate {
  constructor(
    private readonly checkout: SubscriptionCheckout,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Req>();
    delete req[PLAN];
    const key = await freshKey(this.db, this.clock, req);
    if (!key || !req.customerActor) return true;
    const id = req.params.subscriptionId;
    const plan = await this.checkout.prepare(
      typeof id === 'string' ? { kind: 'pay', subscriptionId: id } : { kind: 'subscribe' },
      req.customerActor.accountId,
      req.body,
      key,
      req.requestId ?? null,
    );
    if (plan) req[PLAN] = plan;
    return true;
  }
}

const Plan = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<Req>()[PLAN],
);

/**
 * V2-032 (docs/v2/01 R2, C-09, C-10, C-14; docs/v2/05 §1; DEC-532, DEC-534): the customer's subscriptions in
 * `CUSTOMER_ROUTES` (Bearer, an Idempotency-Key on every write). The reads are the account's own and never cached.
 */
@Controller('v1/customer/subscriptions')
export class CustomerSubscriptionsController {
  constructor(
    private readonly checkout: SubscriptionCheckout,
    private readonly commands: SubscriptionCommands,
    @Inject(ENV) private readonly env: Env,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get()
  @RequireCustomer()
  @Header('Cache-Control', 'private, no-store')
  async list(@CurrentCustomer() actor: CustomerActorContext) {
    return {
      items: await customerSubscriptions(this.db, this.env, actor.accountId, { now: this.clock.now() }),
    };
  }

  @Post()
  @RequireCustomer()
  @Command('POST /v1/customer/subscriptions')
  @UseGuards(SubscriptionCheckoutPreparer)
  async subscribe(
    @CurrentTx() tx: Tx,
    @CurrentCustomer() actor: CustomerActorContext,
    @Body(zodBody(R.subscribe.body)) _body: Out<typeof R.subscribe.body>,
    @Plan() plan: CheckoutPlan | undefined,
    @Client() client: ClientInfo,
  ) {
    return created(await this.checkout.finalize(tx, actor, plan, client, 'customer.subscription.subscribe'));
  }

  @Get(':subscriptionId')
  @RequireCustomer()
  @Header('Cache-Control', 'private, no-store')
  async one(@CurrentCustomer() actor: CustomerActorContext, @Param('subscriptionId') id: string) {
    const [s] = UUID.test(id)
      ? await customerSubscriptions(this.db, this.env, actor.accountId, { id, now: this.clock.now() })
      : [];
    if (!s) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'subscription' });
    return s;
  }

  @Post(':subscriptionId/pay')
  @RequireCustomer()
  @Command('POST /v1/customer/subscriptions/{subscriptionId}/pay')
  @UseGuards(SubscriptionCheckoutPreparer)
  async pay(
    @CurrentTx() tx: Tx,
    @CurrentCustomer() actor: CustomerActorContext,
    @Body(zodBody(R.subscriptionPay.body)) _body: Out<typeof R.subscriptionPay.body>,
    @Plan() plan: CheckoutPlan | undefined,
    @Client() client: ClientInfo,
  ) {
    return created(await this.checkout.finalize(tx, actor, plan, client, 'customer.subscription.pay'));
  }

  @Post(':subscriptionId/cancel')
  @RequireCustomer()
  @Command('POST /v1/customer/subscriptions/{subscriptionId}/cancel')
  cancel(
    @CurrentTx() tx: Tx,
    @CurrentCustomer() actor: CustomerActorContext,
    @Param('subscriptionId') id: string,
    @Body(zodBody(R.subscriptionCancel.body)) _body: Out<typeof R.subscriptionCancel.body>,
    @Client() client: ClientInfo,
  ) {
    return this.commands.cancel(tx, actor, id, client);
  }

  @Post(':subscriptionId/resume')
  @RequireCustomer()
  @Command('POST /v1/customer/subscriptions/{subscriptionId}/resume')
  resume(
    @CurrentTx() tx: Tx,
    @CurrentCustomer() actor: CustomerActorContext,
    @Param('subscriptionId') id: string,
    @Body(zodBody(R.subscriptionResume.body)) _body: Out<typeof R.subscriptionResume.body>,
    @Client() client: ClientInfo,
  ) {
    return this.commands.resume(tx, actor, id, client);
  }

  @Put(':subscriptionId/vehicles')
  @RequireCustomer()
  @Command('PUT /v1/customer/subscriptions/{subscriptionId}/vehicles')
  vehicles(
    @CurrentTx() tx: Tx,
    @CurrentCustomer() actor: CustomerActorContext,
    @Param('subscriptionId') id: string,
    @Body(zodBody(R.subscriptionVehicles.body)) body: Out<typeof R.subscriptionVehicles.body>,
    @Client() client: ClientInfo,
  ) {
    return this.commands.vehicles(tx, actor, id, body.vehicle_ids, client);
  }
}

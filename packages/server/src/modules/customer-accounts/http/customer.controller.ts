import {
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  Param,
  Patch,
  Post,
  Query,
  type PipeTransform,
} from '@nestjs/common';
import {
  CUSTOMER_ROUTES,
  CustomerHomeQuerySchema,
  CustomerLocationListQuerySchema,
  normalizeSaudiMobile,
} from '@point/shared/customer';
import type { z } from 'zod';
import type { CustomerActorContext } from '../../../core/actor-context/customer-actor.js';
import type { Env } from '../../../core/config/env.js';
import type { Clock } from '../../../core/clock/clock.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import {
  Command,
  CurrentCustomer,
  CurrentTx,
  Public,
  RequireCustomer,
  created,
} from '../../../http/decorators.js';
import { CLOCK, DATABASE, ENV } from '../../../http/tokens.js';
import { zodBody, zodToFields } from '../../../http/zod-pipe.js';
import type { ClientInfo } from '../../identity-access/application/auth-service.js';
import { Client } from '../../identity-access/http/client-info.js';
import { OBJECT_STORAGE, type ObjectStorage } from '../../media/index.js';
import { patchCustomerMe, recordCustomerConsents } from '../application/account-service.js';
import { buildCustomerMe, consentTexts, type ConsentTexts } from '../application/account-views.js';
import { logoutCustomer, refreshCustomerSession } from '../application/customer-sessions.js';
import { customerHome } from '../application/home.js';
import { getLocation, listLocations, type LocationDeps } from '../application/locations.js';
import { CustomerOtpService } from '../application/otp-service.js';
import { pointChannel } from '../application/point-channel.js';
import { addCustomerVehicle, listCustomerVehicles } from '../application/vehicles.js';

const R = CUSTOMER_ROUTES;
type Out<S extends z.ZodType> = z.output<S>;

/** 08: a phone that is not a Saudi mobile is PHONE_INVALID (as the staff intake), any other problem VALIDATION_FAILED. */
@Injectable()
class OtpRequestPipe implements PipeTransform<unknown, Out<typeof R.otpRequest.body>> {
  transform(value: unknown) {
    const raw = (value ?? {}) as { phone_e164?: unknown };
    if (typeof raw.phone_e164 === 'string' && normalizeSaudiMobile(raw.phone_e164) === null)
      throw new AppError('PHONE_INVALID', { field: 'phone_e164' });
    const r = R.otpRequest.body.safeParse(value ?? {});
    if (!r.success) throw new AppError('VALIDATION_FAILED', { fields: zodToFields(r.error) });
    return r.data;
  }
}

/** A strict query schema (`?q=…&limit=…`): unknown parameters are refused like unknown body fields. */
class ZodQueryPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: z.ZodType<T>) {}
  transform(value: unknown): T {
    const r = this.schema.safeParse(value ?? {});
    if (!r.success) throw new AppError('VALIDATION_FAILED', { fields: zodToFields(r.error) });
    return r.data;
  }
}

/**
 * The customer API `/v1/customer/*` of `CUSTOMER_ROUTES` (V2-010; contracts of V2-011, DEC-482): sign-in over
 * WhatsApp, rotating Bearer sessions, the account, consents, vehicles, listed locations and C-06's home read. The
 * sign-in calls are public and rate limited (no Idempotency-Key, like /v1/auth/login); the account writes take an
 * Idempotency-Key (customer_idempotency_keys). No route here reads a cookie or takes a staff/platform permission.
 */
@Controller('v1/customer')
export class CustomerController {
  private readonly otp: CustomerOtpService;
  private readonly texts: ConsentTexts;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {
    this.otp = new CustomerOtpService(env);
    this.texts = consentTexts(env);
  }

  /** V2-004's public read model needs the photo signer and the request's clock (DEC-499). */
  private locationDeps(): LocationDeps {
    return { storage: this.storage, now: this.clock.now(), ttlS: this.env.MEDIA_READ_URL_TTL_S };
  }

  @Post('auth/otp')
  @Public()
  @Command('POST /v1/customer/auth/otp', { idempotent: false })
  async otpRequest(
    @CurrentTx() tx: Tx,
    @Body(new OtpRequestPipe()) body: Out<typeof R.otpRequest.body>,
    @Client() client: ClientInfo,
  ) {
    const ch = await pointChannel(tx);
    return this.otp.request(
      tx,
      body,
      ch && ch.healthStatus !== 'down' ? { id: ch.id, orgId: ch.orgId } : null,
      client,
    );
  }

  @Post('auth/verify')
  @Public()
  @Command('POST /v1/customer/auth/verify', { idempotent: false })
  verify(
    @CurrentTx() tx: Tx,
    @Body(zodBody(R.otpVerify.body)) body: Out<typeof R.otpVerify.body>,
    @Client() client: ClientInfo,
  ) {
    return this.otp.verify(tx, body, client);
  }

  @Post('auth/refresh')
  @Public()
  @Command('POST /v1/customer/auth/refresh', { idempotent: false })
  refresh(
    @CurrentTx() tx: Tx,
    @Body(zodBody(R.refresh.body)) body: Out<typeof R.refresh.body>,
    @Client() client: ClientInfo,
  ) {
    return refreshCustomerSession(tx, body, client);
  }

  @Post('auth/logout')
  @RequireCustomer()
  @Command('POST /v1/customer/auth/logout', { idempotent: false })
  logout(
    @CurrentTx() tx: Tx,
    @CurrentCustomer() actor: CustomerActorContext,
    @Body(zodBody(R.logout.body)) body: Out<typeof R.logout.body>,
    @Client() client: ClientInfo,
  ) {
    return logoutCustomer(tx, actor, body, client);
  }

  @Get('me')
  @RequireCustomer()
  me(@CurrentCustomer() actor: CustomerActorContext) {
    return buildCustomerMe(this.db, this.texts, actor.accountId);
  }

  @Patch('me')
  @RequireCustomer()
  @Command('PATCH /v1/customer/me')
  patchMe(
    @CurrentTx() tx: Tx,
    @CurrentCustomer() actor: CustomerActorContext,
    @Body(zodBody(R.mePatch.body)) body: Out<typeof R.mePatch.body>,
    @Client() client: ClientInfo,
  ) {
    return patchCustomerMe(tx, this.texts, actor, body, client);
  }

  @Post('consents')
  @RequireCustomer()
  @Command('POST /v1/customer/consents')
  consents(
    @CurrentTx() tx: Tx,
    @CurrentCustomer() actor: CustomerActorContext,
    @Body(zodBody(R.consents.body)) body: Out<typeof R.consents.body>,
    @Client() client: ClientInfo,
  ) {
    return recordCustomerConsents(tx, this.texts, actor, body, client);
  }

  @Get('vehicles')
  @RequireCustomer()
  vehicles(@CurrentCustomer() actor: CustomerActorContext) {
    return listCustomerVehicles(this.db, actor.accountId);
  }

  @Post('vehicles')
  @RequireCustomer()
  @Command('POST /v1/customer/vehicles')
  async addVehicle(
    @CurrentTx() tx: Tx,
    @CurrentCustomer() actor: CustomerActorContext,
    @Body(zodBody(R.vehicleCreate.body)) body: Out<typeof R.vehicleCreate.body>,
    @Client() client: ClientInfo,
  ) {
    return created(await addCustomerVehicle(tx, actor, body, client));
  }

  @Get('locations')
  @RequireCustomer()
  locations(
    @Query(new ZodQueryPipe(CustomerLocationListQuerySchema))
    query: Out<typeof CustomerLocationListQuerySchema>,
  ) {
    return listLocations(this.db, this.locationDeps(), query);
  }

  @Get('locations/:venueId')
  @RequireCustomer()
  location(@Param('venueId') venueId: string) {
    return getLocation(this.db, this.locationDeps(), venueId);
  }

  @Get('home')
  @RequireCustomer()
  home(
    @CurrentCustomer() actor: CustomerActorContext,
    @Query(new ZodQueryPipe(CustomerHomeQuerySchema)) query: Out<typeof CustomerHomeQuerySchema>,
  ) {
    const from =
      query.lat !== undefined && query.lng !== undefined ? { lat: query.lat, lng: query.lng } : null;
    return customerHome(this.db, this.locationDeps(), actor.accountId, from);
  }
}

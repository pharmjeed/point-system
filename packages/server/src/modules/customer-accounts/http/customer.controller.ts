import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
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
import { addCustomerVehicle, listCustomerVehicles, removeCustomerVehicle } from '../application/vehicles.js';
import { deleteCustomerAccount } from '../application/account-deletion.js';
import { getCustomerPass, type PassKeys } from '../application/pass.js';
import { parseEncryptionKey } from '../../../core/crypto/crypto.js';

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

/**
 * C-20 (DEC-507): a deletion without its re-verification proof is CUSTOMER_REAUTH_REQUIRED (`reason: missing`) — what
 * the app has to do next — rather than a field error; anything else wrong with the body stays VALIDATION_FAILED.
 */
@Injectable()
class AccountDeletePipe implements PipeTransform<unknown, Out<typeof R.meDelete.body>> {
  transform(value: unknown) {
    const raw = (value ?? {}) as { reauth_token?: unknown };
    if (raw.reauth_token === undefined || raw.reauth_token === null || raw.reauth_token === '')
      throw new AppError('CUSTOMER_REAUTH_REQUIRED', { reason: 'missing' });
    const r = R.meDelete.body.safeParse(value ?? {});
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
  private readonly passKeys: PassKeys;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {
    this.otp = new CustomerOtpService(env);
    this.texts = consentTexts(env);
    const key = parseEncryptionKey(env.DATA_ENCRYPTION_KEY, env.DATA_ENCRYPTION_KEY_ID);
    this.passKeys = { key, keys: [key] };
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

  // ---- V2-012 (C-15) and V2-017 (C-20): DEC-505, DEC-507, DEC-508

  @Delete('vehicles/:vehicleId')
  @RequireCustomer()
  @Command('DELETE /v1/customer/vehicles/{vehicleId}')
  removeVehicle(
    @CurrentTx() tx: Tx,
    @CurrentCustomer() actor: CustomerActorContext,
    @Param('vehicleId') vehicleId: string,
    @Client() client: ClientInfo,
  ) {
    return removeCustomerVehicle(tx, actor, vehicleId, client);
  }

  @Post('auth/reauth/verify')
  @RequireCustomer()
  @Command('POST /v1/customer/auth/reauth/verify', { idempotent: false })
  reauthVerify(
    @CurrentTx() tx: Tx,
    @CurrentCustomer() actor: CustomerActorContext,
    @Body(zodBody(R.reauthVerify.body)) body: Out<typeof R.reauthVerify.body>,
    @Client() client: ClientInfo,
  ) {
    return this.otp.reauthVerify(tx, actor, body, client);
  }

  @Delete('me')
  @RequireCustomer()
  @Command('DELETE /v1/customer/me')
  deleteMe(
    @CurrentTx() tx: Tx,
    @CurrentCustomer() actor: CustomerActorContext,
    @Body(new AccountDeletePipe()) body: Out<typeof R.meDelete.body>,
    @Client() client: ClientInfo,
  ) {
    return deleteCustomerAccount(tx, this.env.CODE_PEPPER, actor, body, client);
  }

  // --- V2-013 (DEC-500): the entry pass, C-11 ---
  /**
   * The pass secret for the signed-in device (generates the QR offline). A read for the client, but the first call
   * creates the secret and a due rotation replaces it, so it runs in a transaction of its own; never cached.
   */
  @Get('pass')
  @RequireCustomer()
  @Header('Cache-Control', 'private, no-store')
  pass(@CurrentCustomer() actor: CustomerActorContext, @Client() client: ClientInfo) {
    return this.db.transaction((tx) => getCustomerPass(tx, this.passKeys, actor.accountId, client));
  }
  // --- end V2-013 ---
}

import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../../../core/errors/app-error.js';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import { newId } from '../../../core/crypto/ids.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { DATABASE } from '../../../http/tokens.js';
import { isUuid, notFound, validationFailed } from '../domain/errors.js';
import { existingLabelIssues, expandLabels, type LabelSpec } from '../domain/labels.js';
import { ListCursorCodec, pageOf } from '../infra/cursor.js';
import {
  SLOT_COLUMNS,
  SPOT_COLUMNS,
  labelNumberSql,
  labelPrefixSql,
  toKeyBoard,
  toKeySlot,
  toParkingSpot,
  toParkingZone,
  type KeyBoardRow,
  type KeySlotRow,
  type ParkingSpotRow,
  type ParkingZoneRow,
} from '../infra/rows.js';
import { assertResourceInScope, assertVenueParam, recheckVenueScope } from '../infra/scope.js';
import type {
  CreateKeyBoardBody,
  CreateKeySlotsBody,
  CreateParkingSpotsBody,
  CreateParkingZoneBody,
  ListKeyBoardsQuery,
  ListSpotsQuery,
  ListZonesQuery,
  UpdateLabelledBody,
  UpdateParkingZoneBody,
} from './schemas.js';
import { auditCommand, patchSet, type CommandMeta } from './support.js';

const ZONE_COLUMNS = `id, org_id, venue_id, name, sort_order, status`;
const BOARD_COLUMNS = `id, org_id, venue_id, name, status`;
const SPOT_ORDER = `z.sort_order, z.name, z.id, ${labelPrefixSql('s.label')}, (${labelNumberSql('s.label')})::numeric, s.label, s.id`;
const SLOT_ORDER = `${labelPrefixSql('k.label')}, (${labelNumberSql('k.label')})::numeric, k.label, k.id`;

/**
 * Pick-list mode (D-08): drivers always see only what they can pick (DEC-33, PNT-018 AC4); others ask for it
 * with `active_only=true` (or `available_only=true` for spots).
 */
function pickListOnly(actor: ActorContext, requested: boolean | undefined): boolean {
  return actor.role === 'driver' || requested === true;
}

@Injectable()
export class LayoutService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly cursors: ListCursorCodec,
  ) {}

  // -------------------------------------------------------------------------------------------
  // parking zones
  // -------------------------------------------------------------------------------------------

  async listZones(actor: ActorContext, venueId: string, q: ListZonesQuery) {
    assertVenueParam(actor, venueId);
    const activeOnly = pickListOnly(actor, q.active_only);
    const rows = await this.db.rows<ParkingZoneRow>(
      `SELECT ${ZONE_COLUMNS} FROM parking_zones WHERE venue_id = $1 AND org_id = $2
         ${activeOnly ? `AND status = 'active'` : ''}
        ORDER BY sort_order, name, id`,
      [venueId, actor.orgId],
    );
    return rows.map(toParkingZone);
  }

  async createZone(
    tx: Tx,
    actor: ActorContext,
    meta: CommandMeta,
    venueId: string,
    body: CreateParkingZoneBody,
  ) {
    assertVenueParam(actor, venueId);
    await recheckVenueScope(tx, actor, venueId, { explicit: true });
    const row = await tx.one<ParkingZoneRow>(
      `INSERT INTO parking_zones (id, org_id, venue_id, name, sort_order, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'active', $6, $6) RETURNING ${ZONE_COLUMNS}`,
      [newId(), actor.orgId, venueId, body.name, body.sort_order ?? 0, tx.now],
    );
    await auditCommand(tx, actor, meta, {
      action: 'venue.manage',
      entityType: 'parking_zone',
      entityId: row.id,
      venueId,
      after: { name: row.name, sort_order: row.sort_order, status: row.status },
    });
    return toParkingZone(row);
  }

  /** PATCH /v1/parking-zones/{zoneId}. A duplicate name is `parking_zones_venue_id_name_key` (08 §5.2). */
  async updateZone(
    tx: Tx,
    actor: ActorContext,
    meta: CommandMeta,
    zoneId: string,
    body: UpdateParkingZoneBody,
  ) {
    await this.assertRowInScope(tx, actor, 'parking_zones', zoneId, 'parking_zone');
    const zone = await tx.one<ParkingZoneRow>(
      `SELECT ${ZONE_COLUMNS} FROM parking_zones WHERE id = $1 FOR NO KEY UPDATE`,
      [zoneId],
    );
    await recheckVenueScope(tx, actor, zone.venue_id, { resource: 'parking_zone' });
    const diff = patchSet(
      zone as unknown as Record<string, unknown>,
      body,
      ['name', 'sort_order', 'status'],
      2,
    );
    let row: ParkingZoneRow = zone;
    if (diff.sets.length > 0) {
      row = await tx.one<ParkingZoneRow>(
        `UPDATE parking_zones SET ${diff.sets.join(', ')} WHERE id = $1 RETURNING ${ZONE_COLUMNS}`,
        [zoneId, ...diff.params],
      );
    }
    await auditCommand(tx, actor, meta, {
      action: 'venue.manage',
      entityType: 'parking_zone',
      entityId: zoneId,
      venueId: zone.venue_id,
      before: diff.before,
      after: diff.after,
      ...(diff.sets.length === 0 ? { metadata: { noop: true } } : {}),
    });
    return toParkingZone(row);
  }

  // -------------------------------------------------------------------------------------------
  // parking spots
  // -------------------------------------------------------------------------------------------

  /**
   * GET /v1/venues/{venueId}/parking-spots — every spot with `occupied` (an active `spot_allocations` row; the
   * occupying ticket is never disclosed, DEC-33), in zone order then natural label order (A-2 before A-10).
   * `active_only`: active spots of active zones; `available_only`: additionally not occupied.
   */
  async listSpots(actor: ActorContext, venueId: string, q: ListSpotsQuery) {
    assertVenueParam(actor, venueId);
    const activeOnly = pickListOnly(actor, q.active_only) || q.available_only === true;
    const availableOnly = q.available_only === true;
    const scope = `spots|${venueId}|${q.zone_id ?? ''}|${activeOnly ? 1 : 0}|${availableOnly ? 1 : 0}`;
    const after = q.cursor ? this.cursors.decode(q.cursor, scope, 7) : null;
    const params: unknown[] = [venueId, actor.orgId];
    let where = `s.venue_id = $1 AND s.org_id = $2`;
    if (q.zone_id) {
      params.push(q.zone_id);
      where += ` AND s.zone_id = $${params.length}`;
    }
    if (activeOnly) where += ` AND s.status = 'active' AND z.status = 'active'`;
    if (availableOnly) {
      where += ` AND NOT EXISTS (SELECT 1 FROM spot_allocations a WHERE a.parking_spot_id = s.id AND a.released_at IS NULL)`;
    }
    if (after) {
      const n = params.length;
      params.push(...after);
      where +=
        ` AND (z.sort_order, z.name, z.id, ${labelPrefixSql('s.label')}, (${labelNumberSql('s.label')})::numeric, s.label, s.id)` +
        ` > ($${n + 1}::int, $${n + 2}::text, $${n + 3}::uuid, $${n + 4}::text, $${n + 5}::numeric, $${n + 6}::text, $${n + 7}::uuid)`;
    }
    params.push(q.limit + 1);
    const rows = await this.db.rows<ParkingSpotRow>(
      `SELECT ${SPOT_COLUMNS} FROM parking_spots s JOIN parking_zones z ON z.id = s.zone_id
        WHERE ${where} ORDER BY ${SPOT_ORDER} LIMIT $${params.length}`,
      params,
    );
    return pageOf(rows, q.limit, toParkingSpot, (r) =>
      this.cursors.encode(scope, [
        r.zone_sort_order,
        r.zone_name,
        r.zone_id,
        r.label_prefix,
        r.label_number,
        r.label,
        r.id,
      ]),
    );
  }

  /**
   * POST /v1/venues/{venueId}/parking-spots — bulk creation in one zone of the venue (labels or a range). A label
   * repeated in the request or already in the zone is rejected with its index (PNT-018 AC3, 08 §5.2); the
   * `parking_spots_zone_id_label_key` mapping covers a concurrent insert.
   */
  async createSpots(
    tx: Tx,
    actor: ActorContext,
    meta: CommandMeta,
    venueId: string,
    body: CreateParkingSpotsBody,
  ) {
    assertVenueParam(actor, venueId);
    await recheckVenueScope(tx, actor, venueId, { explicit: true });
    const zone = await tx.maybeOne<ParkingZoneRow>(
      `SELECT ${ZONE_COLUMNS} FROM parking_zones WHERE id = $1 AND venue_id = $2 AND org_id = $3`,
      [body.zone_id, venueId, actor.orgId],
    );
    if (!zone) throw notFound('parking_zone');
    const labels = await this.newLabels(
      tx,
      body,
      `SELECT label FROM parking_spots WHERE zone_id = $1 AND label = ANY($2::text[])`,
      zone.id,
    );
    const ids = labels.map(() => newId());
    await tx.query(
      `INSERT INTO parking_spots (id, org_id, venue_id, zone_id, label, status, created_at, updated_at)
       SELECT u.id, $2::uuid, $3::uuid, $4::uuid, u.label, 'active', $6::timestamptz, $6::timestamptz
         FROM unnest($1::uuid[], $5::text[]) AS u(id, label)`,
      [ids, actor.orgId, venueId, zone.id, labels, tx.now],
    );
    const rows = await tx.rows<ParkingSpotRow>(
      `SELECT ${SPOT_COLUMNS} FROM parking_spots s JOIN parking_zones z ON z.id = s.zone_id
        WHERE s.id = ANY($1::uuid[]) ORDER BY ${SPOT_ORDER}`,
      [ids],
    );
    await auditCommand(tx, actor, meta, {
      action: 'venue.manage',
      entityType: 'parking_zone',
      entityId: zone.id,
      venueId,
      after: { created_spots: rows.length, labels },
      metadata: { bulk: 'parking_spots' },
    });
    return rows.map(toParkingSpot);
  }

  /**
   * PATCH /v1/parking-spots/{spotId}. The spot row is locked (`FOR NO KEY UPDATE`) before the allocation check, so
   * a complete-parking that reads the spot `FOR SHARE` either sees it inactive or makes this command see the
   * allocation: deactivating an occupied spot → PARKING_SPOT_OCCUPIED (07 §2.5, FR-ORG-03).
   */
  async updateSpot(tx: Tx, actor: ActorContext, meta: CommandMeta, spotId: string, body: UpdateLabelledBody) {
    await this.assertRowInScope(tx, actor, 'parking_spots', spotId, 'parking_spot');
    const spot = await tx.one<{ id: string; venue_id: string; label: string; status: string }>(
      `SELECT id, venue_id, label, status FROM parking_spots WHERE id = $1 FOR NO KEY UPDATE`,
      [spotId],
    );
    await recheckVenueScope(tx, actor, spot.venue_id, { resource: 'parking_spot' });
    if (body.status === 'inactive' && spot.status !== 'inactive') {
      const occupied = await tx.maybeOne(
        `SELECT 1 FROM spot_allocations WHERE parking_spot_id = $1 AND released_at IS NULL`,
        [spotId],
      );
      if (occupied) throw new AppError('PARKING_SPOT_OCCUPIED', { parking_spot_id: spotId });
    }
    const diff = patchSet(spot, body, ['label', 'status'], 2);
    if (diff.sets.length > 0) {
      await tx.query(`UPDATE parking_spots SET ${diff.sets.join(', ')} WHERE id = $1`, [
        spotId,
        ...diff.params,
      ]);
    }
    const row = await tx.one<ParkingSpotRow>(
      `SELECT ${SPOT_COLUMNS} FROM parking_spots s JOIN parking_zones z ON z.id = s.zone_id WHERE s.id = $1`,
      [spotId],
    );
    await auditCommand(tx, actor, meta, {
      action: 'venue.manage',
      entityType: 'parking_spot',
      entityId: spotId,
      venueId: spot.venue_id,
      before: diff.before,
      after: diff.after,
      ...(diff.sets.length === 0 ? { metadata: { noop: true } } : {}),
    });
    return toParkingSpot(row);
  }

  // -------------------------------------------------------------------------------------------
  // key boards and key slots
  // -------------------------------------------------------------------------------------------

  /** GET /v1/venues/{venueId}/key-boards — `[{ board, slots }]`, slots with `occupied` (07). */
  async listKeyBoards(actor: ActorContext, venueId: string, q: ListKeyBoardsQuery) {
    assertVenueParam(actor, venueId);
    const activeOnly = pickListOnly(actor, q.active_only);
    const boards = await this.db.rows<KeyBoardRow>(
      `SELECT ${BOARD_COLUMNS} FROM key_boards WHERE venue_id = $1 AND org_id = $2
         ${activeOnly ? `AND status = 'active'` : ''}
        ORDER BY name, id`,
      [venueId, actor.orgId],
    );
    const slots = await this.db.rows<KeySlotRow>(
      `SELECT ${SLOT_COLUMNS} FROM key_slots k JOIN key_boards b ON b.id = k.key_board_id
        WHERE k.venue_id = $1 AND k.org_id = $2
          ${activeOnly ? `AND k.status = 'active' AND b.status = 'active'` : ''}
        ORDER BY ${SLOT_ORDER}`,
      [venueId, actor.orgId],
    );
    const byBoard = new Map<string, KeySlotRow[]>();
    for (const s of slots) {
      const list = byBoard.get(s.key_board_id) ?? [];
      list.push(s);
      byBoard.set(s.key_board_id, list);
    }
    return boards.map((b) => ({ board: toKeyBoard(b), slots: (byBoard.get(b.id) ?? []).map(toKeySlot) }));
  }

  async createKeyBoard(
    tx: Tx,
    actor: ActorContext,
    meta: CommandMeta,
    venueId: string,
    body: CreateKeyBoardBody,
  ) {
    assertVenueParam(actor, venueId);
    await recheckVenueScope(tx, actor, venueId, { explicit: true });
    const row = await tx.one<KeyBoardRow>(
      `INSERT INTO key_boards (id, org_id, venue_id, name, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'active', $5, $5) RETURNING ${BOARD_COLUMNS}`,
      [newId(), actor.orgId, venueId, body.name, tx.now],
    );
    await auditCommand(tx, actor, meta, {
      action: 'venue.manage',
      entityType: 'key_board',
      entityId: row.id,
      venueId,
      after: { name: row.name, status: row.status },
    });
    return toKeyBoard(row);
  }

  /** POST /v1/key-boards/{boardId}/slots — bulk creation (labels or a range), duplicates rejected with indexes. */
  async createKeySlots(
    tx: Tx,
    actor: ActorContext,
    meta: CommandMeta,
    boardId: string,
    body: CreateKeySlotsBody,
  ) {
    if (!isUuid(boardId)) throw notFound('key_board');
    const board = await tx.maybeOne<KeyBoardRow>(`SELECT ${BOARD_COLUMNS} FROM key_boards WHERE id = $1`, [
      boardId,
    ]);
    assertResourceInScope(actor, board, 'key_board');
    await recheckVenueScope(tx, actor, board.venue_id, { resource: 'key_board' });
    const labels = await this.newLabels(
      tx,
      body,
      `SELECT label FROM key_slots WHERE key_board_id = $1 AND label = ANY($2::text[])`,
      board.id,
    );
    const ids = labels.map(() => newId());
    await tx.query(
      `INSERT INTO key_slots (id, org_id, venue_id, key_board_id, label, status, created_at, updated_at)
       SELECT u.id, $2::uuid, $3::uuid, $4::uuid, u.label, 'active', $6::timestamptz, $6::timestamptz
         FROM unnest($1::uuid[], $5::text[]) AS u(id, label)`,
      [ids, actor.orgId, board.venue_id, board.id, labels, tx.now],
    );
    const rows = await tx.rows<KeySlotRow>(
      `SELECT ${SLOT_COLUMNS} FROM key_slots k JOIN key_boards b ON b.id = k.key_board_id
        WHERE k.id = ANY($1::uuid[]) ORDER BY ${SLOT_ORDER}`,
      [ids],
    );
    await auditCommand(tx, actor, meta, {
      action: 'venue.manage',
      entityType: 'key_board',
      entityId: board.id,
      venueId: board.venue_id,
      after: { created_slots: rows.length, labels },
      metadata: { bulk: 'key_slots' },
    });
    return rows.map(toKeySlot);
  }

  /** PATCH /v1/key-slots/{slotId} — deactivating a slot holding a key → KEY_SLOT_OCCUPIED (same locking as spots). */
  async updateKeySlot(
    tx: Tx,
    actor: ActorContext,
    meta: CommandMeta,
    slotId: string,
    body: UpdateLabelledBody,
  ) {
    await this.assertRowInScope(tx, actor, 'key_slots', slotId, 'key_slot');
    const slot = await tx.one<{ id: string; venue_id: string; label: string; status: string }>(
      `SELECT id, venue_id, label, status FROM key_slots WHERE id = $1 FOR NO KEY UPDATE`,
      [slotId],
    );
    await recheckVenueScope(tx, actor, slot.venue_id, { resource: 'key_slot' });
    if (body.status === 'inactive' && slot.status !== 'inactive') {
      const occupied = await tx.maybeOne(
        `SELECT 1 FROM key_slot_allocations WHERE key_slot_id = $1 AND released_at IS NULL`,
        [slotId],
      );
      if (occupied) throw new AppError('KEY_SLOT_OCCUPIED', { key_slot_id: slotId });
    }
    const diff = patchSet(slot, body, ['label', 'status'], 2);
    if (diff.sets.length > 0) {
      await tx.query(`UPDATE key_slots SET ${diff.sets.join(', ')} WHERE id = $1`, [slotId, ...diff.params]);
    }
    const row = await tx.one<KeySlotRow>(
      `SELECT ${SLOT_COLUMNS} FROM key_slots k JOIN key_boards b ON b.id = k.key_board_id WHERE k.id = $1`,
      [slotId],
    );
    await auditCommand(tx, actor, meta, {
      action: 'venue.manage',
      entityType: 'key_slot',
      entityId: slotId,
      venueId: slot.venue_id,
      before: diff.before,
      after: diff.after,
      ...(diff.sets.length === 0 ? { metadata: { noop: true } } : {}),
    });
    return toKeySlot(row);
  }

  // -------------------------------------------------------------------------------------------

  /**
   * Scope of a layout row addressed by id, read without a lock first so a row of another venue or organization is
   * never locked (non-disclosure: 404 of the resource).
   */
  private async assertRowInScope(
    tx: Tx,
    actor: ActorContext,
    table: 'parking_zones' | 'parking_spots' | 'key_slots',
    id: string,
    resource: 'parking_zone' | 'parking_spot' | 'key_slot',
  ): Promise<void> {
    if (!isUuid(id)) throw notFound(resource);
    const head = await tx.maybeOne<{ org_id: string; venue_id: string }>(
      `SELECT org_id, venue_id FROM ${table} WHERE id = $1`,
      [id],
    );
    assertResourceInScope(actor, head, resource);
  }

  /** Expands the request and rejects in-request and existing duplicates in one VALIDATION_FAILED. */
  private async newLabels(tx: Tx, spec: LabelSpec, existingSql: string, parentId: string): Promise<string[]> {
    const expanded = expandLabels(spec);
    if (expanded.issues.length > 0) throw validationFailed(expanded.issues);
    const existing = await tx.rows<{ label: string }>(existingSql, [parentId, expanded.labels]);
    const issues = existingLabelIssues(expanded, new Set(existing.map((r) => r.label)));
    if (issues.length > 0) throw validationFailed(issues);
    return expanded.labels;
  }
}

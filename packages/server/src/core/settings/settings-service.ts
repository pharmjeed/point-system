import { parseOrgSettings, parseVenueSettings, type OrgSettings, type VenueSettings } from '@point/shared';
import type { Tx } from '../db/tx.js';

/** Venue/org settings merged with canon §12 defaults via the shared zod schemas. */
export async function venueSettings(tx: Pick<Tx, 'maybeOne'>, venueId: string): Promise<VenueSettings> {
  const row = await tx.maybeOne<{ settings: unknown }>(`SELECT settings FROM venues WHERE id = $1`, [
    venueId,
  ]);
  return parseVenueSettings(row?.settings ?? {});
}

export async function orgSettings(tx: Pick<Tx, 'maybeOne'>, orgId: string): Promise<OrgSettings> {
  const row = await tx.maybeOne<{ settings: unknown }>(`SELECT settings FROM organizations WHERE id = $1`, [
    orgId,
  ]);
  return parseOrgSettings(row?.settings ?? {});
}

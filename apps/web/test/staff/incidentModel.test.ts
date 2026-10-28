import { describe, expect, it } from 'vitest';
import type { Incident } from '@/api/types';
import {
  editFrom,
  INCIDENT_NEXT,
  incidentEditError,
  incidentPatch,
  needsResolution,
} from '@/features/supervisor/incidentModel';
import { ago } from './fixtures';

describe('S-12 incident edits (11 §6.11)', () => {
  const incident: Incident = {
    id: 'i-1',
    venue_id: 'v-1',
    type: 'vehicle_damage',
    status: 'open',
    severity: 'medium',
    description: 'خدش في الباب الخلفي',
    opened_by: { id: 'u-1', full_name: 'نورة' },
    owner: null,
    resolution: null,
    version: 4,
    created_at: ago(600),
  };

  it('sends expected_version and the changed fields only', () => {
    const edit = editFrom(incident);
    expect(incidentPatch(incident, edit)).toEqual({ body: { expected_version: 4 }, changed: false });
    const next = { ...edit, status: 'resolved' as const, ownerId: 'u-2', resolution: '  أُصلح الخدش  ' };
    expect(incidentPatch(incident, next)).toEqual({
      body: { expected_version: 4, status: 'resolved', owner_id: 'u-2', resolution: 'أُصلح الخدش' },
      changed: true,
    });
    const owned = { ...incident, owner: { id: 'u-2', full_name: 'سعد' }, resolution: 'قديم' };
    expect(incidentPatch(owned, { ...editFrom(owned), ownerId: null, resolution: '' }).body).toEqual({
      expected_version: 4,
      owner_id: null,
      resolution: null,
    });
  });

  it('a resolution is required to resolve or close; closed is final', () => {
    const edit = { ...editFrom(incident), status: 'resolved' as const };
    expect(incidentEditError(edit)).toBe('resolution');
    expect(incidentEditError({ ...edit, resolution: 'تم' })).toBeNull();
    expect(incidentEditError({ ...edit, description: 'x', resolution: 'تم' })).toBe('description');
    expect(needsResolution('closed')).toBe(true);
    expect(needsResolution('in_review')).toBe(false);
    expect(INCIDENT_NEXT.open).toEqual(['in_review', 'resolved']);
    expect(INCIDENT_NEXT.resolved).toEqual(['closed', 'in_review']);
    expect(INCIDENT_NEXT.closed).toEqual([]);
  });
});

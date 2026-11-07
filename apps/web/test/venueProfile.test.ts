import { describe, expect, it } from 'vitest';
import type { VenuePublicProfile } from '@/api/venueProfile';
import { isPlatformArea, paths } from '@/app/paths';
import { adminSectionsFor } from '@/features/supervisor/permissions';
import {
  canPrice,
  formatSar,
  missingForSubmit,
  operatorCanEdit,
  operatorCanSubmit,
  parseCoordinate,
  parseSar,
  reviewActionsFor,
  sameAsSaved,
  subscriptionsAllowed,
  toBody,
  toForm,
  validateForm,
} from '@/features/venues/profileModel';
import * as arStaff from '@/i18n/ar.staff';

const profile = (patch: Partial<VenuePublicProfile> = {}): VenuePublicProfile => ({
  venue_id: 'v-1',
  venue: { code: 'RMS', name_ar: 'قاعة', name_en: null, status: 'active' },
  status: 'draft',
  category: 'mall',
  address: 'العليا',
  city: 'الرياض',
  lat: 24.7136,
  lng: 46.6753,
  opening_hours: { always_open: false, days: { sun: [{ open: '08:00', close: '22:00' }] } },
  photos: [{ id: 'p-1', url: 'https://storage.invalid/x?sig', expires_at: '2026-11-07T12:05:00Z' }],
  subscriptions_enabled: false,
  pay_per_visit_halalas: null,
  approved_at: null,
  review_note: null,
  version: 3,
  updated_at: '2026-11-07T12:00:00Z',
  ...patch,
});

/** V2-004: the S-13 «ملف الموقع العام» form and the P-04 review rules. */
describe('venue public profile form (O-04)', () => {
  it('round-trips the profile into the PUT body (full replacement, photos by id, the version)', () => {
    const form = toForm(profile());
    expect(toBody(form, 3)).toEqual({
      expected_version: 3,
      category: 'mall',
      address: 'العليا',
      city: 'الرياض',
      lat: 24.7136,
      lng: 46.6753,
      opening_hours: { always_open: false, days: { sun: [{ open: '08:00', close: '22:00' }] } },
      photo_ids: ['p-1'],
    });
    expect(sameAsSaved(form, profile())).toBe(true);
    expect(sameAsSaved({ ...form, city: 'جدة' }, profile())).toBe(false);
    // an empty profile (no row yet) starts empty
    const empty = toForm(
      profile({ status: null, category: null, lat: null, lng: null, photos: [], version: 0 }),
    );
    expect(empty).toMatchObject({ category: '', lat: '', lng: '', photoIds: [] });
  });

  it('coordinates take Western or Arabic-Indic digits; one without the other is refused', () => {
    expect(parseCoordinate('٢٤٫٧١٣٦')).toBe(24.7136);
    expect(parseCoordinate(' 46.6753 ')).toBe(46.6753);
    expect(parseCoordinate('')).toBeNull();
    expect(parseCoordinate('24,7')).toBe('invalid');
    const form = toForm(profile());
    expect(validateForm({ ...form, lng: '' })).toEqual({ lng: arStaff.venueProfile.issues.pair });
    expect(validateForm({ ...form, lat: '95' })).toMatchObject({ lat: arStaff.venueProfile.issues.number });
    expect(toBody({ ...form, lat: '', lng: '' }, 3)).toMatchObject({ lat: null, lng: null });
  });

  it('the hours are checked with the server schema (overlap, empty interval); overnight is allowed', () => {
    const form = toForm(profile());
    const days = (sun: { open: string; close: string }[]) => ({ ...form, days: { ...form.days, sun } });
    expect(
      validateForm(
        days([
          { open: '08:00', close: '12:00' },
          { open: '11:00', close: '13:00' },
        ]),
      ),
    ).toEqual({ opening_hours: arStaff.venueProfile.issues.hours });
    expect(validateForm(days([{ open: '10:00', close: '10:00' }])).opening_hours).toBeDefined();
    expect(validateForm(days([{ open: '20:00', close: '02:00' }]))).toEqual({});
    expect(validateForm({ ...form, category: '' })).toEqual({
      category: arStaff.venueProfile.issues.required,
    });
  });

  it('submit needs the address, city, position and hours (or 24/7)', () => {
    const form = toForm(profile());
    expect(missingForSubmit(form)).toEqual([]);
    const bare = toForm(
      profile({
        address: null,
        city: null,
        lat: null,
        lng: null,
        opening_hours: { always_open: false, days: {} },
      }),
    );
    expect(missingForSubmit(bare)).toEqual(['address', 'city', 'lat', 'opening_hours']);
    expect(missingForSubmit({ ...bare, alwaysOpen: true })).not.toContain('opening_hours');
  });

  it('the operator edits any status but hidden and submits a draft only (DEC-492)', () => {
    expect(
      [null, 'draft', 'submitted', 'approved', 'hidden'].map((s) => operatorCanEdit(s as never)),
    ).toEqual([true, true, true, true, false]);
    expect(operatorCanSubmit('draft')).toBe(true);
    expect(operatorCanSubmit('submitted')).toBe(false);
    expect(operatorCanSubmit(null)).toBe(false);
  });

  it('S-13 lists the section for venue.manage only (owner, admin)', () => {
    expect(adminSectionsFor({ permissions: ['venue.manage'] })).toEqual(['listing']);
    expect(adminSectionsFor({ permissions: ['venue.read'] })).toEqual([]);
  });
});

describe('P-04 review (platform)', () => {
  const reviewer = ['platform.self', 'platform.venue_review'];
  it('actions per status, for platform.venue_review only', () => {
    expect(reviewActionsFor('submitted', reviewer)).toEqual(['approve', 'send-back']);
    expect(reviewActionsFor('approved', reviewer)).toEqual(['hide']);
    expect(reviewActionsFor('hidden', reviewer)).toEqual(['unhide']);
    expect(reviewActionsFor('draft', reviewer)).toEqual([]);
    expect(reviewActionsFor('submitted', ['platform.self', 'platform.plan_manage'])).toEqual([]);
  });

  it('pricing is platform.plan_manage; halls sell no subscription; SAR ↔ halalas', () => {
    expect(canPrice(['platform.plan_manage'])).toBe(true);
    expect(canPrice(reviewer)).toBe(false);
    expect(subscriptionsAllowed('hall')).toBe(false);
    expect(subscriptionsAllowed('office')).toBe(true);
    expect(subscriptionsAllowed(null)).toBe(false);
    expect(parseSar('20')).toBe(2000);
    expect(parseSar('١٢٫٥')).toBe(1250);
    expect(parseSar('')).toBeNull();
    expect(parseSar('0')).toBe('invalid');
    expect(parseSar('abc')).toBe('invalid');
    expect(formatSar(2000)).toBe('20');
    expect(formatSar(1250)).toBe('12.50');
  });

  it('P-04 lives in the platform area; the copy names no brand and covers every status, category and day', () => {
    expect(isPlatformArea(paths.platformVenues)).toBe(true);
    expect(isPlatformArea(`${paths.platformVenues}/x`)).toBe(true);
    const all = JSON.stringify([arStaff.venueProfile, arStaff.s13Listing, arStaff.p04]);
    expect(all).not.toContain('بوينت');
    expect(all).not.toContain('مصاف');
    expect(Object.keys(arStaff.venueProfile.status).sort()).toEqual(
      ['approved', 'draft', 'hidden', 'none', 'submitted'].sort(),
    );
    expect(Object.keys(arStaff.venueProfile.category)).toHaveLength(8);
    expect(Object.keys(arStaff.venueProfile.days)).toEqual(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
    expect(arStaff.s13.sections.listing).toBe(arStaff.s13Listing.title);
  });
});

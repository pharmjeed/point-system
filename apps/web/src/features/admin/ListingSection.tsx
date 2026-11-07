import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ImagePlus, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { putToStorage } from '@/api/field';
import {
  fetchVenueProfile,
  putVenueProfile,
  requestVenuePhoto,
  submitVenueProfile,
  venueProfileKeys,
  type VenueCategory,
  type VenuePublicProfile,
} from '@/api/venueProfile';
import { Banner, Button, FieldError, IconButton, Select, TextField, Toggle } from '@/components';
import {
  OPENING_DAYS,
  VENUE_PROFILE_MAX_PHOTOS,
  missingForSubmit,
  operatorCanEdit,
  operatorCanSubmit,
  sameAsSaved,
  toBody,
  toForm,
  validateForm,
  formatSar,
  type ProfileForm,
} from '@/features/venues/profileModel';
import { fetchVenues, staffKeys } from '@/features/supervisor/staffApi';
import { PageSkeleton, ReadError } from '@/features/supervisor/ui';
import { useStaffCommand } from '@/features/supervisor/useStaffCommand';
import { useOnline } from '@/hooks/useOnline';
import { s13Listing, venueProfile as copy } from '@/i18n/ar.staff';
import { fmt } from '@/i18n/fmt';
import { compressPhoto, PHOTO_TYPE } from '@/lib/photos';

const CATEGORIES = Object.keys(copy.category) as VenueCategory[];

/**
 * S-13 «ملف الموقع العام» (O-04, V2-004): the owner/admin (`venue.manage`) picks a venue, edits its public profile
 * (category, address, position, weekly hours, photos), saves it as a draft and submits it to the platform. The
 * status and the reviewer's note come from the server; the prices are the platform's and are shown read-only.
 */
export function ListingSection() {
  const venues = useQuery({ queryKey: staffKeys.venues(), queryFn: ({ signal }) => fetchVenues(signal) });
  const [venueId, setVenueId] = useState('');
  const list = venues.data?.items ?? [];
  useEffect(() => {
    if (!venueId && list[0]) setVenueId(list[0].id);
  }, [venueId, list]);
  if (venues.isPending) return <PageSkeleton />;
  if (!venues.data) return <ReadError error={venues.error} onRetry={() => void venues.refetch()} />;
  if (!list.length) return <p className="st-muted">{s13Listing.noVenues}</p>;
  return (
    <section className="st-form" aria-labelledby="listing-intro">
      <p className="st-muted m-0" id="listing-intro">
        {s13Listing.intro}
      </p>
      <Select
        id="listing-venue"
        label={s13Listing.pickVenue}
        value={venueId}
        options={list.map((v) => [v.id, v.name_ar] as const)}
        onChange={(e) => setVenueId(e.target.value)}
      />
      {venueId ? <ProfileEditor key={venueId} venueId={venueId} /> : null}
    </section>
  );
}

function ProfileEditor({ venueId }: { venueId: string }) {
  const q = useQuery({
    queryKey: venueProfileKeys.staff(venueId),
    queryFn: ({ signal }) => fetchVenueProfile(venueId, signal),
  });
  if (q.isPending) return <PageSkeleton />;
  if (!q.data) return <ReadError error={q.error} onRetry={() => void q.refetch()} />;
  return <ProfileFormView venueId={venueId} profile={q.data} />;
}

function StatusLine({ profile }: { profile: VenuePublicProfile }) {
  const note = profile.review_note;
  return (
    <>
      <p className="m-0 font-bold" data-testid="listing-status">
        {copy.status[profile.status ?? 'none']}
      </p>
      {note?.kind === 'sent_back' ? (
        <Banner kind="warning" rounded message={fmt(s13Listing.sentBack, { reason: note.reason })} />
      ) : null}
      {profile.status === 'hidden' ? (
        <Banner
          kind="error"
          rounded
          message={s13Listing.hiddenInfo}
          detail={note ? fmt(s13Listing.hiddenReason, { reason: note.reason }) : undefined}
        />
      ) : null}
      {profile.status === 'approved' ? (
        <Banner kind="info" rounded message={s13Listing.editApprovedWarning} />
      ) : null}
      {profile.status === 'submitted' ? (
        <Banner kind="info" rounded message={s13Listing.submittedInfo} />
      ) : null}
    </>
  );
}

function ProfileFormView({ venueId, profile }: { venueId: string; profile: VenuePublicProfile }) {
  const online = useOnline();
  const qc = useQueryClient();
  const [form, setForm] = useState<ProfileForm>(() => toForm(profile));
  const [touched, setTouched] = useState(false);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  useEffect(() => {
    if (!touched) setForm(toForm(profile));
  }, [profile, touched]);
  const key = venueProfileKeys.staff(venueId);
  const editable = operatorCanEdit(profile.status);
  const onSaved = (saved: VenuePublicProfile) => {
    qc.setQueryData(key, saved);
    setTouched(false);
    setForm(toForm(saved));
  };
  const save = useStaffCommand(
    (f: ProfileForm, k: string) => putVenueProfile(venueId, toBody(f, profile.version), k),
    {
      successMessage: s13Listing.saved,
      invalidate: [key],
      onSuccess: onSaved,
    },
  );
  const submit = useStaffCommand((version: number, k: string) => submitVenueProfile(venueId, version, k), {
    successMessage: s13Listing.submitted,
    invalidate: [key],
    onSuccess: onSaved,
  });
  const photo = useStaffCommand(
    (blob: Blob, k: string) =>
      requestVenuePhoto(venueId, { content_type: PHOTO_TYPE, byte_size: blob.size }, k),
    { successMessage: null },
  );

  const local = validateForm(form);
  const fields = { ...save.fields, ...submit.fields };
  const errorOf = (f: string) => (touched ? local[f] : undefined) ?? fields[f];
  const edit = (patch: Partial<ProfileForm>) => {
    setTouched(true);
    setForm((f) => ({ ...f, ...patch }));
  };
  const setInterval = (
    day: (typeof OPENING_DAYS)[number],
    i: number,
    patch: Partial<{ open: string; close: string }>,
  ) =>
    edit({ days: { ...form.days, [day]: form.days[day].map((x, j) => (j === i ? { ...x, ...patch } : x)) } });

  const addPhoto = async (file: File) => {
    setUploadError(null);
    setUploading(true);
    try {
      const blob = await compressPhoto(file);
      const r = await photo.run(blob);
      if (!r) return;
      await putToStorage(r.upload, blob);
      setPreviews((p) => ({ ...p, [r.photo_id]: URL.createObjectURL(blob) }));
      edit({ photoIds: [...form.photoIds, r.photo_id] });
    } catch {
      setUploadError(copy.uploadFailed);
    } finally {
      setUploading(false);
    }
  };
  const urlOf = (id: string) => previews[id] ?? profile.photos.find((p) => p.id === id)?.url;
  const saved = profile.status !== null && sameAsSaved(form, profile);

  return (
    <form
      className="st-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (Object.keys(local).length) return;
        void save.run(form);
      }}
    >
      <StatusLine profile={profile} />
      <fieldset className="st-fieldset st-form" disabled={!editable}>
        <Select
          id="listing-category"
          label={copy.fields.category}
          value={form.category}
          placeholder="—"
          options={CATEGORIES.map((c) => [c, copy.category[c]] as const)}
          error={errorOf('category')}
          onChange={(e) => edit({ category: e.target.value as VenueCategory })}
        />
        <div className="st-grid2">
          <TextField
            id="listing-address"
            label={copy.fields.address}
            value={form.address}
            maxLength={200}
            error={errorOf('address')}
            onChange={(e) => edit({ address: e.target.value })}
          />
          <TextField
            id="listing-city"
            label={copy.fields.city}
            value={form.city}
            maxLength={80}
            error={errorOf('city')}
            onChange={(e) => edit({ city: e.target.value })}
          />
          <TextField
            id="listing-lat"
            label={copy.fields.lat}
            hint={copy.fields.coordinatesHint}
            dir="ltr"
            inputMode="decimal"
            value={form.lat}
            error={errorOf('lat')}
            onChange={(e) => edit({ lat: e.target.value })}
          />
          <TextField
            id="listing-lng"
            label={copy.fields.lng}
            dir="ltr"
            inputMode="decimal"
            value={form.lng}
            error={errorOf('lng')}
            onChange={(e) => edit({ lng: e.target.value })}
          />
        </div>

        <fieldset className="st-fieldset st-form" aria-describedby="listing-hours-hint">
          <legend className="font-bold">{copy.fields.hours}</legend>
          <Toggle
            id="listing-always-open"
            label={copy.fields.alwaysOpen}
            checked={form.alwaysOpen}
            onChange={(alwaysOpen) => edit({ alwaysOpen })}
          />
          <p className="st-muted m-0" id="listing-hours-hint">
            {copy.fields.overnightHint}
          </p>
          {!form.alwaysOpen
            ? OPENING_DAYS.map((day) => (
                <div key={day} className="st-form" data-testid={`listing-day-${day}`}>
                  <div className="st-inline-list">
                    <span className="font-bold">{copy.days[day]}</span>
                    {form.days[day].length === 0 ? (
                      <span className="st-muted">{copy.fields.closed}</span>
                    ) : null}
                    {form.days[day].length < 4 ? (
                      <IconButton
                        icon={Plus}
                        variant="ghost"
                        label={`${copy.addInterval} — ${copy.days[day]}`}
                        onClick={() =>
                          edit({
                            days: {
                              ...form.days,
                              [day]: [...form.days[day], { open: '09:00', close: '17:00' }],
                            },
                          })
                        }
                      />
                    ) : null}
                  </div>
                  {form.days[day].map((iv, i) => (
                    <div key={i} className="st-inline-list">
                      <TextField
                        id={`listing-${day}-${i}-open`}
                        label={copy.fields.open}
                        type="time"
                        dir="ltr"
                        value={iv.open}
                        onChange={(e) => setInterval(day, i, { open: e.target.value })}
                      />
                      <TextField
                        id={`listing-${day}-${i}-close`}
                        label={copy.fields.close}
                        type="time"
                        dir="ltr"
                        value={iv.close === '24:00' ? '00:00' : iv.close}
                        onChange={(e) => setInterval(day, i, { close: e.target.value })}
                      />
                      <IconButton
                        icon={Trash2}
                        variant="ghost"
                        label={`${copy.removeInterval} — ${copy.days[day]}`}
                        onClick={() =>
                          edit({ days: { ...form.days, [day]: form.days[day].filter((_, j) => j !== i) } })
                        }
                      />
                    </div>
                  ))}
                </div>
              ))
            : null}
          {errorOf('opening_hours') ? <FieldError role="alert">{errorOf('opening_hours')}</FieldError> : null}
        </fieldset>

        <fieldset className="st-fieldset st-form">
          <legend className="font-bold">{copy.fields.photos}</legend>
          <p className="st-muted m-0">{fmt(copy.fields.photosHint, { n: VENUE_PROFILE_MAX_PHOTOS })}</p>
          <div className="st-photos">
            {form.photoIds.map((id) => (
              <figure key={id} className="st-photo">
                {urlOf(id) ? <img src={urlOf(id)} alt="" /> : null}
                <IconButton
                  icon={Trash2}
                  variant="ghost"
                  label={copy.removePhoto}
                  onClick={() => edit({ photoIds: form.photoIds.filter((x) => x !== id) })}
                />
              </figure>
            ))}
          </div>
          {form.photoIds.length < VENUE_PROFILE_MAX_PHOTOS && editable ? (
            <label className="st-inline-list" htmlFor="listing-photo">
              <ImagePlus aria-hidden />
              <span>{uploading ? copy.uploading : copy.addPhoto}</span>
              <input
                id="listing-photo"
                type="file"
                accept="image/*"
                className="pt-sr"
                disabled={uploading || !online}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void addPhoto(file);
                }}
              />
            </label>
          ) : null}
          {uploadError || photo.message ? (
            <FieldError role="alert">{uploadError ?? photo.message}</FieldError>
          ) : null}
        </fieldset>
      </fieldset>

      <dl className="st-facts">
        <div className="st-fact">
          <dt>{copy.fields.subscriptions}</dt>
          <dd>{profile.subscriptions_enabled ? copy.enabled : copy.disabled}</dd>
        </div>
        <div className="st-fact">
          <dt>{copy.fields.payPerVisit}</dt>
          <dd>
            {profile.pay_per_visit_halalas
              ? fmt(copy.sar, { amount: formatSar(profile.pay_per_visit_halalas) })
              : copy.noPrice}
          </dd>
        </div>
      </dl>

      {save.message ? <FieldError role="alert">{save.message}</FieldError> : null}
      {submit.message ? <FieldError role="alert">{submit.message}</FieldError> : null}
      {editable ? (
        <div className="st-inline-list">
          <Button
            type="submit"
            loading={save.pending}
            disabled={!online || uploading || (touched && Object.keys(local).length > 0)}
          >
            {s13Listing.saveDraft}
          </Button>
          {operatorCanSubmit(profile.status) ? (
            <Button
              type="button"
              variant="secondary"
              loading={submit.pending}
              disabled={!online || !saved || missingForSubmit(form).length > 0}
              onClick={() => void submit.run(profile.version)}
            >
              {s13Listing.submit}
            </Button>
          ) : null}
          {operatorCanSubmit(profile.status) && !saved ? (
            <span className="st-muted">{s13Listing.unsaved}</span>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

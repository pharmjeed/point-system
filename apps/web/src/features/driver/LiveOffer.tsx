import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError, displayMessage, isApiError } from '@/api/errors';
import { acceptOffer } from '@/api/field';
import { queryKeys } from '@/api/queryClient';
import type { OfferCard as OfferCardData } from '@/api/types';
import { Banner, OfferCard, Sheet } from '@/components';
import { useCommand } from '@/hooks/useCommand';
import { components, d05, d09, live } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { withTicket } from '@/i18n/fmtNode';
import { playSound, stopSound } from '@/lib/audio';
import { serverNow } from '@/lib/serverClock';
import { applyOfferClosed } from '@/realtime/driverHome';
import { useCommandGate } from '@/realtime/hooks';
import { reportOfferSeen, requestResync } from '@/realtime/manager';
import { useOfferLive } from '@/realtime/offerStore';
import { useUiStore } from '@/stores/ui';
import { driverPaths, fieldSettings, offerAction, plateValue, vehicleSummary } from './fieldModel';
import { homeRegistry, updateHome, useCachedHome } from './useDriverHome';

/**
 * The live D-09 card (PNT-067): the head request of the driver's snapshot — only the oldest request the driver
 * may act on (02 D-04) — with the countdown on server time, the reminder (event or `reminder_at`), the
 * accept / reserve press and the 02 D-09 error handling; the same card on D-04 and in the Sheet over the other
 * driver screens. Sounds (02 §1.10, 14 §7): the arrival of a round plays `offer` or `broadcast` once (with
 * Android vibration), the reminder plays `reminder` once, and the press, `task.claimed` and `offer.closed`
 * stop them.
 */

/** Offer errors after which the card is gone (02 D-09 «إزالة البطاقة»): toast with the server text, sync. */
export const OFFER_GONE = [
  'TASK_ALREADY_CLAIMED',
  'OFFER_EXPIRED',
  'OFFER_REVOKED',
  'NOT_OFFER_RECIPIENT',
  'OFFER_NOT_FOUND',
];

/**
 * Errors that ask for a full sync before the card is shown again (02 D-04, D-09): their text stays with the
 * head card the resync shows (02 D-09 «مزامنة وإظهار الطلب الأقدم: «يوجد طلب أقدم يجب قبوله أولًا.»»).
 */
const SYNC_FIRST = ['OLDER_REQUEST_PENDING', 'NEXT_TASK_ALREADY_RESERVED', 'DRIVER_NOT_AVAILABLE'];

const offerKey = (offerId: string) => `offer:${offerId}`;
const announced = new Set<string>();
const remindedPlayed = new Set<string>();

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState === 'visible',
  );
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
}

/**
 * Sounds of the head card, for the whole driver frame: a new round is announced once while the page is
 * visible (07 §4.5: in the background Web Push takes over); leaving the head stops its sound. No head card →
 * no refusal text is kept for the next one.
 */
export function useOfferAlerts(offer: OfferCardData | null | undefined): void {
  const visible = useDocumentVisible();
  const offerId = offer?.offer_id ?? null;
  const mode = offer?.mode;
  const reminderAt = offer?.reminder_at ?? null;
  const reminded = useOfferLive((s) => (offerId ? !!s.reminded[offerId] : false));
  const previous = useRef<string | null>(null);

  useEffect(() => {
    if (previous.current && previous.current !== offerId) stopSound(offerKey(previous.current));
    previous.current = offerId;
    if (!offerId) useOfferLive.getState().setRefusal(null);
  }, [offerId]);

  useEffect(() => {
    if (!offerId || !visible || announced.has(offerId)) return;
    announced.add(offerId);
    void playSound(mode === 'single' ? 'offer' : 'broadcast', { key: offerKey(offerId) });
  }, [offerId, mode, visible]);

  // the reminder: `offer.reminder` (event) or `reminder_at` passed on the server clock
  useEffect(() => {
    if (!offerId || !reminderAt) return;
    const fire = () => useOfferLive.getState().markReminded(offerId);
    const wait = Date.parse(reminderAt) - serverNow();
    if (wait <= 0) {
      fire();
      return;
    }
    const timer = setTimeout(fire, wait);
    return () => clearTimeout(timer);
  }, [offerId, reminderAt]);

  useEffect(() => {
    if (!offerId || !reminded || !visible || remindedPlayed.has(offerId)) return;
    remindedPlayed.add(offerId);
    void playSound('reminder', { key: offerKey(offerId) }); // no vibration (02 D-09)
  }, [offerId, reminded, visible]);
}

/** The head card as D-09: accept / reserve with the 02 D-09 handling of every refusal. */
export function LiveOfferCard({ offer, onDone }: { offer: OfferCardData; onDone?: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const gate = useCommandGate();
  const home = useCachedHome();
  const visible = useDocumentVisible();
  const pushToast = useUiStore((s) => s.pushToast);
  const reminded = useOfferLive((s) => !!s.reminded[offer.offer_id]);
  const refusal = useOfferLive((s) => s.refusal);
  const setRefusal = useOfferLive((s) => s.setRefusal);
  const accept = useCommand((offerId: string, key: string) => acceptOffer(offerId, key));
  const [error, setError] = useState<string | null>(null);
  const settings = fieldSettings(home);

  // the card is on screen (D-04, or the Sheet open): `task.claimed` then says «قبل الطلب سائق آخر» (02 D-09)
  useEffect(() => {
    useOfferLive.getState().setOnScreen(offer.offer_id);
    return () => {
      if (useOfferLive.getState().onScreen === offer.offer_id) useOfferLive.getState().setOnScreen(null);
    };
  }, [offer.offer_id]);

  // 15 §9.4: `client.offer_seen` once the card is really on screen
  useEffect(() => {
    if (!visible) return;
    const arrived = useOfferLive.getState().arrivedAt[offer.offer_id];
    reportOfferSeen(offer.offer_id, arrived ? serverNow() - Date.parse(arrived) : undefined);
  }, [offer.offer_id, visible]);

  const dropCard = useCallback(
    (taskId: string | null) => {
      updateHome(qc, (h) => applyOfferClosed(h, [offer.offer_id], taskId, homeRegistry));
      void qc.invalidateQueries({ queryKey: queryKeys.home, exact: true });
    },
    [qc, offer.offer_id],
  );

  // 02 D-09: at zero «انتهى العرض» for a second, then the card leaves (the snapshot says what is next)
  const onExpire = useCallback(() => {
    stopSound(offerKey(offer.offer_id));
    setTimeout(() => dropCard(null), 1000);
  }, [offer.offer_id, dropCard]);

  const onAccept = async () => {
    stopSound(offerKey(offer.offer_id)); // PNT-066: the press (a reservation too) stops the sound at once
    setError(null);
    setRefusal(null);
    const n = offer.ticket.display_number;
    try {
      const result = await accept.run(offer.offer_id);
      dropCard(offer.task_id);
      void qc.invalidateQueries({ queryKey: queryKeys.me });
      onDone?.();
      if (result.result === 'accepted') {
        pushToast({ message: withTicket(d09.accepted, n), tone: 'success' });
        navigate(driverPaths.task(result.task.id));
      } else {
        pushToast({ message: withTicket(d09.reserved, n), tone: 'success' });
      }
    } catch (e) {
      const message = displayMessage(e);
      if (isApiError(e, ...OFFER_GONE)) {
        // the card was stale (another driver, expiry, revocation): it leaves, the toast says why
        pushToast({ message, tone: 'error' });
        dropCard(offer.task_id);
        onDone?.();
        requestResync('manual');
        return;
      }
      if (isApiError(e, ...SYNC_FIRST)) {
        // the text goes with the head card the resync shows (the older request, or this one again)
        setRefusal(message);
        requestResync('manual');
        return;
      }
      setError(message);
      if (e instanceof ApiError) void qc.invalidateQueries({ queryKey: queryKeys.home, exact: true });
    }
  };

  return (
    <OfferCard
      key={offer.offer_id}
      offerId={offer.offer_id}
      mode={offer.mode}
      ticketNumber={offer.ticket.display_number}
      vehicleSummary={vehicleSummary(offer.ticket.vehicle)}
      plate={plateValue(offer.ticket.plate)}
      venue={offer.ticket.event_name_ar}
      requestedAt={offer.requested_at}
      expiresAt={offer.mode === 'single' ? (offer.expires_at ?? undefined) : undefined}
      totalSeconds={settings.offerTtlS}
      canAcceptAs={offerAction(offer)}
      offline={gate.unconfirmed}
      offlineText={d09.offline}
      waiting={!gate.ready}
      loading={accept.pending}
      error={error ?? refusal ?? undefined}
      reminded={reminded}
      reminderText={live.reminder}
      expiredText={d09.expired}
      onExpire={onExpire}
      onAccept={onAccept}
    />
  );
}

/**
 * The line of the request banner (docs/progress/notes/s5-web.md DEC-PROPOSED-6): 02 D-05's sentence when the
 * driver may reserve it as the next task; the 14 §5.1 card title with the ticket number when he may accept
 * it; the 02 D-09 note when he already holds a next task (the card is view-only).
 */
export function offerBannerText(offer: OfferCardData): string {
  const action = offerAction(offer);
  if (action === 'reserve_next') return d05.openRequest;
  if (action === 'accept')
    return fmt(offer.mode === 'single' ? live.offerSingle : live.offerBroadcast, {
      n: offer.ticket.display_number,
    });
  return components.offer.viewOnly;
}

/**
 * Over every driver screen but D-04 a new request is a banner with «عرض» that opens D-09 in a Sheet, without
 * leaving the screen or clearing its inputs (02 §2.1 note, D-05, D-09 «في Sheet فوق الشاشات الأخرى»).
 */
export function OfferSheetBanner({ offer }: { offer: OfferCardData | null | undefined }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!offer) setOpen(false);
  }, [offer]);
  if (!offer) return null;
  return (
    <>
      <Banner
        kind="info"
        message={offerBannerText(offer)}
        actionLabel={d09.show}
        onAction={() => setOpen(true)}
      />
      <Sheet open={open} onOpenChange={setOpen} title={components.offer.layer}>
        {open ? <LiveOfferCard key={offer.offer_id} offer={offer} onDone={() => setOpen(false)} /> : null}
      </Sheet>
    </>
  );
}

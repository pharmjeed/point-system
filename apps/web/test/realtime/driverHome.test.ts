import { describe, expect, it } from 'vitest';
import {
  applyDriverState,
  applyOffer,
  applyOfferClosed,
  applyTaskCard,
  applyTaskGone,
  applyTicketSummary,
  createRegistry,
  mergeSnapshot,
} from '@/realtime/driverHome';
import { home, IDS, offerCard, taskCard } from './fixtures';

const T0 = 1_000_000;

describe('merge by version (07 §4.5, PNT-065)', () => {
  it('an event-newer task card is not overwritten by a snapshot requested before it', () => {
    const reg = createRegistry();
    const cached = home({ next_task: taskCard(IDS.taskA, 'assigned_waiting', 4) });
    // the promotion arrives (v5) after the snapshot request left (requested at T0, event applied at T0+10)
    const promoted = applyTaskCard(cached, taskCard(IDS.taskA, 'accepted', 5), reg, T0 + 10).home;
    expect(promoted.current_task?.task.version).toBe(5);
    expect(promoted.next_task).toBeNull();
    const stale = home({ next_task: taskCard(IDS.taskA, 'assigned_waiting', 4), driver_state: 'retrieving' });
    const merged = mergeSnapshot(promoted, stale, reg, T0);
    expect(merged.current_task?.task).toMatchObject({ id: IDS.taskA, status: 'accepted', version: 5 });
    expect(merged.next_task).toBeNull();
  });

  it('a snapshot requested after the event decides (the server is the source of truth)', () => {
    const reg = createRegistry();
    const cached = applyTaskCard(home(), taskCard(IDS.taskA, 'accepted', 5), reg, T0).home;
    const fresh = home({ current_task: null }); // completed meanwhile, the event was lost
    const merged = mergeSnapshot(cached, fresh, reg, T0 + 50);
    expect(merged.current_task).toBeNull();
  });

  it('a task that left the driver (withdrawn) stays gone against an older snapshot', () => {
    const reg = createRegistry();
    const cached = home({ current_task: taskCard(IDS.taskA, 'accepted', 5) });
    const { home: after, removed } = applyTaskGone(cached, IDS.taskA, 6, reg, T0 + 10);
    expect(removed?.task.id).toBe(IDS.taskA);
    expect(after.current_task).toBeNull();
    const older = home({ current_task: taskCard(IDS.taskA, 'accepted', 5) });
    expect(mergeSnapshot(after, older, reg, T0).current_task).toBeNull();
  });

  it('task.updated with a version not newer than the one applied is ignored', () => {
    const reg = createRegistry();
    const first = applyTaskCard(home(), taskCard(IDS.taskA, 'in_progress', 7), reg, T0);
    expect(first.applied).toBe(true);
    const late = applyTaskCard(first.home, taskCard(IDS.taskA, 'accepted', 6), reg, T0 + 1);
    expect(late.applied).toBe(false);
    expect(late.home.current_task?.task.status).toBe('in_progress');
    const duplicate = applyTaskCard(first.home, taskCard(IDS.taskA, 'in_progress', 7), reg, T0 + 2);
    expect(duplicate.applied).toBe(false);
  });

  it('places cards by status: accepted / in_progress current, assigned_waiting next; completed leaves', () => {
    const reg = createRegistry();
    let h = applyTaskCard(home(), taskCard(IDS.taskA, 'in_progress', 3), reg, T0).home;
    h = applyTaskCard(h, taskCard(IDS.taskB, 'assigned_waiting', 2, IDS.ticketB, 131), reg, T0).home;
    expect(h.current_task?.task.id).toBe(IDS.taskA);
    expect(h.next_task?.task.id).toBe(IDS.taskB);
    h = applyTaskCard(h, taskCard(IDS.taskA, 'completed', 4), reg, T0).home;
    expect(h.current_task).toBeNull();
    h = applyTaskCard(h, taskCard(IDS.taskB, 'accepted', 3, IDS.ticketB, 131), reg, T0).home;
    expect(h.current_task?.task.id).toBe(IDS.taskB);
    expect(h.next_task).toBeNull();
  });

  it('ticket.updated refreshes the card ticket with newer versions only', () => {
    const reg = createRegistry();
    const h = home({ current_task: taskCard(IDS.taskA, 'in_progress', 3) });
    const summary = {
      id: IDS.ticketA,
      version: 4,
      status: 'ready' as const,
      plate: { country: 'SA', display: '1234 ب ح د' },
      vehicle: { make: 'toyota', color: 'white' },
    };
    const updated = applyTicketSummary(h, summary, reg, T0);
    expect(updated.current_task?.ticket).toMatchObject({ status: 'ready', version: 4 });
    expect(applyTicketSummary(updated, { ...summary, version: 3, status: 'retrieving' }, reg, T0)).toBe(
      updated,
    );
  });

  it('driver.state_changed applied after the request wins over the snapshot', () => {
    const reg = createRegistry();
    const cached = applyDriverState(home({ driver_state: 'available' }), 'on_break', reg, T0 + 10);
    expect(mergeSnapshot(cached, home({ driver_state: 'available' }), reg, T0).driver_state).toBe('on_break');
    expect(mergeSnapshot(cached, home({ driver_state: 'available' }), reg, T0 + 20).driver_state).toBe(
      'available',
    );
  });
});

describe('the head card: only the oldest actionable request (02 D-04, PNT-067)', () => {
  it('a newer request does not replace the head; an older one does', () => {
    const reg = createRegistry();
    const older = offerCard(IDS.offerA, IDS.taskA, '2026-10-29T17:58:00.000Z');
    const newer = offerCard(IDS.offerB, IDS.taskB, '2026-10-29T17:59:30.000Z', { mode: 'broadcast' });
    let h = applyOffer(home(), older, reg, T0);
    expect(h.offer?.offer_id).toBe(IDS.offerA);
    h = applyOffer(h, newer, reg, T0 + 1);
    expect(h.offer?.offer_id).toBe(IDS.offerA);
    const oldest = offerCard(IDS.offerC, IDS.taskC, '2026-10-29T17:50:00.000Z');
    h = applyOffer(h, oldest, reg, T0 + 2);
    expect(h.offer?.offer_id).toBe(IDS.offerC);
  });

  it('a claimed round leaves; the next known candidate takes its place until the resync', () => {
    const reg = createRegistry();
    let h = applyOffer(home(), offerCard(IDS.offerA, IDS.taskA, '2026-10-29T17:58:00.000Z'), reg, T0);
    h = applyOffer(h, offerCard(IDS.offerB, IDS.taskB, '2026-10-29T17:59:00.000Z'), reg, T0);
    h = applyOfferClosed(h, [IDS.offerA], IDS.taskA, reg);
    expect(h.offer?.offer_id).toBe(IDS.offerB);
    h = applyOfferClosed(h, [], IDS.taskB, reg);
    expect(h.offer).toBeNull();
  });

  it('a closed round never comes back from a snapshot that was already travelling', () => {
    const reg = createRegistry();
    const card = offerCard(IDS.offerA, IDS.taskA, '2026-10-29T17:58:00.000Z');
    const cached = applyOfferClosed(applyOffer(home(), card, reg, T0), [IDS.offerA], IDS.taskA, reg);
    expect(cached.offer).toBeNull();
    expect(mergeSnapshot(cached, home({ offer: card }), reg, T0 + 5).offer).toBeNull();
    // a frame for the closed round (late delivery) is ignored too
    expect(applyOffer(cached, card, reg, T0 + 6).offer).toBeNull();
  });

  it('the driver accepting the head (its own task.updated) closes the card', () => {
    const reg = createRegistry();
    const h = applyOffer(home(), offerCard(IDS.offerA, IDS.taskA, '2026-10-29T17:58:00.000Z'), reg, T0);
    const after = applyTaskCard(h, taskCard(IDS.taskA, 'accepted', 3), reg, T0 + 1).home;
    expect(after.offer).toBeNull();
    expect(after.current_task?.task.id).toBe(IDS.taskA);
  });

  it('candidates learned before the snapshot request yield to the snapshot head', () => {
    const reg = createRegistry();
    const cached = applyOffer(home(), offerCard(IDS.offerA, IDS.taskA, '2026-10-29T17:58:00.000Z'), reg, T0);
    const snap = home({ offer: offerCard(IDS.offerB, IDS.taskB, '2026-10-29T17:59:00.000Z') });
    expect(mergeSnapshot(cached, snap, reg, T0 + 100).offer?.offer_id).toBe(IDS.offerB);
  });
});

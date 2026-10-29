import { expect, type Page } from '@playwright/test';
import { arrangeParked, EVENT_R1, startDuty } from './driver';
import type { FakeServer, SeedUserKey } from './fake';

/**
 * Arrangements for the live driver specs (PNT-065 … PNT-068): parked cars to request, busy drivers (a broadcast
 * offers them «حجز كمهمة تالية»), and the network switches of a page (airplane mode = the browser offline and
 * the realtime server unreachable for that driver).
 */

let serial = 3000;

/** `n` cars parked by DRV3, who then goes on break (so the requests go to the drivers under test). */
export function parkedCars(fake: FakeServer, n: number): Array<{ ticketId: string; displayNumber: number }> {
  startDuty(fake, 'DRV3');
  const cars = Array.from({ length: n }, (_, i) => {
    serial += 1;
    const arranged = arrangeParked(fake, 'DRV3', {
      serial: String(serial),
      keyTag: String(serial),
      spot: `A-${String(20 + i).padStart(2, '0')}`,
      slot: String(40 + i),
    });
    return { ticketId: arranged.ticketId, displayNumber: arranged.displayNumber };
  });
  fake.exec('DRV3', 'POST /v1/me/duty/break', {}, { active: true });
  return cars;
}

/** On duty with an intake in hand (`intake_parking`): a broadcast offers «حجز كمهمة تالية». */
export function busyDriver(fake: FakeServer, as: SeedUserKey): string {
  startDuty(fake, as);
  return fake.exec(as, 'POST /v1/tickets', {}, { event_id: EVENT_R1 }).ticket.id as string;
}

/** Airplane mode: the browser goes offline and this driver's realtime connection drops. */
export async function airplaneOn(page: Page, fake: FakeServer, as: SeedUserKey): Promise<void> {
  fake.realtime.down = true;
  fake.realtime.drop(as);
  await page.context().setOffline(true);
}

export async function airplaneOff(page: Page, fake: FakeServer): Promise<void> {
  fake.realtime.down = false;
  await page.context().setOffline(false);
}

/** The D-04 head card (exactly one OfferCard on the page). */
export function offerCardOf(page: Page) {
  return page.locator('section.pt-offer');
}

export async function expectOneOffer(page: Page, displayNumber: number): Promise<void> {
  await expect(offerCardOf(page)).toHaveCount(1);
  await expect(offerCardOf(page)).toHaveAttribute('aria-label', new RegExp(`تذكرة ${displayNumber}$`));
}

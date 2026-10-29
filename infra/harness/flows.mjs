// Staff flows through the real routes, shared by the load generator and the chaos runs.

/** Throws unless the answer is 2xx (with the route and the error code in the message). */
export async function must(p, what) {
  const r = await p;
  if (r.status < 200 || r.status >= 300)
    throw new Error(`${what}: ${r.status} ${r.error?.code ?? ''}`.trim());
  return r;
}

/**
 * A WhatsApp ticket from intake to `parked` (D-05 … D-08): POST /v1/tickets → PATCH intake (plate, vehicle, phone,
 * verbal consent, key tag) → submit (the direct link plans W-01) → complete-parking in the given spot and slot.
 * @param {import('./api.mjs').ApiClient} api a driver on duty
 * @param {{ eventId: string, phone: string, plateDigits: string, keyTag: string, spotId: string, slotId: string }} t
 */
export async function intakeAndPark(api, t) {
  const created = await must(
    api.command('POST', '/v1/tickets', { event_id: t.eventId, channel: 'whatsapp' }),
    'intake',
  );
  const ticketId = created.data.ticket.id;
  const taskId = created.data.task.id;
  const patched = await must(
    api.command('PATCH', `/v1/tickets/${ticketId}/intake`, {
      expected_version: created.data.ticket.version,
      channel: 'whatsapp',
      plate: { digits: t.plateDigits, letters_ar: 'ب ح د' },
      vehicle: { make: 'تويوتا', model: 'كامري', color: 'أبيض', type: 'sedan' },
      customer_phone: t.phone,
      consent: { method: 'verbal_staff_confirmed', confirmed: true },
      key_tag: t.keyTag,
    }),
    'patch-intake',
  );
  await must(
    api.command('POST', `/v1/tickets/${ticketId}/submit-intake`, { expected_version: patched.data.version }),
    'submit-intake',
  );
  await must(
    api.command('POST', `/v1/tasks/${taskId}/complete-parking`, {
      parking_spot_id: t.spotId,
      key_slot_id: t.slotId,
    }),
    'complete-parking',
  );
  return { ticketId, parkTaskId: taskId, phone: t.phone };
}

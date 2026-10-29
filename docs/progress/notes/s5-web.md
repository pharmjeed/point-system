# S5 web — the live driver app (PNT-065 … PNT-072, web parts)

Scope: `apps/web` (sync protocol, in-page audio, live offer card, full D-04 and D-15, D-12/D-13, D-14 and the PWA,
form persistence, Web Push in the Service Worker) and the bundle split of the Arabic dictionary. The lead numbers
the proposals below into `docs/DECISIONS.md`.

## Proposed decisions

**DEC-PROPOSED-1 — `Me.session.device_id`** — context: `POST /v1/me/audio-test` needs `device_id` and
`PUT /v1/me/devices/{deviceId}` needs the id in the path, but `GET /v1/me` did not say which `devices` row the sign-in
linked (09 §9.5, `auth_sessions.device_id`; proposal A of pnt-035.md). Without it the web app cannot record the D-03
audio test, the notification permission or the Web Push subscription on the real API (the e2e fake already sent it).
— decision: `Me.session.device_id` (uuid or `null` for a session without a linked device) is returned by
`buildMe` (`packages/server/src/modules/identity-access/application/views.ts`, one column of `auth_sessions`);
`apps/api/test/me-device.int.test.ts` proves the id, the audio test and the push subscription on it. — affected
files: 07 §2.1 and `07_openapi.yaml` (`Me.session.device_id`), 09 §9.5.

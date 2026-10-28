# @point/web — staff PWA (POINT)

React 19 + Vite 8 + TypeScript (strict) PWA used only by staff: driver, supervisor, admin, owner.
Arabic-first, RTL (`<html lang="ar" dir="rtl">`), Western digits (DEC-17), times shown in `Asia/Riyadh`.
Built in PNT-021 (shell + design system) and PNT-022 (sign-in screens D-01, D-02, S-01).

Customers never use this app (WhatsApp only). The staff brand name comes from `VITE_BRAND_STAFF_NAME_AR`
(and `brand` in `GET /v1/me`); the customer brand appears only on the surfaces canon §1 allows (D-07 QR panel,
S-03 message preview, S-13 channel settings). No brand name is written in `src/` (`scripts/check-brand.mjs`,
`test/brand-assets.test.ts`).

## Commands

```bash
pnpm --filter @point/web dev         # Vite on :5173, proxies /v1 /ws /webhooks /health → http://localhost:3000 (DEC-29)
pnpm --filter @point/web build       # tsc --noEmit + vite build → dist/
pnpm --filter @point/web typecheck
pnpm --filter @point/web test        # vitest, pure logic (test/*.test.ts)
pnpm --filter @point/web test:e2e    # Playwright: builds, serves `vite preview` on :5317, API mocked in the browser
pnpm --filter @point/web brand:sync  # re-copy icons, sounds and manifest from brand/ into public/
```

`VITE_ENABLE_GALLERY=true` adds the component gallery at `/_gallery` (both themes side by side, for comparison with
`docs/design/system/screenshots/`). The e2e build enables it; production builds do not contain it (dead branch, no chunk).

Environment (`.env` at the repo root, 05 §8 — only public `VITE_*` values, never a secret):
`VITE_API_BASE_URL` (empty = same origin), `VITE_WS_PATH`, `VITE_VAPID_PUBLIC_KEY`, `VITE_BRAND_STAFF_NAME_AR`,
`VITE_BRAND_STAFF_NAME_EN`, `VITE_BRAND_CUSTOMER_NAME_AR` (allowed surfaces only), `VITE_APP_VERSION`.
If `VITE_BRAND_STAFF_NAME_AR` is not set at all, `vite.config.ts` takes `short_name` from the copied brand manifest.

## Layout

```
index.html            head from brand/manifest/head-snippet.html; title/app-title from VITE_BRAND_STAFF_NAME_AR
public/               byte-identical copies from brand/: icons/ (app-icons), sounds/ (6 mp3), manifest.webmanifest
scripts/sync-brand.mjs
src/
  main.tsx            fonts + styles + <App/>
  app/                App (providers: Radix DirectionProvider rtl, React Query, router), router (02 §9.1 routes),
                      guards (RequireSession/RequireDriver/RequireStaff), RootLayout (theme, connectivity,
                      session-level error codes), paths, sessionEnd
  api/                client.ts (fetch wrapper), command.ts (Idempotency-Key + retries), errors.ts (ApiError,
                      NetworkError), auth.ts (auth endpoints), queryClient.ts, types.ts (07_openapi.yaml shapes)
  stores/             zustand: session.ts (MFA step token, why a session ended — memory only), ui.ts (toasts,
                      theme preference, online, last sync)
  hooks/              useCommand / useSubmitGuard, useMe / useBrand, useOnline, useThemeArea, useCountdown, useServerNow
  i18n/               ar.ts (all of 02 §8 + screen copy, stable keys), errors.ts (08 text per canon error code), fmt.ts
  lib/                format.ts (Intl ar-SA-u-nu-latn, Asia/Riyadh), phone.ts (E.164, mask), digits.ts,
                      brand.ts, theme.ts, serverClock.ts, secretPolicy.ts, contrast.ts, cx.ts
  styles/             index.css (Tailwind v4 + brand/tokens imported in place), components.css, fonts.ts,
                      contrastPairs.ts (token pairs checked by test/contrast.test.ts)
  components/         the design-system components (names from 03 §3)
  features/           auth (D-01, D-02, S-01), driver (shell, D-03/D-04/D-12/D-14), ops (staff shell + S-xx
                      placeholders), venues (S-08, S-09), drivers (S-05, S-06), common (FormSheet, QueryView,
                      StateChip, form error placement), session (logout, connection sheet), system (D-15, 404)
  dev/Gallery.tsx     component gallery (VITE_ENABLE_GALLERY only)
test/                 vitest unit tests
e2e/                  Playwright specs + support/api.ts (static in-browser mock), support/fake/ (stateful fake
                      backend seeded from packages/db/src/seed: sessions, canon §10 permissions, scope,
                      Idempotency-Key replay, 07/08 errors), support/actors.ts (one context per actor),
                      support/checks.ts
```

## Tokens, fonts, themes

- Values come only from `brand/tokens` (DEC-49/50). `src/styles/index.css` imports `brand/tokens/tokens.css` and
  `brand/tokens/tailwind.theme.css` **directly from `brand/`** (no copy): one source of truth, a token change lands on
  the next build. `test/contrast.test.ts` also proves `tokens.css` equals `tokens.json`.
- Component CSS (`components.css`) re-implements the published design system's look using only `--pt-*` roles and
  logical properties. It is unlayered so it can turn off the global `:focus-visible` ring on inputs whose wrapper draws
  the ring. The DEC-50 focus ring from `tokens.css` is kept (the design-system bundle's older ring is not used).
- Fonts: `@fontsource/ibm-plex-sans-arabic` 400–700 and `@fontsource/ibm-plex-mono` 400/600, Arabic + Latin subsets
  (DEC-18). Base size 16px. Mono is used for ticket numbers (`ticket-display` 40/48), counters, plates, codes, masked
  phones (DEC-49a) via `.pt-ticketno`, `.pt-num`, `.pt-masked`.
- Themes (DEC-19, 03 §2.10): `<html data-theme>`; driver screens default to `system` (follow the device) with the
  switch «تلقائي / فاتح / داكن» in D-14; staff screens default to `light`, same switch in the ☰ menu. Stored per area
  in localStorage (`point.theme.driver`, `point.theme.staff`). `theme-color` follows a forced theme.

## API client (07 §1)

- `apiFetch(method, path, { body, query, idempotencyKey, signal, timeoutMs })` and `api.get/post/put/patch/delete`:
  same origin, `credentials: 'include'` (session cookie `__Host-point_sid` is httpOnly — no token in JS),
  `X-Requested-With: point-web` on every unsafe method including login, 10 s timeout (02 §1.8),
  `{data, meta}` → `ApiResult`, error envelope → `ApiError { code, message_ar, status, details, retryable,
  requestId, retryAfterS }`, no reply → `NetworkError('offline'|'timeout'|'network')`. `meta.server_time` feeds
  `serverClock` (countdowns use server time, 02 §1.7). `onApiError` / `onApiSuccess` are global hooks.
- Commands: `CommandSession` (`src/api/command.ts`) and the `useCommand(send)` hook: one UUIDv4 `Idempotency-Key`
  per user intent; automatic retries with the same key and body (network: 1 s/3 s/7 s; `IDEMPOTENCY_IN_PROGRESS`:
  Retry-After or 2 s; `INTERNAL_ERROR`: once); a manual retry after an unknown outcome keeps the key; a new key when the
  inputs change or after a definitive answer; a second press while pending sends nothing. `useSubmitGuard` is the
  double-submit guard for non-idempotent submits (sign-in).
- Error text: the server's `message_ar` is shown; `src/i18n/errors.ts` (08) is the fallback. Session-level codes are
  handled once in `RootLayout`: `AUTH_UNAUTHENTICATED/EXPIRED/REVOKED` → D-15 (driver) or S-01 (staff),
  `AUTH_SECRET_CHANGE_REQUIRED` → D-02 / S-01 step 3, `AUTH_MFA_SETUP_REQUIRED` → S-01 step 4.

## Routes (02 §9.1)

| Route | Screen | Notes |
|---|---|---|
| `/login` | D-01 | phone + PIN; staff accounts are routed to their shell, MFA hands over to S-01 |
| `/account/secret` | D-02 | forced on first sign-in (no back), from D-14 later; then `/d/start` (first sign-in) or `/d/account` |
| `/staff/login` | S-01 | steps: credentials → TOTP code → password change → MFA setup (QR generated locally) |
| `/session-ended` | D-15 (c) | reason text: transfer / disabled / admin / expired |
| `/d/start` | D-03 | shell + «بدء الوردية» (`POST /v1/me/duty/start` with Idempotency-Key); checklist in PNT-066/070 |
| `/d`, `/d/vehicles`, `/d/account` | D-04, D-12, D-14 | driver shell, three tabs |
| `/ops`, `/drivers`, `/venues`, `/reports`, `/admin` | S-02, S-05, S-08, S-11, S-13 | staff shell, four destinations (+ admin by permission) |
| `/drivers/:driverId` | S-06 | profile, assignment history, account actions by permission (PNT-023) |
| `/venues/:venueId` | S-08 venue page | «الحفلات» (اليوم · القادمة · المغلقة) / «الورديات» (`?tab=shifts`) |
| `/venues/:venueId/setup` | S-09 | six sections, `?section=` parking, keys, pools, timers, handover, inspection; edit with `venue.manage` |
| `/change-secret`, `/s` | aliases | → `/account/secret`, → `/ops` |

Buttons are shown only for the permissions in `GET /v1/me` `permissions` (`src/app/permissions.ts`); the server checks
every call anyway.

The driver sign-in and shell are in the main chunk; D-02, S-01 and the staff area are lazy chunks.

## Components ↔ design system

Every component reads tokens only and matches `docs/design/system/components/<Name>/preview.html` and
`docs/design/system/screenshots/<Name>.png` in both themes. Behaviour and props follow 03 §3 and the API contract
(e.g. `OfferCard` computes «ينتظر منذ» and the ring from `requested_at`/`expires_at` and server time, not from
preview strings). `components/bundle.js` is never imported.

| Design system | Code (`src/components/`) | Notes |
|---|---|---|
| Button, IconButton | `Button.tsx`, `IconButton.tsx` | variants primary/secondary/ghost/danger/success/reserve; md 48 / lg 56; loading «جارٍ…» (auto while `onClick` promise pending), done, error |
| AppShell | `AppShell.tsx` (`AppShell`, `StaffShell`) | 480px mobile shell; staff shell: BottomNav <1024px, SideNav ≥1024px |
| TopBar, BottomNav, SideNav | `TopBar.tsx`, `BottomNav.tsx`, `SideNav.tsx` | nav items are router links (`aria-current`) |
| StatusChip, DriverStateChip, ConnectionIndicator | same names | icon per status (`statusMaps.ts`, DEC-49b); texts from 02 §8.1 |
| Card, ListItem | same names | ListItem chevron mirrored to point to the inline end (see notes) |
| TaskCard, OfferCard, CountdownRing, Stepper | same names | |
| PlateInput, LetterPad, PlateBadge | same names | 17 letters with Latin pairs |
| PhoneInput, MaskedPhone | same names | `+966` prefix, LTR, `05•••••123` |
| TextField, TextArea, Select, Checkbox, Radio, Toggle, SearchField, FilterChips, SegmentedControl, ColorChips | same names | TextField `revealable` adds «إظهار» |
| CodeInput | `CodeInput.tsx` | 6 cells, paste, never pre-filled, no auto-submit |
| PhotoTile, PhotoGrid | `PhotoTile.tsx` | camera capture input |
| SpotGrid, QrPanel | same names | QrPanel is the customer-brand surface (always light) |
| Banner, Toast, Dialog, Sheet, EmptyState, Skeleton | same names | Dialog/Sheet on Radix Dialog (focus trap, Esc, RTL) |
| KpiTile, KpiStrip, QueueItem, TaskRow, DriverRow, AlertItem, Timeline, DataTable | `Kpi.tsx`, `SupervisorRows.tsx`, `Timeline.tsx`, `DataTable.tsx` | |
| Logo | `Logo.tsx` | imports the SVG files from `brand/logo/` as assets (never redrawn) |
| Icon | `Icon.tsx` | lucide-react, stroke 2, `directional` mirrors under RTL |
| — | `Header.tsx`, `Field.tsx`, `TicketNumber.tsx` | 02 §9.2 Header; shared field frame; Mono ticket number |

## Tests

- Unit (`test/`): formatting, phone/PIN rules, API client contract, command keys/retries, sign-in error mapping, the
  whole 02 §8 dictionary parsed from the spec, 08 coverage of every canon error code, WCAG contrast of every token pair
  in use in both themes (`styles/contrastPairs.ts`), brand assets identical to `brand/`.
- E2E (`e2e/`, Chromium, 360/390/430): no horizontal scroll, RTL, 16px base, ≥44px targets on every shell and
  sign-in page in both themes; each sign-in error code shows its 08 text; secrets never in browser storage; D-02 → D-03;
  S-01 MFA and first-time setup; session end; theme; the customer brand absent from staff pages; the command contract on
  «بدء الوردية»; gallery screenshots of every component attached to the report.

# S3 — customer flows end to end (PNT-043, PNT-044, PNT-045, PNT-047, PNT-049, PNT-050, PNT-051 / G2, PNT-078)

Worker branch `worktree-agent-ae3621719e5e13c39` (not pushed), on top of the S2 backend and the WhatsApp adapter.
`docs/DECISIONS.md` and `docs/progress/state.json` are untouched; the proposals below are numbered `DEC-PROPOSED-18…`
(continuing `notes/s3-whatsapp.md`) for the lead to number.

A customer now asks for his car and receives it through WhatsApp only (gate G2): the direct link sends W-01 at
submit, the «طلب السيارة» button opens the retrieval (or the early request), the dispatch pass offers it, `ready`
issues the handover code that only W-05 carries, the driver delivers with it, W-06 closes the conversation. The QR
link, the phone change, the opt-out resumed by the button, one number for two venues and the supervisor's
exceptional handover complete the scope.

## Structure

| Place | Content |
|---|---|
| `modules/whatsapp/application/link-service.ts` | LinkService (04 §4.2 `LinkService.issueQr / confirm`, `ConsentService`): `startDirectLink` (W-01 template check, live QR code revoked `linked_direct`, `link_version + 1` when a W-01 was already planned for the version, `pending_send`), `issueQrLinkCode` (one live code per ticket, previous one `regenerated`, `job.link_code_expire`), `receiveLinkCode` (the adapter's LinkCodeHandler, now its default), `confirmQrLink`, `resumeConsentByButton`, `linkCodeExpireHandler`, the early checks `assertTemplateApproved` / `assertCodeMessageSendable` (W-05 session fallback, 12 §8.4) / `assertChannelAvailable`. |
| `modules/whatsapp/application/link-commands.ts`, `http/link.controller.ts` | `POST /v1/tickets/{ticketId}/whatsapp-link` and `/confirm` (L5 then L9, canon §14ب: link codes need no pool lock). Registered in `WhatsappHttpModule`. |
| `modules/whatsapp/application/ticket-link.ts` | `changeWaLinkStatus` (all 11 §8.2 methods, user actor, optional audit) + `recordWaLinkChange` (timeline + `ticket.wa_link_changed` + `ticket.updated`) for commands that write the ticket themselves. |
| `modules/tickets-custody/application/claim-codes.ts` | ClaimCodeService (04 §4.2 `issue / verify / resend / revoke`; 11 §5.1; DEC-38): `issueClaimCode`, `verifyClaimCode`, `resendClaimCode`, `revokeClaimCodes`, `claimCodeState` / `loadClaimCodeState` (TicketDetail.claim_code), `claimCodeExpireHandler` (`ticketsCustodyJobs()`). |
| `use-cases/customer-flows/button-press.ts` | RequestRetrieval for the button (04 §4.3 rule 3), registered as the adapter's ButtonPressHandler. |
| `use-cases/customer-flows/linking.ts` | The CustomerLinkingHook of SubmitIntake (`directLinkAtSubmit`) and `ChangeCustomerPhoneUseCase` (+ its pipe). |
| `use-cases/customer-flows/handover-codes.ts` | `claimCodeHookFor(secrets)` (the S2 ClaimCodeHook), `ClaimCodeHookRegistrar` (registers it with CODE_PEPPER / DATA_ENCRYPTION_KEY when the api module starts), `ResendHandoverCodeUseCase`. |
| `use-cases/customer-flows/handover-exception.ts` | `HandoverExceptionUseCase`, `HandoverExceptionPipe`, `identityMethods` / `claimedChecks`. |
| `use-cases/customer-flows/install.ts` | `installCustomerFlows()`: button press + direct link, at load (api and worker); idempotent. |
| `use-cases/http/customer-flows.{controller,module}.ts` | `CustomerFlowsHttpModule` (one line appended to `apps/api/src/features.ts`): customer-phone, handover-code/resend, handover-exception. |

## Routes and jobs

| Route / job | Permission | Ticket | Notes |
|---|---|---|---|
| `POST /v1/tickets/{ticketId}/whatsapp-link` | `wa.link` ✓ | PNT-043/044 | `{method: direct \| qr}` → `WaLinkResult {method, wa_link_status, channel_health, qr}`. Scope → driver on duty in the venue (`DUTY_REQUIRED`) → L5 → `TICKET_CLOSED` → paper (`INVALID_STATE_TRANSITION paper_channel`) → `WA_CHANNEL_UNAVAILABLE`. direct: not in `received` / `linked` / `pending_confirmation`; `PHONE_INVALID {field: customer_phone, issue: missing}`, `WA_CUSTOMER_OPTED_OUT`, `WA_CONSENT_MISSING`, `WA_TEMPLATE_NOT_APPROVED`. qr: `received`/`parking`/`parked`, from `none`/`failed`/`opted_out`/`pending_send`. |
| `POST /v1/tickets/{ticketId}/whatsapp-link/confirm` | `wa.link` ✓ | PNT-044 | `{link_code_id, matches}` → TicketDetail. `RESOURCE_NOT_FOUND {resource: link_code}`, `PERMISSION_DENIED not_link_code_creator` (a driver other than the code's creator), `WA_LINK_CODE_EXPIRED {expired_at}`, `INVALID_STATE_TRANSITION` (code not `pending_confirmation`). |
| `PATCH /v1/tickets/{ticketId}/customer-phone` | `ticket.change_phone` ✓ | PNT-049 | `{expected_version, customer_phone, consent, reason}` → TicketDetail. `REASON_REQUIRED` → `CONSENT_REQUIRED` → `PHONE_INVALID` (pipe) → scope → duty → creator/assignee (`PERMISSION_DENIED not_creator_or_assignee`) → `TICKET_CLOSED` → `VERSION_CONFLICT` → `INVALID_STATE_TRANSITION` (`draft_use_intake`, `paper_channel`) → `VALIDATION_FAILED customer_phone unchanged` → `WA_CUSTOMER_OPTED_OUT`. |
| `POST /v1/tickets/{ticketId}/handover-code/resend` | `handover.resend_code` ✓ | PNT-047 | No body → `ClaimCodeState`. `HANDOVER_NOT_READY`, `NOT_TASK_ASSIGNEE`, `WA_CUSTOMER_OPTED_OUT`, `WA_NOT_LINKED {wa_link_status}`, `WA_CHANNEL_UNAVAILABLE`, `WA_TEMPLATE_NOT_APPROVED` (W-05 not approved and the 24 h window closed), `HANDOVER_CODE_LOCKED` (the assignee on a locked code), `RESEND_LIMIT_REACHED {max_resends}` (429). |
| `POST /v1/tickets/{ticketId}/handover-exception` | `handover.exception` ✓ | PNT-078 | `{reason, identity_checks, payment?, expected_version?}` → `{ticket, cycle, payment}`. `REASON_REQUIRED`, `VALIDATION_FAILED` (`identity_checks insufficient_checks`, `identity_checks.phone_last4 mismatch / no_customer_phone`), `TICKET_NOT_FOUND`, `TICKET_CLOSED`, `HANDOVER_NOT_READY`, `VERSION_CONFLICT`, `PAYMENT_PENDING`. |
| `POST /v1/tickets/{ticketId}/handover` (S2) | — | PNT-047 | `method: code` now verifies: `HANDOVER_CODE_INVALID {attempts_left}` (kept), `HANDOVER_CODE_LOCKED {locked_at, alert_id}` (kept on the locking attempt), `HANDOVER_CODE_EXPIRED {expired_at}`, `HANDOVER_CODE_CONSUMED`; no code for the cycle → `VALIDATION_FAILED verification.method not_applicable` (S2 behaviour kept). |
| `job.claim_code_expire` | tickets-custody (`ticketsCustodyJobs()`) | PNT-047 | At `expires_at` (dedupe `claim_code_expire:<id>`): `revoked_at`, `expired_cleanup`, copy purged; stale → no-op; early → reschedules. |
| `job.link_code_expire` | whatsapp (`whatsappJobs()`) | PNT-044 | At `expires_at` (dedupe `link_code_expire:<id>`): `expired`; a pending confirmation → `wa_link_status = none`; else `ticket.updated` for D-07. |

## Behaviour

**Direct link (PNT-043).** SubmitIntake keeps its checks (`INTAKE_INCOMPLETE`, `CONSENT_REQUIRED`,
`WA_CUSTOMER_OPTED_OUT`, photos); the hook then refuses an unapproved W-01 (`WA_TEMPLATE_NOT_APPROVED
{template_name, template_status}`, the whole submit rolls back) and moves the ticket to `pending_send` with
`ticket.wa_link_changed {method: direct}`. The planner creates one W-01 (`wa:W-01:{ticket}:lv{n}`) from that event
and from `ticket.intake_submitted`; the adapter's defaults stay the PNT-043 implementations: the sender issues the
128-bit action token in its reservation transaction (only `sha256` stored — the tests scan every table for the raw
token) and `applyW01Outcome` moves `pending_send → linked` on acceptance and `→ failed` on a permanent error
(`wa_send_failed`, `ticket.updated` so D-07 offers QR or paper). A channel `down` at submit is not refused: the W-01
waits (12 §7.3). The D-07 retry (`whatsapp-link direct`) moves `link_version` on when a W-01 exists for the current
version, so the new W-01 has its own key and an earlier button answers W-09 «غير نشطة».

**QR (PNT-044).** The code is drawn from the unambiguous alphabet (`uq_link_codes_live_code` retried), valid
`link.qr_ttl_min`; the panel is `wa.me/{display}?text=ربط تذكرة مصاف CODE` (`qr_text` = the link; the display number is
`whatsapp_channel.phone_display`, else `WA_DISPLAY_PHONE_E164`). Issuing changes nothing on the ticket. The
customer's message (inbound transaction: customer row, then L5 → L9) moves the code to `pending_confirmation` with
the sender's ids and the ticket to `pending_confirmation` (`ticket.updated`, `wa_link_pending` in TicketDetail),
W-11 «received»; a used/expired/unknown code or a second sender gets W-11 «invalid». Confirm `true`: the sender's
customer (upserted by the inbound processor) becomes `tickets.customer_id` with a `customer_initiated` consent whose
`evidence_message_id` is his message, an opt-out is lifted, `linked` (link_version + 1 when a W-01 was planned
before or the customer changes) and W-01 follows; `false`: code `driver_rejected_match`, link `none`, nothing
sent.

**Button (PNT-045).** `handleButtonPress`: token by hash → owner must be the sender (wa_id, BSUID or phone;
mismatch → W-10, audit `wa.button_sender_mismatch`, `point_wa_button_sender_mismatch_total`) → L1 → L5 →
revoked/expired/stale link_version/quoted W-01 of another ticket/voided → W-09 «inactive» → token touched →
delivered → W-09 with the state → opt-out resumed (`button_resume`) → `parked` without cycle: `openRetrievalCycle`
(`whatsapp`, requested_at = press time, `requested_by_customer_id`) + `runDispatchPass('request_created')` → W-02;
`received`/`parking`/`reparking` without pending: `pending_retrieval_at` + `ticket.retrieval_requested_early`
(with `parking_task_assignee_id`) → W-02 once, converted by S2's complete-parking at `parked` with the press time;
otherwise W-09 (throttled 20 s). AC-01: duplicates die on `uq_whatsapp_messages_wamid` before the handler;
distinct taps serialize on L1/L5.

**Handover codes (PNT-047).** `ready` (linked WhatsApp ticket) → `issueClaimCode`: 6 digits (`randomDigits`),
`HMAC-SHA256(CODE_PEPPER, cycle_id:code)`, AES-GCM copy, `expires_at = ready + handover.code_ttl_min`,
`max_attempts = handover.max_attempts`, the expiry timer, `handover.code_issued` → W-05; `ticket.ready` carries
`claim_code_id` and `code_expires_at` (DEC-131). The sender decrypts once and purges the copy after acceptance
(phase 1). Verification compares the HMAC in constant time; a wrong code commits its attempt with the error
(saved with the Idempotency-Key, a replay costs nothing), the 5th locks the code, raises `handover_code_locked`
and emits `handover.code_locked`; the right code is consumed. Resend: the live code `resend`, a new one with
`resend_no + 1` and fresh attempts → W-05 again; a locked code is reissued by a supervisor only, which resolves
the lock alert. TicketDetail shows `claim_code` (ClaimCodeState: attempts, expiry, resends, `sent_status`) — never
the code: the tests scan the API answers (ready card, ticket for driver and supervisor, home) and every table of
the database for it (AC-09, TC-027).

**Phone change (PNT-049).** One L5 transaction: the new customer (insert or read, no row lock), the ticket's
consents revoked and a new verbal one, every action token revoked, live link codes revoked, `link_version + 1`,
`pending_send`, `ticket.customer_phone_changed {changed_by, reason, link_version}` + `ticket.wa_link_changed
{method: phone_change}` → W-01 to the new number (`lv{n+1}`); the old number's pending messages are skipped
(`stale`: the ticket's customer changed) and its button answers W-09 «inactive». Audit `ticket.change_phone` with
the reason, masked numbers and link versions (09 §11).

**One number, two venues (PNT-050).** Routing is `payload → token_hash → ticket → venue/pool` only; the tests show
both W-01 naming their venue, everything from `SIM-PHONE`, and the LYL press creating a POOL-L task offered to LYL
drivers only.

**Exceptional handover (PNT-078).** L1 → L4 → L5 → L6 like TT-18; identity checks (pipe: ≥ 2 claimed; after the
locks: `phone_last4` against the stored number), TT-18's payment gate (InlinePaymentHook with `collected_by`),
the cycle's live code (locked too) revoked `exception_handover`, a resolved `manual_verification` incident
(`lost_ticket` for paper) with `incident.opened`/`incident.resolved`, task completed, cycle `supervisor_exception`,
ticket delivered by the assignee, custody → customer, `handover.exception_approved` + `handover.completed
{approved_by}` + `ticket.delivered` (W-06), `handover_code_locked`/`ready_not_collected` resolved, driver settled,
pass, audit `handover.exception` with the methods, the document note and `self_approved`.

## Seams (filled, added, for parallel work)

| Seam | Where | Now |
|---|---|---|
| `CustomerLinkingHook.onIntakeSubmitted` | `use-cases/hooks.ts` | `directLinkAtSubmit` (installed at load). |
| `ClaimCodeHook.issueAtReady` / `verifyAtHandover` | `use-cases/hooks.ts` | `claimCodeHookFor(secrets)`, registered by `ClaimCodeHookRegistrar` (api module). **Changed:** `issueAtReady` returns `{claim_code_id, expires_at}` (movement fills `ticket.ready.code_expires_at`). |
| ButtonPressHandler | whatsapp `seams.ts` | `handleButtonPress` (use-cases, installed at load). |
| LinkCodeHandler | whatsapp `seams.ts` | default is now `receiveLinkCode` (no dispatch involved). |
| ActionTokenIssuer / W01OutcomeHandler | whatsapp `seams.ts` | defaults kept: they are the PNT-043 behaviour. |
| `revokeClaimCodes(tx, cycleId, 'reparked' \| 'canceled' \| 'exception_handover')` | tickets-custody export | **for S4/S6**: repark (TT-20), cancel after the movement (TT-20b), manual reconcile must revoke the cycle's live code with it (11 §5.1 rule 5). |
| `recordWaLinkChange` / `changeWaLinkStatus` | whatsapp export | any command that changes `wa_link_status`. |
| `installCustomerFlows()` | use-cases export | re-installs the load-time flows; `apps/api/test/wa-harness.ts` calls it after `resetWhatsappSeams()`. |
| incident writer | `handover-exception.ts` (SQL insert) | to be replaced by the S6 incidents module's writer when it lands (same row, same events). |

## Changes outside the new files (all small, in place)

- `use-cases/hooks.ts` (ClaimCodeHook return type), `use-cases/movement.ts` (`code_expires_at`),
  `tickets-custody/application/views.ts` (`claim_code` filled), `tickets-custody/jobs/index.ts`, the module index
  files and `apps/api/src/features.ts` / `use-cases/index.ts` (appended lines).
- `apps/api/test/tickets-intake.int.test.ts` (DEC-40 test): approves the templates before its direct submit and
  expects the `direct` link event before `channel_paper` — PNT-043 behaviour.
- `apps/api/test/wa-harness.ts`: `installCustomerFlows()` after the seam reset.
- `tools/wa-simulator/src/graph-api.ts` (small fix, needed by TC-WA-23): a send answer no longer reveals the wa_id of
  a BSUID-only user (…2222), as its webhooks already did; otherwise the sender learned the phone and stopped using
  `recipient`.

## Proposed decisions (for `docs/DECISIONS.md`)

| # | Decision | Source | Affects |
|---|---|---|---|
| DEC-PROPOSED-18 | `whatsapp-link {method: direct}` is the D-07 retry: refused in `received` (the submit links directly, reason `submit_intake_links_directly`), for a `linked` ticket (`already_linked`), while a QR message waits (`qr_pending_confirmation`) and for paper (`paper_channel`), all `INVALID_STATE_TRANSITION`; from `none`/`failed`/`pending_send` it moves `link_version` on when a W-01 already exists for the current version (new key, earlier buttons stale). | 07 whatsapp-link, 11 §6.2 | 07 |
| DEC-PROPOSED-19 | `PHONE_INVALID {field: customer_phone, issue: missing}` for a direct link without a phone on the ticket (07 lists the code without its case). | 07 x-error-codes | 08 PHONE_INVALID |
| DEC-PROPOSED-20 | `WA_TEMPLATE_NOT_APPROVED` refuses the whole submit (direct link, W-01 not approved); a `down` channel at submit is not refused (12 §7.3). `WA_CHANNEL_UNAVAILABLE` for both link methods and the resend when the channel is missing or `down`, and for QR when no display number is configured (`reason: display_phone_not_configured`; `whatsapp_channel.phone_display`, else `WA_DISPLAY_PHONE_E164`). | 08 §4.13, 09 §4.2 | 08 |
| DEC-PROPOSED-21 | QR may start from `none`, `failed`, `opted_out` or `pending_send` (adds `pending_send → pending_confirmation` and `opted_out → pending_confirmation` to 11 §6.2); `linked` and `pending_confirmation` refuse a new code. Issuing changes neither the ticket nor its version and emits no domain event (the route's `ticket.wa_link_changed` is the direct case); the customer's message bumps the version (pending_confirmation), so a QR-mode submit after it needs the refreshed version. | 11 §6.2, 07 | 11 §6.2 |
| DEC-PROPOSED-22 | A link-code message for a ticket linked meanwhile revokes the code (`linked_direct`) and answers W-11 «invalid»; an active code past `expires_at` is invalid before its timer marks it. | 12 §7.2 | 12 §7.2 |
| DEC-PROPOSED-23 | Confirm: a `link_code_id` that is not the ticket's → `RESOURCE_NOT_FOUND {resource: link_code}`; a code not `pending_confirmation` → `INVALID_STATE_TRANSITION` (07) — 08 §4.13 names `WA_NOT_LINKED` for that case and should follow 07; expired → `WA_LINK_CODE_EXPIRED {expired_at}`; a driver other than the code's creator → `PERMISSION_DENIED not_link_code_creator`; supervisors of the venue may confirm; no duty check. | 07, 08 §4.13, 09 §4.2 | 08 WA_NOT_LINKED |
| DEC-PROPOSED-24 | A QR confirmation from a sender other than the ticket's current customer moves the ticket to him: the previous customer's consents for the ticket are revoked (`staff`) and every action token revoked, and `link_version + 1` whenever the customer changes (12 §7.2 states it only when a W-01 already existed). The `customer_initiated` consent records the confirming user in `captured_by`. | 12 §7.2, 11 §5.3 | 12 §7.2 |
| DEC-PROPOSED-25 | Rejecting the match, or the expiry of a pending code, sends the link to `none` (11 §5.2 literal) even if it was `failed`/`opted_out` before; the expiry uses `method: qr` (11 §8.2 has no expiry method). | 11 §5.2, §8.2 | 11 §8.2 |
| DEC-PROPOSED-26 | A phone change revokes live link codes with `revoke_reason = linked_direct` (the schema has no `phone_change` value). | 12 §7.4, 06 | 06 link_codes |
| DEC-PROPOSED-27 | Button: the quoted-W-01 check rejects only on positive evidence (the quoted wamid is a W-01 of another ticket; an unknown context — crash window 12 §5.13 — does not reject) with `reject_reason = revoked` + audit `wa.button_context_mismatch`; a voided ticket answers `revoked` (void revokes tokens); a sender mismatch reports `ticket_id = null` in `wa.button_pressed` (the audit row keeps `action_token_id` and `ticket_id`). | 12 §6.5, 11 §8.10 | 11 §8.10 |
| DEC-PROPOSED-28 | `requested_at` of a press = min(message timestamp, now); every press locks the ticket's pool (L1) before the ticket, since the outcome read under L5 may open a cycle. TT-06(a)'s «event open or closing» guard is implied by an open ticket and not re-read. | 12 §6.5, canon §14ب, 11 TT-06 | 10 |
| DEC-PROPOSED-29 | The early request emits `ticket.retrieval_requested_early` (11 §8.2 + `parking_task_assignee_id` of the open park/repark task); the parking driver's banner and sound come from the realtime/push planners (S5). | 11 TT-07 | — |
| DEC-PROPOSED-30 | The press after an opt-out records a `customer_initiated` consent for the pressed ticket (evidence = the button message) and clears `wa_opted_out_at`; only that ticket returns to `linked` (`button_resume`), the customer's other open tickets stay `opted_out` until relinked. W-11 to an opted-out customer's QR message is skipped (`opted_out`, W-12 is the only exception); the confirmation resumes the consent and W-01 follows. | 12 §7.6, 11 §6.2 | 12 §7.6 |
| DEC-PROPOSED-31 | Code verification: consumed → `HANDOVER_CODE_CONSUMED`; locked (also after its expiry cleanup) → `HANDOVER_CODE_LOCKED {locked_at, alert_id}`; expired or cleaned → `HANDOVER_CODE_EXPIRED {expired_at}`; no code for the cycle → `VALIDATION_FAILED verification.method not_applicable`. `max_attempts` is the code row's (captured at issue). `handover.code_attempt_failed` / `handover.code_locked` carry `cycle_id` and `method` like S2's paper events. | 11 §5.1, 08 | 11 §8.6 |
| DEC-PROPOSED-32 | Resend: the assignee (`NOT_TASK_ASSIGNEE` for another driver, after `HANDOVER_NOT_READY` for a ticket without its retrieve task) or a supervisor; `WA_CUSTOMER_OPTED_OUT` before `WA_NOT_LINKED`; an unapproved W-05 is refused only with the 24 h window closed (12 §8.4); a cycle without a code gets its first one (`resend_no = 0`); a locked code stays locked for the assignee after its cleanup; `job.claim_code_expire` revokes locked codes too (`locked_at` kept). `RESEND_LIMIT_REACHED {max_resends}`. | 11 §5.1 rule 4, 12 §8.4 | 07 resend |
| DEC-PROPOSED-33 | `ClaimCodeState` is exactly 07's fields; `sent_status` = the W-05 message's status, else its notification's (`failed`/`skipped`/`queued`); `TicketDetail.claim_code` = the latest code of the active cycle, null without one. | 07 | 07 |
| DEC-PROPOSED-34 | Exception identity rule: at least two of `phone_last4` (counts only when it matches the stored number; a mismatch or a ticket without phone is `VALIDATION_FAILED`), `plate_confirmed`, `vehicle_description_confirmed`, a non-blank `document_note`; the plate counts once and never alone (07; 02 S-03 lists phone / document / contents). Claimed checks are counted in the pipe (before locks), the phone after the locks. | 07, 02 S-03, 00 §4ز | 07 handover-exception |
| DEC-PROPOSED-35 | The exception always creates its incident (`manual_verification`, `lost_ticket` for paper) `resolved`, description = reason, resolution `handover_exception: <methods>`, with `incident.opened` + `incident.resolved` on the ticket timeline; an open `manual_verification` incident the driver opened from D-11 is left to S6. Custody moves from the current holders (driver or supervisor) to the customer; `TICKET_CLOSED` for a terminal ticket (08 HANDOVER_NOT_READY row) although 07 does not list it. | 11 TT-19, 07 ("optional") | 07 |
| DEC-PROPOSED-36 | Phone change: refused in `received` (PATCH /intake edits the draft) and for paper (`INVALID_STATE_TRANSITION draft_use_intake / paper_channel`); the same number → `VALIDATION_FAILED customer_phone unchanged`; a driver must be on duty in the venue; supervisors and admins have no creator rule; no W-01 template check (07 has no such code: the failure shows on D-07). | 07, 09 §4.2 | 07 customer-phone |
| DEC-PROPOSED-37 | The simulator's send answer omits `contacts[].wa_id` for BSUID-only numbers (…2222), like its webhooks (DEC-35, TC-WA-23). | 12 §11.3 | tools/wa-simulator |

## Tests

- `apps/api/test/customer-harness.ts`: the WhatsApp harness + dispatch and tickets-custody jobs, synced templates,
  `freshDriver` (an intake keeps its driver busy until parked), `whatsappTicket`, `park`, `press`, `settle` (sends,
  delivers what was accepted, moves the clock only to the next deferred `job.wa_send`), `tablesContaining` (every
  table scanned for a value: raw action tokens, handover codes).
- `wa-linking.int.test.ts` (10): direct W-01 with the single button and only the token hash stored; template not
  approved at submit; …0000 failure → failed + `wa_send_failed` + the direct retry with `lv2`; every whatsapp-link
  error code; QR panel, timer, scanning alone changes nothing, `pending_confirmation` + W-11 + `wa_link_pending`,
  qr_race, confirm with `customer_initiated` evidence + W-01; reject; regenerated; `uq_link_codes_live_ticket`;
  expiry (410, job, late message invalid); confirm errors; QR after a failed direct link with a BSUID-only sender
  (W-01 to `recipient`); the opted-out customer back through his QR message.
- `wa-button.int.test.ts` (11): TC-001 dup10, TC-002 taps10 (one W-09), TC-004 forwarded (W-10, audit, no
  version change), TC-006/007 two tickets + free text, TC-011/012 early request and conversion, inactive buttons
  (revoked, expired after 72 h) and delivered, TC-WA-18 opt-out then tap, TC-079 late W-01 after the paper
  conversion, PNT-049 TC-005/TC-WA-19 and every error code, PNT-050 TC-058.
- `handover-codes.int.test.ts` (8): issue + purge + timer + `ticket.ready` + no leak (answers and all tables), TC-028
  once only (replay 200, new key `TICKET_CLOSED`, W-02/W-04 superseded when sent late), TC-029 attempts 4…1 + lock +
  alert + LOCKED even with the right code + supervisor reissue, TC-030 expiry + cleanup + 3 resends + limit,
  resend errors + `HANDOVER_CODE_CONSUMED`, TC-031 exception (permission, plate alone, reason, last-4 mismatch,
  success with incident/events/audit/W-06), exception after a lock + errors, paper lost stub (`lost_ticket`,
  `PAYMENT_PENDING` on EVT-R2).
- `g2-customer-gate.int.test.ts` (3, gate G2): the full conversation W-01 → W-02 → W-04 → W-05 → W-06 with the code
  from the simulator, AC-18 (the only button), AC-19 (actors, custody chain), AC-09 (no leak); QR + opt-out +
  resumed button + second venue; the route check (no public route but login, MFA, health and the webhook).
- Unit `packages/server/test/customer-flows.test.ts` (5): identity rule, claim code HMAC, module boundaries
  (whatsapp never imports dispatch or the use-cases; tickets-custody never imports whatsapp).

## Gaps and follow-ups

- PNT-051 acceptance 2 (manual run on the Meta test number) needs the Q-03 assets; not possible here.
- `job.ready_uncollected_check` (S4, PNT-058) is still not scheduled at `ready`.
- Realtime of the new routes beyond `ticket.updated` for link changes (resend's `ticket.updated`, the exception's
  `task.updated` / `driver.state_changed`, the early request's banner) is left to the realtime planners (S5).
- Rate limits (`RATE_LIMITED` on resend, 08 TC-074) are not enforced by the platform yet.
- The inbound processor locks the customer row (upsert) before L5; S2's PATCH /intake upserts customers with
  `ON CONFLICT … DO UPDATE` (a row lock) after L5 — a rare deadlock between an opt-out and a draft edit of the same
  customer is possible (retried by PostgreSQL's detector); the phone change avoids it (`DO NOTHING` + read).

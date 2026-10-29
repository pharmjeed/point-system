# staff-gaps — supervisor and admin gaps GAP-2 … GAP-6 and the S-01 … S-13 sweep (wave 5)

Branch `wave5/staff-gaps` from `34ffe37`. Web only (`apps/web`): the server routes of these gaps were built and tested
before (PNT-017, PNT-049, PNT-084, PNT-085, PNT-087; `docs/runbooks/go-live-checklist.md` §2). The lead numbers the
proposals below from DEC-365; `docs/DECISIONS.md`, `STATUS.md`, `state.json` and `tickets.json` are not edited here.

## Gaps closed

| Gap | Screen (02) | What was built | Proof |
|---|---|---|---|
| GAP-2 | S-03 «مطابقة يدوية بعد انقطاع» · «تغيير الجوال» · «إعادة الربط بواتساب» | `TicketRecoveryActions.tsx`: the three sheets, `permissions.ts` (`relinkMethods`, `reconcileTargets`, the rows of the 02 S-03 table), `staffApi.ts` commands | `test/staff/permissions.test.ts` (recovery actions), `e2e/staff-recovery.spec.ts` (9) |
| GAP-3 | S-13 «الموظفون» | `/admin/staff` (`StaffSection.tsx`, `staffModel.ts`): the list (`GET /v1/staff`, every page), «إضافة موظف» with the temporary password once, «تعديل البيانات», «النطاقات» (venues of a supervisor, the org scope of an admin), «تعطيل الحساب» / «تفعيل الحساب» with a reason and CUSTODY_OPEN items, «إعادة ضبط التحقق الثنائي» (owner) | `test/staff/staffModel.test.ts` (6), `test/staff/permissions.test.ts` (sections), `e2e/staff-team.spec.ts` (5) |

## Proposed decisions (DEC-PROPOSED-n, numbered by the lead from DEC-365)

## API gaps (what the screens need and the server does not give)

## Copy not in 02 §8 (for 02 §8.6)

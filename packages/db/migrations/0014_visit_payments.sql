-- V2-022 / V2-023 (docs/v2/04 §2, §3; docs/v2/02 O-03; DEC-521 … DEC-525): paying a visit in the app, the extended
-- handover gate and saved cards. Append-only like every migration (DEC-129); 0013 is reserved for a parallel V2
-- stream. CHECKs are flat comparisons joined by OR (no BETWEEN, no nested AND groups) so that pg_dump writes them
-- back unchanged (restore drill). No V1 constraint is dropped or weakened.

-- ---------------------------------------------------------------------
-- 1. Refunds the platform issues by itself (DEC-523): an online visit payment that succeeds at the gateway for a
--    ticket that no longer owes it (a cash/POS payment was recorded first, another online payment won, the fee was
--    waived …) is refunded at once through the refund path of DEC-513, with no platform user behind it.
-- ---------------------------------------------------------------------
ALTER TABLE refunds ADD COLUMN kind text NOT NULL DEFAULT 'manual';
ALTER TABLE refunds ALTER COLUMN issued_by DROP NOT NULL;
ALTER TABLE refunds ADD CONSTRAINT ck_refunds_kind CHECK (kind IN ('manual','system'));
-- a manual refund names its platform user (P-06 / P-08); a system refund never does
ALTER TABLE refunds ADD CONSTRAINT ck_refunds_issued_by CHECK (kind <> 'manual' OR issued_by IS NOT NULL);
ALTER TABLE refunds ADD CONSTRAINT ck_refunds_system_actor CHECK (kind = 'manual' OR issued_by IS NULL);
-- one automatic refund per online payment (the whole amount): uq_refunds_system, built concurrently in
-- 0014_visit_payments_system_refund_index.sql (06 ERD §9.2 rule 5)

-- the kind joins the immutable fields of a refund (trg_refunds_guard, 0012)
CREATE OR REPLACE FUNCTION refunds_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.online_payment_id IS DISTINCT FROM OLD.online_payment_id OR NEW.amount_halalas IS DISTINCT FROM OLD.amount_halalas
     OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.issued_by IS DISTINCT FROM OLD.issued_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'refunds are append-only: only the gateway outcome may change' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'ck_refunds_immutable';
  END IF;
  IF OLD.status <> 'requested' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a completed refund is final' USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_refunds_final';
  END IF;
  RETURN NEW;
END $$;

-- the platform finance alert of such a refund (warning: the money goes back by itself; finance follows it up)
ALTER TABLE platform_alerts DROP CONSTRAINT ck_platform_alerts_type;
ALTER TABLE platform_alerts ADD CONSTRAINT ck_platform_alerts_type
  CHECK (type IN ('payment_unknown','payment_mismatch','payment_refund_failed','payment_reconcile_failed','payment_double'));

-- ---------------------------------------------------------------------
-- 2. One payment per ticket (DEC-522): an online visit payment that counts (paid / partially refunded) and a V1
--    cash/POS payment that counts (payments.recorded) never coexist for one ticket — unless the online one is
--    being given back by the platform (its system refund exists). Both commands check it first (pay refuses
--    PAYMENT_ALREADY_RECORDED, payment.record refuses an app-paid ticket); this is the database's last line.
--    A constraint trigger deferred to COMMIT, so the payment and its system refund may be written in either order in
--    one transaction; it takes the ticket row FOR NO KEY UPDATE (L5) first — a no-op for the commands, which hold it
--    already — so two transactions on one ticket are serialized and the check sees what the other committed.
-- ---------------------------------------------------------------------
CREATE FUNCTION ticket_single_payment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  t uuid := NEW.ticket_id;
BEGIN
  IF t IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM 1 FROM tickets WHERE id = t FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM payments p WHERE p.ticket_id = t AND p.status = 'recorded')
     AND EXISTS (SELECT 1 FROM online_payments op
                  WHERE op.ticket_id = t AND op.purpose = 'visit' AND op.status IN ('paid','partially_refunded')
                    AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.online_payment_id = op.id AND r.kind = 'system')) THEN
    RAISE EXCEPTION 'a ticket is paid once: online or cash/POS, never both' USING ERRCODE = 'unique_violation',
      CONSTRAINT = 'uq_ticket_single_payment';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER trg_online_payments_single_payment AFTER INSERT OR UPDATE OF status ON online_payments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.purpose = 'visit' AND (NEW.status = 'paid' OR NEW.status = 'partially_refunded'))
  EXECUTE FUNCTION ticket_single_payment_guard();
CREATE CONSTRAINT TRIGGER trg_payments_single_payment AFTER INSERT OR UPDATE OF status ON payments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.status = 'recorded')
  EXECUTE FUNCTION ticket_single_payment_guard();

-- the live online payments of a ticket (the pay command's «one payment in progress» check, DEC-521):
-- ix_online_payments_ticket_live in 0014_visit_payments_live_index.sql

-- ---------------------------------------------------------------------
-- 3. Saved cards (C-18, DEC-524). A card saved with a payment («حفظ البطاقة» in the pay sheet) is written with the
--    payment and stays pending (hidden from C-18, never charged) until that payment is paid; a failed payment
--    removes it. The gateway token is deleted at the gateway after a card is removed here
--    (job.payment_method_token_delete); the time it was done is kept, nothing else.
-- ---------------------------------------------------------------------
ALTER TABLE customer_payment_methods ADD COLUMN pending_payment_id uuid REFERENCES online_payments(id);
ALTER TABLE customer_payment_methods ADD COLUMN gateway_deleted_at timestamptz;
ALTER TABLE customer_payment_methods ADD CONSTRAINT ck_payment_methods_pending_default
  CHECK (pending_payment_id IS NULL OR is_default = false);
ALTER TABLE customer_payment_methods ADD CONSTRAINT ck_payment_methods_deleted_removed
  CHECK (gateway_deleted_at IS NULL OR removed_at IS NOT NULL);

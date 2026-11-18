-- V2-040 / V2-041 / V2-042 (docs/v2/03 §5, docs/v2/04 §4–§5; DEC-540 … DEC-549): POINT's tax invoices (ZATCA phase 2
-- through an e-invoicing provider not chosen yet, DEC-460: a provider abstraction and its simulator), the monthly
-- settlement statements with each operator and their lines, and the system-subscription (SaaS) invoices to the
-- operators. Append-only like every migration (DEC-129); 0016 is reserved for the subscriptions stream (V2-030 …).
-- The tables are created empty, so their indexes are built inline (06 ERD §9.2 rule 5 targets large live tables).
-- CHECKs are flat comparisons joined by OR (no BETWEEN, no nested AND groups) so that pg_dump writes them back
-- unchanged (restore drill). Money in halalas (bigint), times timestamptz UTC, days of Asia/Riyadh as `date`.

-- ---------------------------------------------------------------------
-- 1. Invoice series: one gapless chain per e-invoicing unit (DEC-541). `simplified` carries the customers'
--    simplified tax invoices (B2C, reported) and their credit notes; `standard` the operators' tax invoices (B2B,
--    cleared) and theirs. Each document takes the next counter (ICV) and the hash of the previous one (PIH); the
--    first PIH is the ZATCA base value: base64 of the hex SHA-256 of "0".
-- ---------------------------------------------------------------------
CREATE TABLE invoice_series (
  series      text PRIMARY KEY,
  prefix      text NOT NULL,
  last_icv    bigint NOT NULL DEFAULT 0,
  last_hash   text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_invoice_series_prefix UNIQUE (prefix),
  CONSTRAINT ck_invoice_series_series CHECK (series IN ('simplified','standard')),
  CONSTRAINT ck_invoice_series_prefix CHECK (prefix ~ '^[A-Z]{2,4}$'),
  CONSTRAINT ck_invoice_series_icv CHECK (last_icv >= 0),
  CONSTRAINT ck_invoice_series_hash CHECK (last_hash ~ '^[A-Za-z0-9+/]{40,120}={0,2}$')
);
INSERT INTO invoice_series (series, prefix, last_hash) VALUES
  ('simplified', 'PS', 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ=='),
  ('standard',   'PB', 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==');

-- the counter only ever moves by one (the insert trigger of invoices below moves it)
CREATE FUNCTION invoice_series_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.series IS DISTINCT FROM OLD.series OR NEW.prefix IS DISTINCT FROM OLD.prefix
     OR NEW.last_icv <> OLD.last_icv + 1 THEN
    RAISE EXCEPTION 'an invoice series only advances by one document' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'ck_invoice_series_advance';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_invoice_series_guard BEFORE UPDATE ON invoice_series FOR EACH ROW EXECUTE FUNCTION invoice_series_guard();

-- ---------------------------------------------------------------------
-- 2. Settlement statements (V2-041, docs/v2/04 §5; DEC-544 … DEC-546): one per operator and Riyadh month. Every
--    amount column is the sum of the statement's active lines by kind (trg_settlement_totals, deferred), and the net
--    is their signed sum: positive = POINT pays the operator, negative = the operator pays POINT.
-- ---------------------------------------------------------------------
CREATE TABLE settlement_statements (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                          uuid NOT NULL REFERENCES organizations(id),
  period_start                    date NOT NULL,                 -- first day of the Riyadh month
  period_end                      date NOT NULL,                 -- exclusive: first day of the next month
  status                          text NOT NULL DEFAULT 'draft',
  currency                        text NOT NULL DEFAULT 'SAR',
  subscriber_visit_count          int NOT NULL DEFAULT 0,
  subscriber_payout_halalas       bigint NOT NULL DEFAULT 0,
  app_payment_count               int NOT NULL DEFAULT 0,
  app_gross_halalas               bigint NOT NULL DEFAULT 0,
  app_commission_halalas          bigint NOT NULL DEFAULT 0,
  app_refund_halalas              bigint NOT NULL DEFAULT 0,
  app_refund_commission_halalas   bigint NOT NULL DEFAULT 0,     -- POINT's commission given back with refunds
  saas_fee_halalas                bigint NOT NULL DEFAULT 0,     -- VAT exclusive
  saas_vat_halalas                bigint NOT NULL DEFAULT 0,
  adjustments_halalas             bigint NOT NULL DEFAULT 0,     -- signed
  net_payable_halalas             bigint NOT NULL DEFAULT 0,
  computed_at                     timestamptz NOT NULL DEFAULT now(),
  computed_by                     uuid REFERENCES platform_users(id),  -- NULL: job.settlement_monthly
  issued_at                       timestamptz,
  issued_by                       uuid REFERENCES platform_users(id),
  disputed_at                     timestamptz,
  disputed_by                     uuid REFERENCES users(id),     -- the operator's owner or admin (O-05)
  dispute_reason                  text,
  dispute_resolved_at             timestamptz,
  dispute_resolved_by             uuid REFERENCES platform_users(id),
  dispute_resolution              text,
  paid_at                         timestamptz,
  paid_on                         date,
  paid_reference                  text,
  paid_recorded_by                uuid REFERENCES platform_users(id),
  voided_at                       timestamptz,
  voided_by                       uuid REFERENCES platform_users(id),
  void_reason                     text,
  saas_invoice_id                 uuid,                          -- FK below (invoices refer back to statements)
  version                         int NOT NULL DEFAULT 1,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_settlement_statements_status CHECK (status IN ('draft','issued','disputed','paid','void')),
  CONSTRAINT ck_settlement_statements_period CHECK (period_end > period_start),
  CONSTRAINT ck_settlement_statements_month_start CHECK (extract(day FROM period_start) = 1),
  CONSTRAINT ck_settlement_statements_currency CHECK (currency = 'SAR'),
  CONSTRAINT ck_settlement_statements_counts CHECK (subscriber_visit_count >= 0 AND app_payment_count >= 0),
  CONSTRAINT ck_settlement_statements_payout CHECK (subscriber_payout_halalas >= 0),
  CONSTRAINT ck_settlement_statements_gross CHECK (app_gross_halalas >= 0),
  CONSTRAINT ck_settlement_statements_commission CHECK (app_commission_halalas >= 0),
  CONSTRAINT ck_settlement_statements_refund CHECK (app_refund_halalas >= 0),
  CONSTRAINT ck_settlement_statements_refund_commission CHECK (app_refund_commission_halalas >= 0),
  CONSTRAINT ck_settlement_statements_saas CHECK (saas_fee_halalas >= 0 AND saas_vat_halalas >= 0),
  CONSTRAINT ck_settlement_net CHECK (net_payable_halalas = subscriber_payout_halalas + app_gross_halalas
    - app_commission_halalas - app_refund_halalas + app_refund_commission_halalas - saas_fee_halalas
    - saas_vat_halalas + adjustments_halalas),
  CONSTRAINT ck_settlement_statements_issued CHECK (status = 'draft' OR status = 'void' OR issued_at IS NOT NULL),
  CONSTRAINT ck_settlement_statements_disputed CHECK (status <> 'disputed' OR disputed_at IS NOT NULL),
  CONSTRAINT ck_settlement_statements_dispute_reason CHECK (disputed_at IS NULL OR dispute_reason IS NOT NULL),
  CONSTRAINT ck_settlement_statements_dispute_reason_length CHECK (char_length(dispute_reason) >= 3),
  CONSTRAINT ck_settlement_statements_paid CHECK (status <> 'paid' OR paid_at IS NOT NULL),
  CONSTRAINT ck_settlement_statements_paid_reference CHECK (paid_at IS NULL OR paid_reference IS NOT NULL),
  CONSTRAINT ck_settlement_statements_paid_reference_length CHECK (char_length(paid_reference) >= 3),
  CONSTRAINT ck_settlement_statements_void CHECK (status <> 'void' OR voided_at IS NOT NULL),
  CONSTRAINT ck_settlement_statements_void_reason CHECK (voided_at IS NULL OR void_reason IS NOT NULL),
  CONSTRAINT ck_settlement_statements_void_reason_length CHECK (char_length(void_reason) >= 3),
  CONSTRAINT ck_settlement_statements_no_pan CHECK (paid_reference !~ '[0-9]{13,}')
);
-- one live statement per operator and month; a voided one leaves the month free for its replacement
CREATE UNIQUE INDEX uq_settlement_statements_period ON settlement_statements(org_id, period_start) WHERE status <> 'void';
CREATE INDEX ix_settlement_statements_period ON settlement_statements(period_start, org_id);

-- Every ticket, payment, refund and fee share counted once (docs/v2/03 §6): a line has a unique key while it is
-- active. A draft that is recomputed releases its computed lines (released_at) and writes the new ones; a voided
-- statement releases all of its lines so its month can be settled again. Nothing is deleted.
CREATE TABLE settlement_lines (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id        uuid NOT NULL REFERENCES settlement_statements(id),
  org_id              uuid NOT NULL REFERENCES organizations(id),
  kind                text NOT NULL,
  line_key            text NOT NULL,
  amount_halalas      bigint NOT NULL,                -- signed effect on the net (positive: POINT pays the operator)
  base_halalas        bigint,                         -- what a rate applied to (payment, refund, monthly fee)
  rate_bp             int,                            -- commission basis points (DEC-545)
  quantity_days       int,                            -- days of a SaaS fee share
  occurred_on         date NOT NULL,                  -- the Riyadh day of the source row
  venue_id            uuid REFERENCES venues(id),
  ticket_id           uuid REFERENCES tickets(id),
  online_payment_id   uuid REFERENCES online_payments(id),
  refund_id           uuid REFERENCES refunds(id),
  contract_id         uuid REFERENCES operator_contracts(id),
  note                text,
  created_by          uuid REFERENCES platform_users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  released_at         timestamptz,
  CONSTRAINT ck_settlement_lines_kind CHECK (kind IN ('subscriber_visit','app_payment','app_commission','app_refund',
    'app_refund_commission','saas_fee','saas_vat','adjustment')),
  CONSTRAINT ck_settlement_lines_key CHECK (line_key ~ '^[a-z_]+:[A-Za-z0-9:_-]{1,200}$'),
  CONSTRAINT ck_settlement_lines_positive CHECK (kind NOT IN ('subscriber_visit','app_payment','app_refund_commission') OR amount_halalas >= 0),
  CONSTRAINT ck_settlement_lines_negative CHECK (kind NOT IN ('app_commission','app_refund','saas_fee','saas_vat') OR amount_halalas <= 0),
  CONSTRAINT ck_settlement_lines_adjustment CHECK (kind <> 'adjustment' OR amount_halalas <> 0),
  CONSTRAINT ck_settlement_lines_adjustment_note CHECK (kind <> 'adjustment' OR note IS NOT NULL),
  CONSTRAINT ck_settlement_lines_note_length CHECK (char_length(note) >= 3),
  CONSTRAINT ck_settlement_lines_adjustment_actor CHECK (kind <> 'adjustment' OR created_by IS NOT NULL),
  CONSTRAINT ck_settlement_lines_visit CHECK (kind <> 'subscriber_visit' OR ticket_id IS NOT NULL),
  CONSTRAINT ck_settlement_lines_payment CHECK (kind NOT IN ('app_payment','app_commission') OR online_payment_id IS NOT NULL),
  CONSTRAINT ck_settlement_lines_refund CHECK (kind NOT IN ('app_refund','app_refund_commission') OR refund_id IS NOT NULL),
  CONSTRAINT ck_settlement_lines_rate CHECK (rate_bp IS NULL OR rate_bp >= 0),
  CONSTRAINT ck_settlement_lines_rate_max CHECK (rate_bp IS NULL OR rate_bp <= 10000),
  CONSTRAINT ck_settlement_lines_days CHECK (quantity_days IS NULL OR quantity_days >= 1),
  CONSTRAINT ck_settlement_lines_no_pan CHECK (note !~ '[0-9]{13,}')
);
CREATE UNIQUE INDEX uq_settlement_lines_key ON settlement_lines(line_key) WHERE released_at IS NULL;
-- the doc's own name (docs/v2/03 §5): a subscriber visit enters one live statement only
CREATE UNIQUE INDEX uq_settlement_ticket ON settlement_lines(ticket_id) WHERE released_at IS NULL AND kind = 'subscriber_visit';
CREATE INDEX ix_settlement_lines_statement ON settlement_lines(statement_id, kind) WHERE released_at IS NULL;

-- A statement moves draft → issued → disputed → issued … → paid, or to void from any open status; paid and void are
-- final. Its amounts change only while it is a draft (recompute) or disputed (adjustments); org and month never.
CREATE FUNCTION settlement_statements_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.period_start IS DISTINCT FROM OLD.period_start
     OR NEW.period_end IS DISTINCT FROM OLD.period_end OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a statement keeps its operator and month' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'ck_settlement_statements_immutable';
  END IF;
  IF OLD.status IN ('paid','void') THEN
    RAISE EXCEPTION 'a paid or void statement is final' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'ck_settlement_statements_final';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('issued','void'))
    OR (OLD.status = 'issued' AND NEW.status IN ('disputed','paid','void'))
    OR (OLD.status = 'disputed' AND NEW.status IN ('issued','void'))) THEN
    RAISE EXCEPTION 'statement transition % -> % is not allowed', OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_settlement_statements_transition';
  END IF;
  IF OLD.status NOT IN ('draft','disputed') AND (
       NEW.net_payable_halalas IS DISTINCT FROM OLD.net_payable_halalas
    OR NEW.adjustments_halalas IS DISTINCT FROM OLD.adjustments_halalas
    OR NEW.subscriber_payout_halalas IS DISTINCT FROM OLD.subscriber_payout_halalas
    OR NEW.app_gross_halalas IS DISTINCT FROM OLD.app_gross_halalas
    OR NEW.saas_fee_halalas IS DISTINCT FROM OLD.saas_fee_halalas) THEN
    RAISE EXCEPTION 'an issued statement keeps its amounts' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'ck_settlement_statements_amounts_frozen';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_settlement_statements_guard BEFORE UPDATE ON settlement_statements
  FOR EACH ROW EXECUTE FUNCTION settlement_statements_guard();
CREATE TRIGGER trg_settlement_statements_updated_at BEFORE UPDATE ON settlement_statements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A line is written into a draft (computed or adjustment) or a disputed statement (adjustment only), for the
-- statement's own operator; afterwards only its release may happen, once, while the statement is a draft or void.
CREATE FUNCTION settlement_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  s record;
BEGIN
  SELECT status, org_id INTO s FROM settlement_statements WHERE id = NEW.statement_id;
  IF TG_OP = 'INSERT' THEN
    IF s.org_id IS DISTINCT FROM NEW.org_id THEN
      RAISE EXCEPTION 'a line belongs to its statement''s operator' USING ERRCODE = 'check_violation',
        CONSTRAINT = 'ck_settlement_lines_org';
    END IF;
    IF NOT (s.status = 'draft' OR (s.status = 'disputed' AND NEW.kind = 'adjustment')) THEN
      RAISE EXCEPTION 'lines are added to a draft (or an adjustment to a disputed statement)'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_settlement_lines_open';
    END IF;
    IF NEW.released_at IS NOT NULL THEN
      RAISE EXCEPTION 'a new line is active' USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_settlement_lines_open';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'released_at') IS DISTINCT FROM (to_jsonb(OLD) - 'released_at')
     OR OLD.released_at IS NOT NULL OR NEW.released_at IS NULL OR s.status NOT IN ('draft','void') THEN
    RAISE EXCEPTION 'settlement lines are append-only: only a release of a draft or void statement''s line'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_settlement_lines_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_settlement_lines_guard BEFORE INSERT OR UPDATE ON settlement_lines
  FOR EACH ROW EXECUTE FUNCTION settlement_lines_guard();

-- The header equals its active lines, to the halala (gate H5), checked at COMMIT once lines and header are written.
CREATE FUNCTION settlement_totals_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  sid uuid := (to_jsonb(NEW) ->> CASE WHEN TG_TABLE_NAME = 'settlement_lines' THEN 'statement_id' ELSE 'id' END)::uuid;
  h record;
  t record;
BEGIN
  SELECT * INTO h FROM settlement_statements WHERE id = sid;
  SELECT count(*) FILTER (WHERE kind = 'subscriber_visit') AS visits,
         COALESCE(sum(amount_halalas) FILTER (WHERE kind = 'subscriber_visit'), 0) AS payout,
         count(*) FILTER (WHERE kind = 'app_payment') AS payments,
         COALESCE(sum(amount_halalas) FILTER (WHERE kind = 'app_payment'), 0) AS gross,
         COALESCE(-sum(amount_halalas) FILTER (WHERE kind = 'app_commission'), 0) AS commission,
         COALESCE(-sum(amount_halalas) FILTER (WHERE kind = 'app_refund'), 0) AS refunds,
         COALESCE(sum(amount_halalas) FILTER (WHERE kind = 'app_refund_commission'), 0) AS refund_commission,
         COALESCE(-sum(amount_halalas) FILTER (WHERE kind = 'saas_fee'), 0) AS saas,
         COALESCE(-sum(amount_halalas) FILTER (WHERE kind = 'saas_vat'), 0) AS saas_vat,
         COALESCE(sum(amount_halalas) FILTER (WHERE kind = 'adjustment'), 0) AS adjustments,
         COALESCE(sum(amount_halalas), 0) AS net
    INTO t FROM settlement_lines WHERE statement_id = sid AND released_at IS NULL;
  -- a voided statement released its lines and keeps the amounts it had
  IF h.status <> 'void' AND (h.subscriber_visit_count <> t.visits OR h.subscriber_payout_halalas <> t.payout
     OR h.app_payment_count <> t.payments OR h.app_gross_halalas <> t.gross OR h.app_commission_halalas <> t.commission
     OR h.app_refund_halalas <> t.refunds OR h.app_refund_commission_halalas <> t.refund_commission
     OR h.saas_fee_halalas <> t.saas OR h.saas_vat_halalas <> t.saas_vat OR h.adjustments_halalas <> t.adjustments
     OR h.net_payable_halalas <> t.net) THEN
    RAISE EXCEPTION 'statement % does not equal the sum of its lines', sid USING ERRCODE = 'check_violation',
      CONSTRAINT = 'ck_settlement_totals';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_settlement_totals AFTER INSERT OR UPDATE ON settlement_statements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION settlement_totals_guard();
CREATE CONSTRAINT TRIGGER trg_settlement_line_totals AFTER INSERT OR UPDATE ON settlement_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION settlement_totals_guard();

-- ---------------------------------------------------------------------
-- 3. Invoices (V2-040 / V2-042; DEC-540 … DEC-543): immutable once written — a correction is a credit note
--    (type 381) referring to the original. Only what the provider answers (status, its reference, hash and stamped
--    QR) and the rendered PDF's key may be filled in later, each once (trg_invoices_guard).
-- ---------------------------------------------------------------------
CREATE TABLE invoices (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  series                   text NOT NULL REFERENCES invoice_series(series),
  kind                     text NOT NULL,
  type_code                int NOT NULL,
  number                   text NOT NULL,
  icv                      bigint NOT NULL,
  zatca_uuid               uuid NOT NULL,
  previous_hash            text NOT NULL,
  invoice_hash             text NOT NULL,
  issued_at                timestamptz NOT NULL,
  supply_date              date NOT NULL,                   -- Riyadh day of the supply (KSA-5 / BT-72)
  period_start             date,                            -- a SaaS invoice's month
  period_end               date,
  account_id               uuid REFERENCES customer_accounts(id),   -- buyer of the simplified series
  org_id                   uuid REFERENCES organizations(id),       -- buyer of the standard series (the operator)
  online_payment_id        uuid REFERENCES online_payments(id),
  refund_id                uuid REFERENCES refunds(id),
  settlement_statement_id  uuid REFERENCES settlement_statements(id),
  original_invoice_id      uuid REFERENCES invoices(id),
  credit_reason            text,
  currency                 text NOT NULL DEFAULT 'SAR',
  vat_rate_bp              int NOT NULL,
  subtotal_halalas         bigint NOT NULL,
  vat_halalas              bigint NOT NULL,
  total_halalas            bigint NOT NULL,
  seller                   jsonb NOT NULL,                  -- snapshot: legal names, VAT number, CR, address
  buyer                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  lines                    jsonb NOT NULL,
  qr_payload               text NOT NULL,                   -- base64 TLV, tags 1–5 (DEC-542)
  provider                 text NOT NULL,
  zatca_status             text NOT NULL DEFAULT 'pending',
  provider_reference       text,
  provider_hash            text,                            -- the hash of the provider's signed XML
  provider_qr              text,                            -- the provider's stamped QR (tags 1–9)
  provider_codes           jsonb NOT NULL DEFAULT '[]'::jsonb,
  submitted_at             timestamptz,
  status_at                timestamptz,
  pdf_storage_key          text,
  pdf_rendered_at          timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_invoices_number UNIQUE (number),
  CONSTRAINT uq_invoices_series_icv UNIQUE (series, icv),
  CONSTRAINT uq_invoices_zatca_uuid UNIQUE (zatca_uuid),
  CONSTRAINT ck_invoices_kind CHECK (kind IN ('customer_simplified','operator_standard','credit_note')),
  CONSTRAINT ck_invoices_type_code CHECK (type_code IN (388, 381)),
  CONSTRAINT ck_invoices_credit_type CHECK ((kind = 'credit_note') = (type_code = 381)),
  CONSTRAINT ck_invoices_simplified_series CHECK (kind <> 'customer_simplified' OR series = 'simplified'),
  CONSTRAINT ck_invoices_standard_series CHECK (kind <> 'operator_standard' OR series = 'standard'),
  CONSTRAINT ck_invoices_simplified_buyer CHECK (series <> 'simplified' OR account_id IS NOT NULL),
  CONSTRAINT ck_invoices_simplified_no_org CHECK (series <> 'simplified' OR org_id IS NULL),
  CONSTRAINT ck_invoices_standard_buyer CHECK (series <> 'standard' OR org_id IS NOT NULL),
  CONSTRAINT ck_invoices_standard_no_account CHECK (series <> 'standard' OR account_id IS NULL),
  CONSTRAINT ck_invoices_customer_payment CHECK (kind <> 'customer_simplified' OR online_payment_id IS NOT NULL),
  CONSTRAINT ck_invoices_operator_statement CHECK (kind <> 'operator_standard' OR settlement_statement_id IS NOT NULL),
  CONSTRAINT ck_invoices_credit_original CHECK (kind <> 'credit_note' OR original_invoice_id IS NOT NULL),
  CONSTRAINT ck_invoices_credit_reason CHECK (kind <> 'credit_note' OR credit_reason IS NOT NULL),
  CONSTRAINT ck_invoices_credit_reason_length CHECK (char_length(credit_reason) >= 3),
  CONSTRAINT ck_invoices_invoice_no_original CHECK (kind = 'credit_note' OR original_invoice_id IS NULL),
  CONSTRAINT ck_invoices_icv CHECK (icv >= 1),
  CONSTRAINT ck_invoices_number CHECK (number ~ '^[A-Z]{2,4}-[0-9]{8,}$'),
  CONSTRAINT ck_invoices_hash CHECK (invoice_hash ~ '^[A-Za-z0-9+/]{40,120}={0,2}$'),
  CONSTRAINT ck_invoices_currency CHECK (currency = 'SAR'),
  CONSTRAINT ck_invoices_vat_rate CHECK (vat_rate_bp >= 0 AND vat_rate_bp <= 10000),
  CONSTRAINT ck_invoices_amounts CHECK (subtotal_halalas >= 0 AND vat_halalas >= 0),
  CONSTRAINT ck_invoices_total CHECK (total_halalas = subtotal_halalas + vat_halalas),
  CONSTRAINT ck_invoices_period CHECK (period_end IS NULL OR period_end > period_start),
  CONSTRAINT ck_invoices_status CHECK (zatca_status IN ('pending','reported','cleared','rejected')),
  CONSTRAINT ck_invoices_status_at CHECK (zatca_status = 'pending' OR status_at IS NOT NULL),
  CONSTRAINT ck_invoices_pdf CHECK ((pdf_storage_key IS NULL) = (pdf_rendered_at IS NULL)),
  CONSTRAINT ck_invoices_provider CHECK (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  CONSTRAINT ck_invoices_no_pan CHECK (lines::text !~ '[0-9]{13,}'),
  CONSTRAINT ck_invoices_codes_no_pan CHECK (provider_codes::text !~ '[0-9]{13,}')
);
-- one simplified invoice per online payment, one credit note per refund, one SaaS invoice per statement, and one
-- full credit note of an operator invoice (the voided statement, DEC-546)
CREATE UNIQUE INDEX uq_invoices_payment ON invoices(online_payment_id) WHERE kind = 'customer_simplified';
CREATE UNIQUE INDEX uq_invoices_refund ON invoices(refund_id) WHERE refund_id IS NOT NULL;
CREATE UNIQUE INDEX uq_invoices_statement ON invoices(settlement_statement_id) WHERE kind = 'operator_standard';
CREATE UNIQUE INDEX uq_invoices_full_credit ON invoices(original_invoice_id) WHERE kind = 'credit_note' AND refund_id IS NULL;
CREATE INDEX ix_invoices_account ON invoices(account_id, issued_at) WHERE account_id IS NOT NULL;
CREATE INDEX ix_invoices_org ON invoices(org_id, issued_at) WHERE org_id IS NOT NULL;
CREATE INDEX ix_invoices_issued ON invoices(issued_at);
CREATE INDEX ix_invoices_pending ON invoices(issued_at) WHERE zatca_status = 'pending';

ALTER TABLE settlement_statements ADD CONSTRAINT fk_settlement_statements_saas_invoice
  FOREIGN KEY (saas_invoice_id) REFERENCES invoices(id);

-- The chain: a document takes exactly the next counter of its series, the series' last hash as its PIH and the
-- number prefix-counter; then the series advances to it, in the same transaction (so no gap and no fork).
CREATE FUNCTION invoices_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  s record;
BEGIN
  SELECT * INTO s FROM invoice_series WHERE series = NEW.series FOR NO KEY UPDATE;
  IF NOT FOUND OR NEW.icv <> s.last_icv + 1 OR NEW.previous_hash <> s.last_hash
     OR NEW.number <> s.prefix || '-' || lpad(NEW.icv::text, 8, '0') THEN
    RAISE EXCEPTION 'invoice % breaks the chain of series %', NEW.number, NEW.series USING ERRCODE = 'check_violation',
      CONSTRAINT = 'ck_invoices_chain';
  END IF;
  UPDATE invoice_series SET last_icv = NEW.icv, last_hash = NEW.invoice_hash, updated_at = now()
   WHERE series = NEW.series;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_invoices_chain BEFORE INSERT ON invoices FOR EACH ROW EXECUTE FUNCTION invoices_chain();

CREATE FUNCTION invoices_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['zatca_status','provider_reference','provider_hash','provider_qr','provider_codes',
        'submitted_at','status_at','pdf_storage_key','pdf_rendered_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['zatca_status','provider_reference','provider_hash','provider_qr',
        'provider_codes','submitted_at','status_at','pdf_storage_key','pdf_rendered_at']) THEN
    RAISE EXCEPTION 'an invoice is never edited: correct it with a credit note' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'ck_invoices_immutable';
  END IF;
  IF OLD.zatca_status <> 'pending' AND (NEW.zatca_status IS DISTINCT FROM OLD.zatca_status
     OR NEW.provider_reference IS DISTINCT FROM OLD.provider_reference OR NEW.provider_hash IS DISTINCT FROM OLD.provider_hash
     OR NEW.provider_qr IS DISTINCT FROM OLD.provider_qr OR NEW.status_at IS DISTINCT FROM OLD.status_at) THEN
    RAISE EXCEPTION 'the provider''s answer on an invoice is final' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'ck_invoices_status_final';
  END IF;
  IF OLD.pdf_storage_key IS NOT NULL AND (NEW.pdf_storage_key IS DISTINCT FROM OLD.pdf_storage_key
     OR NEW.pdf_rendered_at IS DISTINCT FROM OLD.pdf_rendered_at) THEN
    RAISE EXCEPTION 'an invoice PDF is rendered once' USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_invoices_pdf_once';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_invoices_guard BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION invoices_guard();

-- What the provider said about each document, append-only (P-10's timeline): the submission answers and callbacks.
CREATE TABLE invoice_provider_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invoice_id    uuid NOT NULL REFERENCES invoices(id),
  kind          text NOT NULL,
  outcome       text NOT NULL,
  zatca_status  text,
  codes         jsonb NOT NULL DEFAULT '[]'::jsonb,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_invoice_provider_events_kind CHECK (kind IN ('submit','callback')),
  CONSTRAINT ck_invoice_provider_events_outcome CHECK (outcome IN ('accepted','rejected','error','ignored')),
  CONSTRAINT ck_invoice_provider_events_status CHECK (zatca_status IN ('pending','reported','cleared','rejected')),
  CONSTRAINT ck_invoice_provider_events_no_pan CHECK (codes::text !~ '[0-9]{13,}')
);
CREATE INDEX ix_invoice_provider_events_invoice ON invoice_provider_events(invoice_id, occurred_at);

-- the finance alerts of the provider (P-08 / P-10): a rejected document, a submission that keeps failing
ALTER TABLE platform_alerts DROP CONSTRAINT ck_platform_alerts_type;
ALTER TABLE platform_alerts ADD CONSTRAINT ck_platform_alerts_type
  CHECK (type IN ('payment_unknown','payment_mismatch','payment_refund_failed','payment_reconcile_failed','payment_double',
                  'einvoice_rejected','einvoice_submit_failed'));

-- ---------------------------------------------------------------------
-- 4. Privileges (like 0012): nothing financial is ever deleted by the application; the provider log is append-only
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON invoice_series, invoices, settlement_statements, settlement_lines TO point_app;
GRANT SELECT, INSERT ON invoice_provider_events TO point_app;
REVOKE DELETE ON invoice_series, invoices, settlement_statements, settlement_lines, invoice_provider_events FROM point_app;
REVOKE UPDATE ON invoice_provider_events FROM point_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO point_app;

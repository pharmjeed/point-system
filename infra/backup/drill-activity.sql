-- Restore drill (17 H-09 step 2): a mini event on top of the dev seed — :n tickets of venue RMS / event EVT-R1
-- that went through intake, parking, a staff retrieval and delivery, with their tasks, cycle, custody chain,
-- timeline, audit rows and done outbox rows. Used by infra/backup/restore-drill.sh only (never in production).
--   psql "$DRILL_SOURCE_URL" -v n=200 -v base=1000 -f infra/backup/drill-activity.sql
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE drill_ctx ON COMMIT DROP AS
SELECT v.org_id, v.id AS venue_id, e.id AS event_id, e.dispatch_pool_id AS pool_id,
       (SELECT u.id FROM users u JOIN driver_assignments a ON a.driver_id = u.id AND a.status = 'active'
         WHERE a.venue_id = v.id ORDER BY u.employee_code LIMIT 1) AS parker,
       (SELECT u.id FROM users u JOIN driver_assignments a ON a.driver_id = u.id AND a.status = 'active'
         WHERE a.venue_id = v.id ORDER BY u.employee_code OFFSET 1 LIMIT 1) AS retriever,
       (SELECT u.id FROM users u WHERE u.role = 'supervisor' AND u.org_id = v.org_id ORDER BY u.employee_code LIMIT 1) AS supervisor
  FROM venues v JOIN events e ON e.venue_id = v.id AND e.pricing_mode = 'included' AND e.status = 'open'
 WHERE v.code = 'RMS'
 LIMIT 1;

CREATE TEMP TABLE drill_t ON COMMIT DROP AS
SELECT gen_random_uuid() AS ticket_id, gen_random_uuid() AS cycle_id, gen_random_uuid() AS park_task,
       gen_random_uuid() AS retrieve_task, :base + g AS display_number,
       timestamptz '2026-10-27 16:00:00+00' + make_interval(secs => g * 30) AS t0
  FROM generate_series(1, :n) g;

INSERT INTO tickets (id, org_id, venue_id, event_id, dispatch_pool_id, display_number, status, channel, paper_serial,
                     plate_digits, vehicle_make, vehicle_color, vehicle_type, inspection_status,
                     vehicle_holder_type, key_holder_type, created_by, parked_by, retrieved_by, delivered_by,
                     submitted_at, parked_at, delivered_at, last_requested_at, version, created_at, updated_at)
SELECT t.ticket_id, c.org_id, c.venue_id, c.event_id, c.pool_id, t.display_number, 'delivered', 'paper',
       'DRILL-' || t.display_number, lpad((t.display_number % 9999 + 1)::text, 4, '0'), 'Toyota', 'white', 'sedan',
       'complete', 'customer', 'customer', c.parker, c.parker, c.retriever, c.retriever,
       t.t0 + interval '1 minute', t.t0 + interval '4 minutes', t.t0 + interval '2 hours',
       t.t0 + interval '110 minutes', 9, t.t0, t.t0 + interval '2 hours'
  FROM drill_t t CROSS JOIN drill_ctx c;

INSERT INTO retrieval_cycles (id, org_id, venue_id, ticket_id, cycle_no, requested_at, request_source,
                              requested_by_user_id, request_reason, accepted_by, assigned_at, started_at, ready_at,
                              delivered_at, retrieved_by, delivered_by, handover_method, outcome, closed_at, created_at)
SELECT t.cycle_id, c.org_id, c.venue_id, t.ticket_id, 1, t.t0 + interval '110 minutes', 'staff', c.supervisor,
       'drill: customer at the desk', c.retriever, t.t0 + interval '111 minutes', t.t0 + interval '112 minutes',
       t.t0 + interval '118 minutes', t.t0 + interval '2 hours', c.retriever, c.retriever, 'paper_stub', 'delivered',
       t.t0 + interval '2 hours', t.t0 + interval '110 minutes'
  FROM drill_t t CROSS JOIN drill_ctx c;

INSERT INTO tasks (id, org_id, venue_id, dispatch_pool_id, event_id, ticket_id, cycle_id, type, status, priority_at,
                   assignee_id, queued_at, claimed_at, accepted_at, started_at, completed_at, created_at, updated_at)
SELECT t.park_task, c.org_id, c.venue_id, c.pool_id, c.event_id, t.ticket_id, NULL, 'park', 'completed', t.t0,
       c.parker, NULL, t.t0, t.t0, t.t0 + interval '1 minute', t.t0 + interval '4 minutes', t.t0, t.t0 + interval '4 minutes'
  FROM drill_t t CROSS JOIN drill_ctx c
UNION ALL
SELECT t.retrieve_task, c.org_id, c.venue_id, c.pool_id, c.event_id, t.ticket_id, t.cycle_id, 'retrieve', 'completed',
       t.t0 + interval '110 minutes', c.retriever, t.t0 + interval '110 minutes', t.t0 + interval '111 minutes',
       t.t0 + interval '111 minutes', t.t0 + interval '112 minutes', t.t0 + interval '2 hours',
       t.t0 + interval '110 minutes', t.t0 + interval '2 hours'
  FROM drill_t t CROSS JOIN drill_ctx c;

INSERT INTO custody_events (org_id, venue_id, ticket_id, subject, from_holder_type, from_holder_id, to_holder_type,
                            to_holder_id, reason, task_id, actor_id, occurred_at)
SELECT c.org_id, c.venue_id, t.ticket_id, s.subject, s.from_type,
       CASE s.from_type WHEN 'driver' THEN s.from_driver END, s.to_type,
       CASE s.to_type WHEN 'driver' THEN s.to_driver END, s.reason,
       CASE WHEN s.reason IN ('intake', 'parked', 'key_deposited') THEN t.park_task ELSE t.retrieve_task END,
       COALESCE(s.to_driver, s.from_driver), t.t0 + s.at
  FROM drill_t t CROSS JOIN drill_ctx c
 CROSS JOIN LATERAL (VALUES
   ('vehicle', 'customer', NULL::uuid, 'driver', c.parker, 'intake', interval '0 minutes'),
   ('key', 'customer', NULL::uuid, 'driver', c.parker, 'intake', interval '0 minutes'),
   ('vehicle', 'driver', c.parker, 'spot', NULL::uuid, 'parked', interval '4 minutes'),
   ('key', 'driver', c.parker, 'key_slot', NULL::uuid, 'key_deposited', interval '5 minutes'),
   ('key', 'key_slot', NULL::uuid, 'driver', c.retriever, 'key_pickup', interval '111 minutes'),
   ('vehicle', 'spot', NULL::uuid, 'driver', c.retriever, 'retrieval_start', interval '112 minutes'),
   ('vehicle', 'driver', c.retriever, 'customer', NULL::uuid, 'handover', interval '2 hours'),
   ('key', 'driver', c.retriever, 'customer', NULL::uuid, 'handover', interval '2 hours')
 ) AS s(subject, from_type, from_driver, to_type, to_driver, reason, at);

INSERT INTO ticket_events (org_id, venue_id, ticket_id, type, actor_type, actor_id, ticket_version, data, occurred_at)
SELECT c.org_id, c.venue_id, t.ticket_id, e.type, 'user', e.actor::text, e.v, '{}'::jsonb, t.t0 + e.at
  FROM drill_t t CROSS JOIN drill_ctx c
 CROSS JOIN LATERAL (VALUES
   ('ticket.created', c.parker, 1, interval '0 minutes'), ('ticket.submitted', c.parker, 2, interval '1 minute'),
   ('ticket.parked', c.parker, 3, interval '4 minutes'), ('ticket.retrieval_requested', c.supervisor, 4, interval '110 minutes'),
   ('task.claimed', c.retriever, 5, interval '111 minutes'), ('ticket.retrieving', c.retriever, 6, interval '112 minutes'),
   ('ticket.ready', c.retriever, 7, interval '118 minutes'), ('ticket.delivered', c.retriever, 9, interval '2 hours')
 ) AS e(type, actor, v, at);

INSERT INTO audit_log (org_id, occurred_at, actor_type, actor_id, action, entity_type, entity_id, venue_id, request_id, metadata)
SELECT c.org_id, t.t0 + interval '110 minutes', 'user', c.supervisor::text, 'retrieval.request_on_behalf', 'ticket',
       t.ticket_id, c.venue_id, 'req_drill_' || t.display_number, '{"drill": true}'::jsonb
  FROM drill_t t CROSS JOIN drill_ctx c;

INSERT INTO outbox_events (org_id, type, aggregate_type, aggregate_id, aggregate_version, venue_id, payload,
                           available_at, status, attempts, created_at, processed_at)
SELECT c.org_id, 'ticket.delivered', 'ticket', t.ticket_id, 9, c.venue_id,
       jsonb_build_object('ticket_id', t.ticket_id), t.t0 + interval '2 hours', 'done', 1,
       t.t0 + interval '2 hours', t.t0 + interval '2 hours'
  FROM drill_t t CROSS JOIN drill_ctx c;

UPDATE events e SET next_display_number = GREATEST(e.next_display_number, :base + :n + 1)
  FROM drill_ctx c WHERE e.id = c.event_id;
COMMIT;

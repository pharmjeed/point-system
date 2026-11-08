-- Consistency of restored data (17 H-01 step 6, H-08, H-09 step 4; PNT-095). Each row is one check and the
-- number of rows that violate it; a healthy database answers 0 everywhere. The partial unique indexes and
-- ck_* constraints of 06_schema.sql are re-validated by the restore itself (pg_restore rebuilds them).
--   psql "$DATABASE_URL" -At -F '|' -f infra/backup/consistency.sql
SELECT 'task_offered_without_active_round' AS check_name, count(*) AS violations
  FROM tasks t
 WHERE t.status IN ('offered', 'broadcast')
   AND NOT EXISTS (SELECT 1 FROM task_offers o WHERE o.task_id = t.id AND o.status = 'active')
UNION ALL
SELECT 'active_round_on_closed_task', count(*)
  FROM task_offers o JOIN tasks t ON t.id = o.task_id
 WHERE o.status = 'active' AND t.status IN ('completed', 'canceled', 'accepted', 'in_progress', 'assigned_waiting')
UNION ALL
SELECT 'idle_driver_with_active_movement', count(*)
  FROM duty_sessions d
 WHERE d.status = 'on_duty' AND d.available_since IS NOT NULL
   AND EXISTS (SELECT 1 FROM tasks t WHERE t.assignee_id = d.user_id AND t.status = 'in_progress')
UNION ALL
SELECT 'closed_ticket_with_open_task', count(*)
  FROM tickets k
 WHERE k.status IN ('delivered', 'voided')
   AND EXISTS (SELECT 1 FROM tasks t WHERE t.ticket_id = k.id AND t.status NOT IN ('completed', 'canceled'))
UNION ALL
SELECT 'ticket_points_to_closed_cycle', count(*)
  FROM tickets k JOIN retrieval_cycles c ON c.id = k.active_cycle_id
 WHERE c.closed_at IS NOT NULL
UNION ALL
SELECT 'cycle_of_another_ticket', count(*)
  FROM tickets k JOIN retrieval_cycles c ON c.id = k.active_cycle_id
 WHERE c.ticket_id <> k.id
UNION ALL
SELECT 'duty_session_of_ended_assignment', count(*)
  FROM duty_sessions d JOIN driver_assignments a ON a.id = d.assignment_id
 WHERE d.status <> 'ended' AND a.status <> 'active'
UNION ALL
SELECT 'live_handover_code_on_closed_cycle', count(*)
  FROM claim_codes cc JOIN retrieval_cycles c ON c.id = cc.cycle_id
 WHERE c.closed_at IS NOT NULL AND c.outcome <> 'delivered' AND cc.consumed_at IS NULL AND cc.revoked_at IS NULL
   AND cc.expires_at > c.closed_at
ORDER BY 1;

-- =====================================================================
-- docs/06_schema_invariants_test.sql — executable proof of the business invariants in 06_schema.sql
-- Run on an EMPTY database after loading 06_schema.sql:
--   psql -d point_test -v ON_ERROR_STOP=1 -f 06_schema.sql -f 06_schema_invariants_test.sql
-- Every expect_fail() must print 'ok (rejected)'; the script ends with 'ALL INVARIANT TESTS PASSED'.
-- Convert these into integration tests (Testcontainers) — see 17_Test_Acceptance_Plan.md.
-- =====================================================================
\set ON_ERROR_STOP 1
BEGIN;
-- seed
INSERT INTO organizations(id,name_ar) VALUES ('00000000-0000-0000-0000-000000000001','مؤسسة الفاليت');
INSERT INTO venues(id,org_id,code,name_ar) VALUES
 ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-000000000001','RMS','قاعة ريماس'),
 ('00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-000000000001','LYL','قاعة ليلتي');
INSERT INTO dispatch_pools(id,org_id,venue_id,name,is_default) VALUES
 ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','الافتراضية',true);
INSERT INTO users(id,org_id,employee_code,full_name,phone_e164,role,secret_kind,secret_hash) VALUES
 ('00000000-0000-0000-0000-0000000000c0','00000000-0000-0000-0000-000000000001','A-0001','المالك','+966500000000','owner','password','x'),
 ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-000000000001','D-0001','سائق 1','+966500000001','driver','pin','x'),
 ('00000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-000000000001','D-0002','سائق 2','+966500000002','driver','pin','x');
INSERT INTO driver_assignments(org_id,driver_id,venue_id,status,starts_at,created_by) VALUES
 ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000a1','active',now(),'00000000-0000-0000-0000-0000000000c0');
INSERT INTO events(id,org_id,venue_id,dispatch_pool_id,name_ar,event_date,status,created_by) VALUES
 ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','حفل تجريبي',current_date,'open','00000000-0000-0000-0000-0000000000c0');
INSERT INTO tickets(id,org_id,venue_id,event_id,dispatch_pool_id,display_number,status,created_by,key_tag) VALUES
 ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000b1',1,'received','00000000-0000-0000-0000-0000000000c1','K-7'),
 ('00000000-0000-0000-0000-0000000000e2','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000b1',2,'received','00000000-0000-0000-0000-0000000000c2',NULL);
INSERT INTO tasks(id,org_id,venue_id,dispatch_pool_id,event_id,ticket_id,type,status,priority_at,assignee_id) VALUES
 ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000e1','park','in_progress',now(),'00000000-0000-0000-0000-0000000000c1');
COMMIT;

CREATE OR REPLACE FUNCTION expect_fail(label text, stmt text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
    RAISE EXCEPTION 'NOT REJECTED: %', label;
  EXCEPTION
    WHEN unique_violation OR check_violation OR foreign_key_violation OR not_null_violation THEN
      RAISE NOTICE 'ok (rejected): % [%]', label, SQLSTATE;
  END;
END $$;

SELECT expect_fail('2nd active assignment for same driver',
 $q$INSERT INTO driver_assignments(org_id,driver_id,venue_id,status,starts_at,created_by) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000a2','active',now(),'00000000-0000-0000-0000-0000000000c0')$q$);
SELECT expect_fail('duplicate display number in event',
 $q$INSERT INTO tickets(org_id,venue_id,event_id,dispatch_pool_id,display_number,created_by) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000b1',1,'00000000-0000-0000-0000-0000000000c1')$q$);
SELECT expect_fail('key tag reused by another open ticket',
 $q$UPDATE tickets SET key_tag='K-7' WHERE id='00000000-0000-0000-0000-0000000000e2'$q$);
SELECT expect_fail('second open task on same ticket',
 $q$INSERT INTO tasks(org_id,venue_id,dispatch_pool_id,event_id,ticket_id,type,status,priority_at,assignee_id) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000e1','repark','in_progress',now(),'00000000-0000-0000-0000-0000000000c2')$q$);
SELECT expect_fail('second active movement for same driver',
 $q$INSERT INTO tasks(org_id,venue_id,dispatch_pool_id,event_id,ticket_id,type,status,priority_at,assignee_id) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000e2','park','in_progress',now(),'00000000-0000-0000-0000-0000000000c1')$q$);
SELECT expect_fail('park task in queued state',
 $q$INSERT INTO tasks(org_id,venue_id,dispatch_pool_id,event_id,ticket_id,type,status,priority_at) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000e2','park','queued',now())$q$);
SELECT expect_fail('payment with card-like reference',
 $q$INSERT INTO payments(org_id,venue_id,event_id,ticket_id,method,amount_halalas,pos_reference,collected_by) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000e1','pos',2000,'4111111111111111','00000000-0000-0000-0000-0000000000c1')$q$);
SELECT expect_fail('included event with a fee',
 $q$INSERT INTO events(org_id,venue_id,dispatch_pool_id,name_ar,event_date,pricing_mode,fee_halalas,created_by) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','x',current_date,'included',500,'00000000-0000-0000-0000-0000000000c0')$q$);
SELECT expect_fail('driver with password secret',
 $q$INSERT INTO users(org_id,employee_code,full_name,phone_e164,role,secret_kind,secret_hash) VALUES ('00000000-0000-0000-0000-000000000001','D-0009','x','+966500000009','driver','password','x')$q$);

-- retrieval flow constraints on ticket e1 (simulate parked + request)
UPDATE tasks SET status='completed', completed_at=now() WHERE id='00000000-0000-0000-0000-0000000000f1';
UPDATE tickets SET status='parked', vehicle_holder_type='spot' WHERE id='00000000-0000-0000-0000-0000000000e1';
INSERT INTO customers(id,org_id,phone_e164,wa_id) VALUES ('00000000-0000-0000-0000-000000000c51','00000000-0000-0000-0000-000000000001','+966551234567','966551234567');
INSERT INTO retrieval_cycles(id,org_id,venue_id,ticket_id,cycle_no,requested_at,request_source,requested_by_customer_id) VALUES
 ('00000000-0000-0000-0000-000000000901','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000e1',1,now(),'whatsapp','00000000-0000-0000-0000-000000000c51');

SELECT expect_fail('second open retrieval cycle',
 $q$INSERT INTO retrieval_cycles(org_id,venue_id,ticket_id,cycle_no,requested_at,request_source,requested_by_customer_id) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000e1',2,now(),'whatsapp','00000000-0000-0000-0000-000000000c51')$q$);
SELECT expect_fail('staff request without reason',
 $q$INSERT INTO retrieval_cycles(org_id,venue_id,ticket_id,cycle_no,requested_at,request_source,requested_by_user_id) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000e2',1,now(),'staff','00000000-0000-0000-0000-0000000000c1')$q$);
INSERT INTO tasks(id,org_id,venue_id,dispatch_pool_id,event_id,ticket_id,cycle_id,type,status,priority_at) VALUES
 ('00000000-0000-0000-0000-0000000000f2','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-000000000901','retrieve','queued',now());
SELECT expect_fail('queued task with an assignee',
 $q$UPDATE tasks SET assignee_id='00000000-0000-0000-0000-0000000000c1' WHERE id='00000000-0000-0000-0000-0000000000f2'$q$);
INSERT INTO task_offers(id,org_id,task_id,dispatch_pool_id,mode,round_no,expires_at) VALUES
 ('00000000-0000-0000-0000-000000000a01','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000f2','00000000-0000-0000-0000-0000000000b1','single',1,now()+interval '30 seconds');
SELECT expect_fail('second active offer round for same task',
 $q$INSERT INTO task_offers(org_id,task_id,dispatch_pool_id,mode,round_no) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000f2','00000000-0000-0000-0000-0000000000b1','broadcast',2)$q$);
SELECT expect_fail('single offer without expiry',
 $q$INSERT INTO task_offers(org_id,task_id,dispatch_pool_id,mode,round_no,status,closed_at) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000f2','00000000-0000-0000-0000-0000000000b1','single',3,'expired',now())$q$);
-- accept by driver c1 (available) -> accepted
UPDATE task_offers SET status='accepted', closed_at=now(), close_reason='accepted', accepted_by='00000000-0000-0000-0000-0000000000c1' WHERE id='00000000-0000-0000-0000-000000000a01';
UPDATE tasks SET status='accepted', assignee_id='00000000-0000-0000-0000-0000000000c1', accepted_at=now(), claimed_at=now() WHERE id='00000000-0000-0000-0000-0000000000f2';
-- driver c1 tries to reserve a 2nd next task twice
INSERT INTO tickets(id,org_id,venue_id,event_id,dispatch_pool_id,display_number,status,created_by,vehicle_holder_type) VALUES
 ('00000000-0000-0000-0000-0000000000e3','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000b1',3,'parked','00000000-0000-0000-0000-0000000000c2','spot'),
 ('00000000-0000-0000-0000-0000000000e4','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000b1',4,'parked','00000000-0000-0000-0000-0000000000c2','spot');
INSERT INTO retrieval_cycles(id,org_id,venue_id,ticket_id,cycle_no,requested_at,request_source,requested_by_customer_id) VALUES
 ('00000000-0000-0000-0000-000000000902','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000e3',1,now(),'whatsapp','00000000-0000-0000-0000-000000000c51'),
 ('00000000-0000-0000-0000-000000000903','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000e4',1,now(),'whatsapp','00000000-0000-0000-0000-000000000c51');
INSERT INTO tasks(org_id,venue_id,dispatch_pool_id,event_id,ticket_id,cycle_id,type,status,priority_at,assignee_id,assigned_waiting_at) VALUES
 ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000e3','00000000-0000-0000-0000-000000000902','retrieve','assigned_waiting',now(),'00000000-0000-0000-0000-0000000000c1',now());
SELECT expect_fail('second reserved next task for same driver',
 $q$INSERT INTO tasks(org_id,venue_id,dispatch_pool_id,event_id,ticket_id,cycle_id,type,status,priority_at,assignee_id) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000e4','00000000-0000-0000-0000-000000000903','retrieve','assigned_waiting',now(),'00000000-0000-0000-0000-0000000000c1')$q$);
-- claim codes
INSERT INTO claim_codes(org_id,ticket_id,cycle_id,code_hash,expires_at) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-000000000901','h1',now()+interval '30 min');
SELECT expect_fail('second live claim code for same cycle',
 $q$INSERT INTO claim_codes(org_id,ticket_id,cycle_id,code_hash,expires_at) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-000000000901','h2',now()+interval '30 min')$q$);
-- whatsapp
INSERT INTO whatsapp_channel(id,org_id,business_account_id,phone_number_id,access_token_secret_ref,app_secret_ref,verify_token_secret_ref,api_version) VALUES
 ('00000000-0000-0000-0000-000000000b01','00000000-0000-0000-0000-000000000001','waba','pnid','sm://a','sm://b','sm://c','vXX.0');
SELECT expect_fail('second active whatsapp channel (no per-venue numbers)',
 $q$INSERT INTO whatsapp_channel(org_id,business_account_id,phone_number_id,access_token_secret_ref,app_secret_ref,verify_token_secret_ref,api_version) VALUES ('00000000-0000-0000-0000-000000000001','waba2','pnid2','sm://a','sm://b','sm://c','vXX.0')$q$);
INSERT INTO whatsapp_messages(org_id,channel_id,direction,wa_message_id,kind,status,received_at) VALUES
 ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000b01','inbound','wamid.ABC','inbound_button','received',now());
SELECT expect_fail('duplicate inbound wamid',
 $q$INSERT INTO whatsapp_messages(org_id,channel_id,direction,wa_message_id,kind,status,received_at) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000b01','inbound','wamid.ABC','inbound_button','received',now())$q$);
SELECT expect_fail('inbound message with outbound status',
 $q$INSERT INTO whatsapp_messages(org_id,channel_id,direction,kind,status) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000b01','inbound','inbound_text','sent')$q$);
-- key slot double allocation
INSERT INTO key_boards(id,org_id,venue_id,name) VALUES ('00000000-0000-0000-0000-000000000c01','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','اللوحة 1');
INSERT INTO key_slots(id,org_id,venue_id,key_board_id,label) VALUES ('00000000-0000-0000-0000-000000000c02','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-000000000c01','12');
INSERT INTO key_slot_allocations(org_id,ticket_id,key_slot_id,allocated_by) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e3','00000000-0000-0000-0000-000000000c02','00000000-0000-0000-0000-0000000000c2');
SELECT expect_fail('key slot occupied by another ticket',
 $q$INSERT INTO key_slot_allocations(org_id,ticket_id,key_slot_id,allocated_by) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e4','00000000-0000-0000-0000-000000000c02','00000000-0000-0000-0000-0000000000c2')$q$);
-- outbox dedupe while pending
INSERT INTO outbox_events(org_id,type,dedupe_key) VALUES ('00000000-0000-0000-0000-000000000001','job.dispatch_pass','dispatch_pass:pool1');
SELECT expect_fail('duplicate pending dispatch pass job',
 $q$INSERT INTO outbox_events(org_id,type,dedupe_key) VALUES ('00000000-0000-0000-0000-000000000001','job.dispatch_pass','dispatch_pass:pool1')$q$);
-- view check
SELECT 'v_driver_state rows: '||count(*) FROM v_driver_state;
SELECT 'ALL INVARIANT TESTS PASSED';

-- =====================================================================
-- docs/06_schema_invariants_test.sql — executable proof of the business invariants in 06_schema.sql
-- Run on an EMPTY database built from the migrations (`pnpm db:invariants`; packages/db/migrations: the first one is
-- 06_schema.sql verbatim, 0008 adds the V2 platform tables checked at the end, V2-001, 0009 the customer accounts,
-- V2-010, and 0012 the online payments, V2-020 / V2-021):
--   psql -d point_test -v ON_ERROR_STOP=1 -f 06_schema_invariants_test.sql
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
-- V2 platform layer (0008_platform.sql, V2-001, DEC-461): checks are only added here, never weakened
SELECT 'organization defaults to an active operator: '||operator_status||' platform_operated='||is_platform_operated
  FROM organizations WHERE id='00000000-0000-0000-0000-000000000001';
INSERT INTO platform_users(id,phone_e164,full_name,role,secret_hash) VALUES
 ('00000000-0000-0000-0000-00000000f001','+966500000901','مالك المنصة','platform_owner','x');
SELECT expect_fail('platform user with an unknown role',
 $q$INSERT INTO platform_users(phone_e164,full_name,role,secret_hash) VALUES ('+966500000902','x','owner','x')$q$);
SELECT expect_fail('second platform user with the same phone',
 $q$INSERT INTO platform_users(phone_e164,full_name,role,secret_hash) VALUES ('+966500000901','x','platform_admin','x')$q$);
SELECT expect_fail('platform MFA enabled without a secret',
 $q$UPDATE platform_users SET mfa_enabled=true WHERE id='00000000-0000-0000-0000-00000000f001'$q$);
SELECT expect_fail('disabled platform user without disabled_at',
 $q$UPDATE platform_users SET status='disabled' WHERE id='00000000-0000-0000-0000-00000000f001'$q$);
INSERT INTO platform_sessions(platform_user_id,token_hash,expires_at) VALUES
 ('00000000-0000-0000-0000-00000000f001','th1',now()+interval '1 hour');
SELECT expect_fail('platform session token stored twice',
 $q$INSERT INTO platform_sessions(platform_user_id,token_hash,expires_at) VALUES ('00000000-0000-0000-0000-00000000f001','th1',now()+interval '1 hour')$q$);
SELECT expect_fail('verified MFA challenge row',
 $q$INSERT INTO platform_sessions(platform_user_id,kind,token_hash,mfa_verified,expires_at) VALUES ('00000000-0000-0000-0000-00000000f001','mfa_challenge','th2',true,now()+interval '5 minutes')$q$);
SELECT expect_fail('platform session revoked reason without revoked_at',
 $q$INSERT INTO platform_sessions(platform_user_id,token_hash,expires_at,revoked_reason) VALUES ('00000000-0000-0000-0000-00000000f001','th3',now()+interval '1 hour','logout')$q$);
SELECT expect_fail('staff user cannot own a platform session',
 $q$INSERT INTO platform_sessions(platform_user_id,token_hash,expires_at) VALUES ('00000000-0000-0000-0000-0000000000c0','th4',now()+interval '1 hour')$q$);
SELECT expect_fail('unknown operator status',
 $q$UPDATE organizations SET operator_status='paused' WHERE id='00000000-0000-0000-0000-000000000001'$q$);
SELECT expect_fail('VAT number not 15 digits 3…3',
 $q$UPDATE organizations SET vat_number='123456789012345' WHERE id='00000000-0000-0000-0000-000000000001'$q$);
SELECT expect_fail('operator contract ending before it starts',
 $q$INSERT INTO operator_contracts(org_id,saas_fee_halalas_per_venue,saas_cycle,subscriber_visit_payout_halalas,app_payment_commission_bp,starts_on,ends_on,created_by) VALUES ('00000000-0000-0000-0000-000000000001',0,'monthly',0,0,'2026-02-01','2026-01-01','00000000-0000-0000-0000-00000000f001')$q$);
SELECT expect_fail('operator contract commission above 100%',
 $q$INSERT INTO operator_contracts(org_id,saas_fee_halalas_per_venue,saas_cycle,subscriber_visit_payout_halalas,app_payment_commission_bp,starts_on,created_by) VALUES ('00000000-0000-0000-0000-000000000001',0,'monthly',0,10001,'2026-01-01','00000000-0000-0000-0000-00000000f001')$q$);
SELECT expect_fail('operator contract created by a staff user',
 $q$INSERT INTO operator_contracts(org_id,saas_fee_halalas_per_venue,saas_cycle,subscriber_visit_payout_halalas,app_payment_commission_bp,starts_on,created_by) VALUES ('00000000-0000-0000-0000-000000000001',0,'monthly',0,0,'2026-01-01','00000000-0000-0000-0000-0000000000c0')$q$);
SELECT expect_fail('approved public profile without approver',
 $q$INSERT INTO venue_public_profiles(venue_id,org_id,status,category) VALUES ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-000000000001','approved','hall')$q$);
SELECT expect_fail('public profile with an unknown category',
 $q$INSERT INTO venue_public_profiles(venue_id,org_id,category) VALUES ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-000000000001','stadium')$q$);
SELECT expect_fail('public profile with half a location',
 $q$INSERT INTO venue_public_profiles(venue_id,org_id,category,lat) VALUES ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-000000000001','hall',24.7)$q$);
SELECT expect_fail('platform audit row of a platform user without actor_id',
 $q$INSERT INTO platform_audit_log(actor_type,action,entity_type) VALUES ('platform_user','platform.auth.login','platform_user')$q$);
-- V2 customer accounts (0009_customer_accounts.sql, V2-010, DEC-496 … DEC-498): checks are only added here
INSERT INTO customer_accounts(id,phone_e164) VALUES ('00000000-0000-0000-0000-00000000ca01','+966500000951');
SELECT expect_fail('second customer account with the same phone',
 $q$INSERT INTO customer_accounts(phone_e164) VALUES ('+966500000951')$q$);
SELECT expect_fail('deleted customer account without deleted_at',
 $q$UPDATE customer_accounts SET status='deleted' WHERE id='00000000-0000-0000-0000-00000000ca01'$q$);
INSERT INTO customer_otp_challenges(phone_e164,device_id,platform,code_hash,code_ciphertext,attempts_left,expires_at,resend_available_at) VALUES
 ('+966500000951','device-0001','ios','h1','c1',5,now()+interval '5 minutes',now()+interval '1 minute');
SELECT expect_fail('second open sign-in code for the same number',
 $q$INSERT INTO customer_otp_challenges(phone_e164,device_id,platform,code_hash,attempts_left,expires_at,resend_available_at) VALUES ('+966500000951','device-0002','android','h2',5,now()+interval '5 minutes',now()+interval '1 minute')$q$);
SELECT expect_fail('closed sign-in code keeps its encrypted copy',
 $q$UPDATE customer_otp_challenges SET status='superseded', closed_at=now() WHERE phone_e164='+966500000951'$q$);
SELECT expect_fail('sent sign-in code keeps its encrypted copy',
 $q$UPDATE customer_otp_challenges SET delivery_status='sent', sent_at=now() WHERE phone_e164='+966500000951'$q$);
SELECT expect_fail('locked number without locked_until',
 $q$UPDATE customer_otp_challenges SET status='locked', closed_at=now(), code_ciphertext=NULL WHERE phone_e164='+966500000951'$q$);
SELECT expect_fail('more than five attempts on a code',
 $q$UPDATE customer_otp_challenges SET attempts_left=6 WHERE phone_e164='+966500000951'$q$);
INSERT INTO customer_account_sessions(account_id,device_id,platform,refresh_hash,access_hash,access_expires_at,refresh_expires_at) VALUES
 ('00000000-0000-0000-0000-00000000ca01','device-0001','ios','rh1','ah1',now()+interval '15 minutes',now()+interval '60 days');
SELECT expect_fail('second live session of an account on the same device',
 $q$INSERT INTO customer_account_sessions(account_id,device_id,platform,refresh_hash,access_hash,access_expires_at,refresh_expires_at) VALUES ('00000000-0000-0000-0000-00000000ca01','device-0001','ios','rh2','ah2',now()+interval '15 minutes',now()+interval '60 days')$q$);
SELECT expect_fail('customer session revoked without a reason',
 $q$UPDATE customer_account_sessions SET revoked_at=now() WHERE refresh_hash='rh1'$q$);
SELECT expect_fail('terms consent recorded as refused (withdrawal is account deletion)',
 $q$INSERT INTO customer_account_consents(account_id,kind,version,granted) VALUES ('00000000-0000-0000-0000-00000000ca01','terms','2026-11-01',false)$q$);
INSERT INTO customer_vehicles(account_id,plate_digits,plate_letters_ar,plate_letters_en) VALUES
 ('00000000-0000-0000-0000-00000000ca01','4821','ب ح د','B J D');
SELECT expect_fail('same plate twice in one customer account',
 $q$INSERT INTO customer_vehicles(account_id,plate_digits,plate_letters_ar,plate_letters_en) VALUES ('00000000-0000-0000-0000-00000000ca01','4821','ب ح د','B J D')$q$);
SELECT expect_fail('Saudi plate of a customer vehicle without letters',
 $q$INSERT INTO customer_vehicles(account_id,plate_digits) VALUES ('00000000-0000-0000-0000-00000000ca01','12')$q$);
UPDATE customers SET customer_account_id='00000000-0000-0000-0000-00000000ca01' WHERE id='00000000-0000-0000-0000-000000000c51';
SELECT expect_fail('two customers rows of one operator for the same account',
 $q$INSERT INTO customers(org_id,phone_e164,customer_account_id) VALUES ('00000000-0000-0000-0000-000000000001','+966500000952','00000000-0000-0000-0000-00000000ca01')$q$);
SELECT expect_fail('customer audit row of a customer without account',
 $q$INSERT INTO customer_audit_log(actor_type,action,entity_type) VALUES ('customer','customer.auth.signed_in','customer_account')$q$);
-- V2 online payments (0012_online_payments.sql, V2-020 / V2-021, DEC-510 … DEC-514): checks are only added here
SELECT expect_fail('saved card stored as a card number instead of a gateway token',
 $q$INSERT INTO customer_payment_methods(account_id,gateway,gateway_token,last4) VALUES ('00000000-0000-0000-0000-00000000ca01','moyasar','4111111111111111','1111')$q$);
INSERT INTO online_payments(id,account_id,purpose,ticket_id,org_id,venue_id,amount_halalas,vat_halalas,gateway,given_id,gateway_payment_id,status,paid_at) VALUES
 ('00000000-0000-0000-0000-00000000ab01','00000000-0000-0000-0000-00000000ca01','visit','00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1',2300,300,'moyasar','00000000-0000-0000-0000-00000000ab91','pay-inv-1','paid',now());
SELECT expect_fail('second successful online payment for the same ticket',
 $q$INSERT INTO online_payments(account_id,purpose,ticket_id,org_id,venue_id,amount_halalas,vat_halalas,gateway,given_id,gateway_payment_id,status,paid_at) VALUES ('00000000-0000-0000-0000-00000000ca01','visit','00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1',2300,300,'moyasar','00000000-0000-0000-0000-00000000ab92','pay-inv-2','paid',now())$q$);
SELECT expect_fail('the same gateway payment recorded twice',
 $q$INSERT INTO online_payments(account_id,purpose,subscription_id,amount_halalas,vat_halalas,gateway,given_id,gateway_payment_id,status) VALUES ('00000000-0000-0000-0000-00000000ca01','subscription',gen_random_uuid(),2300,300,'moyasar','00000000-0000-0000-0000-00000000ab93','pay-inv-1','authorized')$q$);
SELECT expect_fail('visit payment without its ticket',
 $q$INSERT INTO online_payments(account_id,purpose,amount_halalas,vat_halalas,gateway,given_id) VALUES ('00000000-0000-0000-0000-00000000ca01','visit',2300,300,'moyasar','00000000-0000-0000-0000-00000000ab94')$q$);
SELECT expect_fail('online payment below the gateway minimum',
 $q$INSERT INTO online_payments(account_id,purpose,subscription_id,amount_halalas,vat_halalas,gateway,given_id) VALUES ('00000000-0000-0000-0000-00000000ca01','subscription',gen_random_uuid(),99,0,'moyasar','00000000-0000-0000-0000-00000000ab95')$q$);
SELECT expect_fail('refunded more than was paid',
 $q$UPDATE online_payments SET refunded_halalas=2400, status='refunded' WHERE id='00000000-0000-0000-0000-00000000ab01'$q$);
SELECT expect_fail('refunded amount on a payment still marked paid',
 $q$UPDATE online_payments SET refunded_halalas=500 WHERE id='00000000-0000-0000-0000-00000000ab01'$q$);
SELECT expect_fail('paid online payment without paid_at',
 $q$UPDATE online_payments SET paid_at=NULL WHERE id='00000000-0000-0000-0000-00000000ab01'$q$);
SELECT expect_fail('refund without a reason',
 $q$INSERT INTO refunds(online_payment_id,amount_halalas,reason,issued_by) VALUES ('00000000-0000-0000-0000-00000000ab01',500,'','00000000-0000-0000-0000-00000000f001')$q$);
SELECT expect_fail('refund issued by a staff user instead of a platform account',
 $q$INSERT INTO refunds(online_payment_id,amount_halalas,reason,issued_by) VALUES ('00000000-0000-0000-0000-00000000ab01',500,'خطأ في السعر','00000000-0000-0000-0000-0000000000c0')$q$);
INSERT INTO gateway_webhook_events(gateway,event_id,event_type,body_sha256,payload) VALUES ('moyasar','evt-1','payment_paid','sha1','{}');
SELECT expect_fail('the same gateway webhook event stored twice',
 $q$INSERT INTO gateway_webhook_events(gateway,event_id,event_type,body_sha256,payload) VALUES ('moyasar','evt-1','payment_paid','sha2','{}')$q$);
SELECT expect_fail('gateway webhook payload carrying a card number',
 $q$INSERT INTO gateway_webhook_events(gateway,event_id,event_type,body_sha256,payload) VALUES ('moyasar','evt-2','payment_paid','sha3','{"number":"4111111111111111"}')$q$);
INSERT INTO platform_alerts(type,severity,dedupe_key) VALUES ('payment_unknown','critical','payment_unknown:pay-x');
SELECT expect_fail('second live platform alert for the same key',
 $q$INSERT INTO platform_alerts(type,severity,dedupe_key) VALUES ('payment_unknown','critical','payment_unknown:pay-x')$q$);
SELECT 'ALL INVARIANT TESTS PASSED';

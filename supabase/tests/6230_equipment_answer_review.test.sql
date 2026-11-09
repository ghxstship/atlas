-- pgTAP: migration 6230 with R9's real answer review (P9b, ADR 0138 C12) and R10's claim. An answer asks for a radio an
-- Equipment rule gates: its review commits and the allocation stays Requested for the Allocations queue, since a reviewer
-- may approve it only after every step has. An approval opened from an unclaimed token answer takes its requester at the claim.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 4654_project_facts_world.psql
\ir 4691_allocation_world.psql

select no_plan();

select pg_temp.as_user('alice');
with x as (insert into app.approval_rules (project_id, subject, name, asset_class_id)
           values (pg_temp.id('prj_a'), 'Equipment', 'Radio requests', pg_temp.id('cls_radio')) returning id)
  insert into world select 'rule_radio', id from x;
insert into app.approval_rule_steps (approval_rule_id, step_order, name, approver_membership_id)
values (pg_temp.id('rule_radio'), 1, 'Quartermaster', pg_temp.id('bob@org_a'));
select app.transition_approval_rule(pg_temp.id('rule_radio'), 'Draft', 'Active', 'Gate radios.');

select pg_temp.as_user('dave');
with x as (insert into app.advance_packets (project_id, title) values (pg_temp.id('prj_a'), 'Vendor Advance') returning id)
insert into world select 'pkt', id from x;
with x as (insert into app.advance_sections (advance_packet_id, position, title, section_kind, max_lines)
  values (pg_temp.id('pkt'), 1, 'Radios', 'Item Request', 3) returning id) insert into world select 's_items', id from x;
insert into app.advance_section_choices (advance_section_id, asset_class_id) values (pg_temp.id('s_items'), pg_temp.id('cls_radio'));
with x as (insert into app.advance_recipients (advance_packet_id, counterparty_id, engagement_id)
  values (pg_temp.id('pkt'), pg_temp.id('cp_v_a'), pg_temp.id('eng_vendor_a')) returning id) insert into world select 'rcp', id from x;
select app.send_advance_packet(pg_temp.id('pkt'));

-- The answer asks; its allocation opens the approval ------------------------------------------------------------------------
select pg_temp.as_user('victor');
insert into world values ('a_items', app.submit_advance_answer(pg_temp.id('rcp'), pg_temp.id('s_items'), null, null,
  jsonb_build_array(jsonb_build_object('asset_class_id', pg_temp.id('cls_radio'), 'quantity', 1)), '{}'));
select pg_temp.as_platform();
insert into world select 'alloc', a.id from app.advance_allocations a
  join app.advance_submission_lines l on l.id = a.advance_submission_line_id where l.advance_submission_id = pg_temp.id('a_items');
select is((select count(*)::int from app.subject_approvals where advance_allocation_id = pg_temp.id('alloc')), 1, 'the answer''s radio opens one approval');

-- The real review: the trigger's decide_allocation meets the gate inside its trusted operation ------------------------------
select pg_temp.as_user('carol');
select lives_ok($$update app.advance_submissions set review_outcome = 'Accepted' where id = (select id from world where key = 'a_items')$$,
  'accepting the answer commits while the approval is In Review');
select pg_temp.as_platform();
select is((select review_outcome::text from app.advance_submissions where id = pg_temp.id('a_items')), 'Accepted', 'the answer is Accepted');
select is((select allocation_state::text from app.advance_allocations where id = pg_temp.id('alloc')), 'Requested', 'and the allocation stays Requested for the queue');
select is((select private.subject_approval_state(a.id)::text from app.subject_approvals a where a.advance_allocation_id = pg_temp.id('alloc')), 'In Review',
  'with its approval still In Review');

-- A token answer's approval learns its requester at the claim ---------------------------------------------------------------
select pg_temp.as_platform();
with x as (insert into app.advance_recipient_tokens (org_id, advance_recipient_id, recipient_email, token_hash, access_code_hash, expires_at)
  values (pg_temp.id('org_a'), pg_temp.id('rcp'), 'crew@example.com', sha256('pgtap-token'), sha256('pgtap-code'), now() + interval '1 day') returning id)
  insert into world select 'tok', id from x;
-- As R10 leaves them: an answer through the link, with no requester until the link is claimed.
set local session_replication_role = replica;
update app.subject_approvals set requested_by = null where advance_allocation_id = pg_temp.id('alloc');
update app.advance_allocations set created_by = null where id = pg_temp.id('alloc');
update app.advance_submissions set advance_recipient_token_id = pg_temp.id('tok') where id = pg_temp.id('a_items');
set local session_replication_role = origin;
select is(private.allocation_requester(pg_temp.id('alloc')), null::uuid, 'an unclaimed token answer has no requester yet');
update app.advance_recipient_tokens set claimed_by = pg_temp.id('ivy'), claimed_at = now() where id = pg_temp.id('tok');
select is((select requested_by from app.subject_approvals where advance_allocation_id = pg_temp.id('alloc')), pg_temp.id('ivy'),
  'the claim gives its approval the claimer as requester');

select * from finish();
rollback;

-- pgTAP: migration 2742 (R11), advancing notices. Each kind fires on its event, to the right people and never to the
-- person who acted: advance_submission.returned to the recipient's people; submittal.returned to the vendor's Owner and
-- Advancing Lead, not an unassigned Account Member; roster_entry.removed and roster_entry.facts_requested to the person;
-- roster_entry.share_revoked to the project's packet readers; credential.revoked to the holder. A rostered person who
-- is no account member gets Email and Push deliveries through private.party_org_ids, which keeps A127's open-offer
-- branch beside R4's roster branch.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql

select no_plan();

create function pg_temp.told(p_who text, p_kind text, p_subject text) returns integer
language sql as $$
  select count(*)::int from app.notifications n
  where n.recipient_person_id = pg_temp.id(p_who) and n.kind = p_kind and n.subject_id = pg_temp.id(p_subject)
$$;

-- advance_submission.returned ------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
with p as (insert into app.advance_packets (project_id, title, due_at) values (pg_temp.id('prj_a'), 'Production Advance', now() + interval '9 days') returning id)
insert into world select 'pkt', id from p;
with s as (insert into app.advance_sections (advance_packet_id, position, title) values (pg_temp.id('pkt'), 1, 'Power') returning id)
insert into world select 's_power', id from s;
with r as (insert into app.advance_recipients (advance_packet_id, counterparty_id, engagement_id)
  values (pg_temp.id('pkt'), pg_temp.id('cp_v_a'), pg_temp.id('eng_vendor_a')) returning id)
insert into world select 'rcp_v', id from r;
select app.send_advance_packet(pg_temp.id('pkt'));
select pg_temp.as_platform();
with a as (insert into app.advance_submissions (advance_section_id, advance_recipient_id, body)
  values (pg_temp.id('s_power'), pg_temp.id('rcp_v'), 'One 32 A feed.') returning id)
insert into world select 'ans', id from a;
select pg_temp.as_user('alice');
update app.advance_submissions set review_outcome = 'Returned', return_reason = 'Which stage?', reviewed_at = now(), reviewed_by = pg_temp.id('alice')
where id = pg_temp.id('ans');
select pg_temp.as_platform();
select is(pg_temp.told('victor', 'advance_submission.returned', 'ans'), 1, 'a returned answer tells the account''s Owner');
select is(pg_temp.told('pia', 'advance_submission.returned', 'ans'), 1, 'and its Advancing Lead');
select is(pg_temp.told('kai', 'advance_submission.returned', 'ans'), 0, 'not an Account Member who is not assigned');
select is(pg_temp.told('alice', 'advance_submission.returned', 'ans'), 0, 'nor the reviewer');
select is((select message_args ->> 'reason' from app.notifications where kind = 'advance_submission.returned'
  and recipient_person_id = pg_temp.id('victor')), 'Which stage?', 'with the reason');
select is((select message_args ->> 'packetTitle' from app.notifications where kind = 'advance_submission.returned'
  and recipient_person_id = pg_temp.id('victor')), 'Production Advance', 'and the packet');
select is((select count(*)::int from app.notifications where kind = 'advance_submission.returned'), 2, 'an acceptance would send nothing more');

-- submittal.returned ---------------------------------------------------------------------------------------------------------
select pg_temp.move_engagement('eng_vendor_a', 'Onboarding', 'Active');
select pg_temp.as_user('carol');
with v as (insert into app.vendors (counterparty_id) values (pg_temp.id('cp_v_a')) returning id) insert into world select 'ven', id from v;
with x as (insert into app.submittals (project_id, vendor_id, submittal_kind, title)
  values (pg_temp.id('prj_a'), pg_temp.id('ven'), 'Shop Drawing', 'Delay tower rigging plan') returning id)
insert into world select 'sub', id from x;
select pg_temp.as_user('victor');
select app.submit_engaged_submittal(pg_temp.id('sub'), 'Proposed', 'Plan attached.');
select pg_temp.as_user('bob');
select app.transition_submittal(pg_temp.id('sub'), 'Submitted', 'Returned', 'Show the bridle points.');
select pg_temp.as_platform();
select is(pg_temp.told('victor', 'submittal.returned', 'sub'), 1, 'a returned submittal tells the vendor''s Owner');
select is(pg_temp.told('pia', 'submittal.returned', 'sub'), 1, 'and the engagement''s Advancing Lead');
select is(pg_temp.told('kai', 'submittal.returned', 'sub'), 0, 'not an unassigned Account Member');
select is(pg_temp.told('mo', 'submittal.returned', 'sub'), 0, 'nor one assigned only as Member');
select is(pg_temp.told('bob', 'submittal.returned', 'sub'), 0, 'nor the reviewer');
select is((select message_args ->> 'reason' from app.notifications where kind = 'submittal.returned'
  and recipient_person_id = pg_temp.id('victor')), 'Show the bridle points.', 'with the reason');
select ok((select message_args ->> 'gatewayPath' like '/work/engagements/%/submittals' from app.notifications
  where kind = 'submittal.returned' and recipient_person_id = pg_temp.id('victor')), 'opening the Submittals tab');

-- roster_entry.facts_requested and roster_entry.removed --------------------------------------------------------------------------
select pg_temp.as_user('carol');
select app.review_roster_entry(pg_temp.id('e_kai'), 'Accepted');
select pg_temp.as_platform();
select is(pg_temp.told('kai', 'roster_entry.facts_requested', 'e_kai'), 1,
  'accepted by both sides with uniforms, travel and parking offered and nothing entered, the person is asked');
select is((select message_args ->> 'kind' from app.notifications where kind = 'roster_entry.facts_requested'
  and subject_id = pg_temp.id('e_kai')), 'several', 'for the several facts missing');
select is(pg_temp.told('carol', 'roster_entry.facts_requested', 'e_kai'), 0, 'the reviewer is not asked');

select pg_temp.as_user('victor');
select app.withdraw_roster_entry(pg_temp.id('e_una'), 'Not touring this leg.');
select pg_temp.as_platform();
select is(pg_temp.told('una', 'roster_entry.removed', 'e_una'), 1, 'a withdrawn entry tells its person');
select is(pg_temp.told('victor', 'roster_entry.removed', 'e_una'), 0, 'not the one who withdrew it');

-- roster_entry.share_revoked ------------------------------------------------------------------------------------------------------
select pg_temp.as_user('kai');
insert into world select 'share_kai', app.share_work_details(pg_temp.id('eng_vendor_a'), array['Dietary Needs']::app.work_detail_category[]);
select app.revoke_work_detail_share(pg_temp.id('share_kai'));
select pg_temp.as_platform();
select is(pg_temp.told('alice', 'roster_entry.share_revoked', 'e_kai'), 1, 'a revoked share tells the project''s packet readers');
select is(pg_temp.told('kai', 'roster_entry.share_revoked', 'e_kai'), 0, 'not the person who revoked it');
select is(pg_temp.told('hops', 'roster_entry.share_revoked', 'e_kai'), 0, 'nor a member who does not read packets');
select ok((select count(*) from app.notifications where kind = 'roster_entry.share_revoked') <= 50, 'at most 50 are told');

-- credential.revoked --------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with c as (insert into app.credential_categories (project_id, code, name) values (pg_temp.id('prj_a'), 'CREW', 'Crew') returning id)
insert into world select 'cat', id from c;
with c as (insert into app.credentials (credential_category_id, holder_person_id, engagement_id)
  values (pg_temp.id('cat'), pg_temp.id('ivy'), pg_temp.id('eng_ivy_a')) returning id)
insert into world select 'cred_ivy', id from c;
with c as (insert into app.credentials (credential_category_id, holder_person_id)
  values (pg_temp.id('cat'), pg_temp.id('frank')) returning id)
insert into world select 'cred_frank', id from c;
update app.credentials set revoked_at = now() where id in (pg_temp.id('cred_ivy'), pg_temp.id('cred_frank'));
select pg_temp.as_platform();
select is(pg_temp.told('ivy', 'credential.revoked', 'cred_ivy'), 1, 'a revoked engagement credential tells its holder');
select is((select message_args ->> 'title' from app.notifications where kind = 'credential.revoked'
  and subject_id = pg_temp.id('cred_ivy')), 'Crew', 'naming the category');
select is(pg_temp.told('frank', 'credential.revoked', 'cred_frank'), 0, 'a credential under no engagement or allocation sends nothing');

-- External delivery ---------------------------------------------------------------------------------------------------------------
select pg_temp.new_user('nell', 'nell@touring.test', 'Nell Okafor');
select pg_temp.as_user('victor');
insert into world select 'e_nell', app.invite_to_roster(pg_temp.id('eng_vendor_a'), 'nell@touring.test');
select pg_temp.as_user('nell');
select app.respond_party_invitation('roster', (select i.invitation_id from app.my_pending_invitations() i where i.invitation_kind = 'roster'), true);
select pg_temp.as_user('victor');
select app.withdraw_roster_entry(pg_temp.id('e_nell'), 'Booked elsewhere.');
select pg_temp.as_platform();
select ok(pg_temp.id('org_a') in (select private.party_org_ids(pg_temp.id('kai'))), 'an account member is an external party of the producing org');
select is(pg_temp.told('nell', 'roster_entry.removed', 'e_nell'), 1, 'a rostered person who is no account member is told');
select ok(exists (select 1 from app.notification_deliveries d join app.notifications n on n.id = d.notification_id
  where n.kind = 'roster_entry.removed' and n.recipient_person_id = pg_temp.id('nell') and d.channel = 'Email'),
  'that rostered person gets an Email delivery');
select ok(exists (select 1 from app.notification_deliveries d join app.notifications n on n.id = d.notification_id
  where n.kind = 'roster_entry.removed' and n.recipient_person_id = pg_temp.id('nell') and d.channel = 'Push'),
  'and a Push delivery');
select ok(exists (select 1 from pg_catalog.pg_proc where proname = 'party_org_ids'
  and pg_get_functiondef(oid) like '%app.applications%' and pg_get_functiondef(oid) like '%app.engagement_roster_entries%'),
  'party_org_ids keeps both the open-offer and the roster branches');

select * from finish();
rollback;

-- pgTAP: migration 6525 (B10, G-132), pool invitations and standing rates. One email per invitation, never naming the pool;
-- pending per pool and email; a rate only with payroll; declined addresses and the daily cap; claiming by confirmed email;
-- masked reads; party orgs; audit redaction; account deletion.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select no_plan();

create function pg_temp.refusal(p_sql text) returns text
language plpgsql as $$
declare
  v_hint text;
begin
  execute p_sql;
  return null;
exception when sqlstate 'XR001' then
  get stacked diagnostics v_hint = pg_exception_hint;
  return v_hint;
end $$;
grant execute on function pg_temp.refusal(text) to public;

create function pg_temp.emails(p_to text) returns integer
language sql security definer as $$ select count(*)::int from private.platform_emails e where e.to_email = p_to and e.template = 'party_invitation' $$;
grant execute on function pg_temp.emails(text) to public;

select pg_temp.new_user('rae', 'rae@freelance.test', 'Rae Sandoval');
select pg_temp.new_user('liam', 'liam@freelance.test', 'Liam Porter');
select pg_temp.new_user('ned', 'ned@freelance.test', 'Ned Vargas');

select pg_temp.as_user('carol');
with p as (insert into app.talent_pools (org_id, name, pool_kind) values (pg_temp.id('org_a'), 'Secret Stagehands', 'Talent') returning id) insert into world select 'pool', id from p;
with p as (insert into app.talent_pools (org_id, name, pool_kind) values (pg_temp.id('org_a'), 'Audio Vendors', 'Vendor') returning id) insert into world select 'vpool', id from p;

-- Inviting ---------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select throws_ok(format($$select app.invite_to_talent_pool('%s', 'rae@freelance.test')$$, pg_temp.id('pool')), '42501', null, 'inviting needs opportunities.pool.write');
select pg_temp.as_user('alice');
select is(pg_temp.refusal(format($$select app.invite_to_talent_pool('%s', 'not-an-email')$$, pg_temp.id('pool'))), 'invitation_email', 'a bad address is refused');
select is(pg_temp.refusal(format($$select app.invite_to_talent_pool('%s', 'rae@freelance.test')$$, pg_temp.id('vpool'))), 'pool_invitation_pool', 'a Vendor pool is refused');
select is(pg_temp.refusal(format($$select app.invite_to_talent_pool('%s', 'rae@freelance.test', p_work_phone => '555')$$, pg_temp.id('pool'))), 'pool_invitation_phone', 'a phone that is not E.164 is refused');
insert into world select 'inv_rae', app.invite_to_talent_pool(pg_temp.id('pool'), 'Rae@Freelance.test', 'Rae S', '+13105550100', '5000.51.02', 'Day', 125000, 'USD', 'Great rigger.');
select is(pg_temp.emails('rae@freelance.test'), 1, 'exactly one party_invitation email is queued');
select pg_temp.as_platform();
select is((select e.args ->> 'kind' from private.platform_emails e where e.to_email = 'rae@freelance.test'), 'pool', 'of kind pool');
select ok((select e.args::text not like '%Secret Stagehands%' and e.args::text not like '%' || pg_temp.id('pool') || '%' from private.platform_emails e where e.to_email = 'rae@freelance.test'), 'whose args name no pool');
select is((select e.args ->> 'org_id' from private.platform_emails e where e.to_email = 'rae@freelance.test'), pg_temp.id('org_a')::text,
  'and name the inviting org, so the email wears its brand while white label is in force (904090003)');
select is((select e.args ->> 'org_name' from private.platform_emails e where e.to_email = 'rae@freelance.test'), 'Northwind Live', 'and name the org');
select pg_temp.as_user('alice');
select is(pg_temp.refusal(format($$select app.invite_to_talent_pool('%s', 'rae@freelance.test')$$, pg_temp.id('pool'))), 'pool_invitation_duplicate', 'a second pending invitation is refused');
select pg_temp.as_platform();
update app.talent_pool_invitations set expires_at = now() - interval '1 day' where id = pg_temp.id('inv_rae');
select pg_temp.as_user('alice');
select is(pg_temp.refusal(format($$select app.invite_to_talent_pool('%s', 'rae@freelance.test')$$, pg_temp.id('pool'))), 'pool_invitation_duplicate', 'an expired one counts too');
select pg_temp.as_platform();
delete from private.platform_emails where to_email = 'rae@freelance.test';
select pg_temp.as_user('alice');
select app.reissue_pool_invitation(pg_temp.id('inv_rae'));
select is(pg_temp.emails('rae@freelance.test'), 1, 'a reissue that moves the expiry later queues one new email');
select pg_temp.as_user('carol');
-- The seed gives a Manager pool write but not payroll.
select is(pg_temp.refusal(format($$select app.invite_to_talent_pool('%s', 'liam@freelance.test', p_rate_type => 'Day', p_rate_minor => 1000, p_currency_code => 'USD')$$, pg_temp.id('pool'))),
  'pool_rate_not_permitted', 'a rate from a caller without payroll is refused');

-- Reading and masking --------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select results_eq(format($$select rate_minor, is_masked, pool_name, invitation_status from app.talent_pool_invitation_list where id = '%s'$$, pg_temp.id('inv_rae')),
  $$values (125000::bigint, false, 'Secret Stagehands'::text, 'Pending'::text)$$, 'a payroll holder reads the rate');
select pg_temp.as_user('carol');
select results_eq(format($$select rate_minor, is_masked from app.talent_pool_invitation_list where id = '%s'$$, pg_temp.id('inv_rae')),
  $$values (null::bigint, true)$$, 'a pool manager without payroll reads it masked');
select throws_ok($$select rate_minor from app.talent_pool_invitations$$, '42501', null, 'the rate is not directly selectable');
select throws_ok($$select rate_minor from app.pool_member_rates$$, '42501', null, 'in either table');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.talent_pool_invitation_list), 0, 'a Member, who holds application read only, reads no contact details in the list');
select is((select count(*)::int from app.talent_pool_invitations), 0, 'nor in the table');
select pg_temp.as_platform();
select is((select c.classification::text from private.column_classifications c where c.table_name = 'app.talent_pool_invitations' and c.column_name = 'rate_minor'), 'Restricted', 'the invitation''s rate is classified Restricted');
select is((select c.classification::text from private.column_classifications c where c.table_name = 'app.pool_member_rates' and c.column_name = 'rate_minor'), 'Restricted', 'and the member''s');
select ok(not has_table_privilege('xos_backup', 'app.talent_pool_invitation_list', 'select') and not has_table_privilege('xos_backup', 'app.pool_member_rate_list', 'select')
  and not has_table_privilege('xos_backup', 'app.pool_member_names', 'select'), 'xos_backup can select none of the three views');

-- Claiming ---------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('ned');
select is((select count(*)::int from app.my_pending_invitations() i where i.invitation_id = pg_temp.id('inv_rae')), 0, 'someone else does not see the invitation');
select is(pg_temp.refusal(format($$select app.respond_party_invitation('pool', '%s', true)$$, pg_temp.id('inv_rae'))), 'invitation_not_yours', 'and cannot answer it');
select pg_temp.as_user('rae');
select results_eq(format($$select invitation_kind, org_name, job_title is not null from app.my_pending_invitations() where invitation_id = '%s'$$, pg_temp.id('inv_rae')),
  $$values ('pool'::text, 'Northwind Live'::text, true)$$, 'the confirmed invited email sees the pool invitation with the org and the role');
insert into world select 'member_rae', app.respond_party_invitation('pool', pg_temp.id('inv_rae'), true);
select pg_temp.as_platform();
select is((select m.standing::text from app.pool_members m where m.id = pg_temp.id('member_rae')), 'Approved', 'accepting creates an Approved member');
select results_eq(format($$select rate_minor, currency_code::text from app.pool_member_rates where pool_member_id = '%s'$$, pg_temp.id('member_rae')), $$values (125000::bigint, 'USD'::text)$$, 'the rate is copied to the member');
select results_eq(format($$select rate_minor, invitee_name, work_phone, claimed_person_id = '%s' from app.talent_pool_invitations where id = '%s'$$, pg_temp.id('rae'), pg_temp.id('inv_rae')),
  $$values (null::bigint, null::text, null::text, true)$$, 'then the invitation''s rate, label and phone are cleared');
select pg_temp.as_user('rae');
select is(pg_temp.refusal(format($$select app.respond_party_invitation('pool', '%s', true)$$, pg_temp.id('inv_rae'))), 'invitation_closed', 'an answered invitation is closed');
select pg_temp.as_user('carol');
select ok(exists (select 1 from app.pool_member_names n where n.pool_member_id = pg_temp.id('member_rae') and n.full_name = 'Rae Sandoval'), 'a member who joined by claim is named to a pool reader');
select results_eq(format($$select rate_minor, is_masked from app.pool_member_rate_list where pool_member_id = '%s'$$, pg_temp.id('member_rae')), $$values (null::bigint, true)$$, 'and the member''s rate is masked without payroll');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.pool_member_names n where n.pool_member_id = pg_temp.id('member_rae')), 0, 'and to no one else');

-- A standing and a rate are kept.
select pg_temp.as_user('alice');
with m as (insert into app.pool_members (talent_pool_id, person_id, standing) values (pg_temp.id('pool'), pg_temp.id('liam'), 'Preferred') returning id) insert into world select 'm_liam', id from m;
select app.set_pool_member_rate(pg_temp.id('m_liam'), 'Hourly', 4000, 'USD');
insert into world select 'inv_liam', app.invite_to_talent_pool(pg_temp.id('pool'), 'liam@freelance.test', p_rate_type => 'Day', p_rate_minor => 90000, p_currency_code => 'USD');
select pg_temp.as_user('liam');
select app.respond_party_invitation('pool', pg_temp.id('inv_liam'), true);
select pg_temp.as_platform();
select is((select m.standing::text from app.pool_members m where m.id = pg_temp.id('m_liam')), 'Preferred', 'accepting keeps a standing');
select is((select r.rate_minor from app.pool_member_rates r where r.pool_member_id = pg_temp.id('m_liam') and r.deleted_at is null), 4000::bigint, 'and a rate');
select is((select i.rate_minor from app.talent_pool_invitations i where i.id = pg_temp.id('inv_liam')), null::bigint, 'and still clears the invitation''s copy');

-- Declining, and not inviting again --------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into world select 'inv_ned', app.invite_to_talent_pool(pg_temp.id('pool'), 'ned@freelance.test');
select pg_temp.as_user('ned');
select app.respond_party_invitation('pool', pg_temp.id('inv_ned'), false);
select pg_temp.as_platform();
select ok((select declined_at is not null from app.talent_pool_invitations where id = pg_temp.id('inv_ned')), 'declining sets declined_at');
select pg_temp.as_user('alice');
select is(pg_temp.refusal(format($$select app.invite_to_talent_pool('%s', 'ned@freelance.test')$$, pg_temp.id('pool'))), 'pool_invitation_declined', 'someone who declined is not invited again');
select pg_temp.as_platform();
update app.talent_pool_invitations set declined_at = now() - interval '13 months' where id = pg_temp.id('inv_ned');
select pg_temp.as_user('alice');
select lives_ok(format($$select app.invite_to_talent_pool('%s', 'ned@freelance.test')$$, pg_temp.id('pool')), 'after 12 months they can be');

-- Revoking, expiry and Do Not Engage -----------------------------------------------------------------------------------------------------
insert into world select 'inv_q', app.invite_to_talent_pool(pg_temp.id('pool'), 'quinn@freelance.test');
insert into app.pool_members (talent_pool_id, person_id, standing, reason, review_on) values (pg_temp.id('pool'), pg_temp.id('quinn'), 'Do Not Engage', 'Fixture.', '2027-12-31');
select pg_temp.as_user('quinn');
select is(pg_temp.refusal(format($$select app.respond_party_invitation('pool', '%s', true)$$, pg_temp.id('inv_q'))), 'invitation_closed', 'a Do Not Engage person reads it closed');
select pg_temp.as_user('alice');
insert into world select 'inv_sam', app.invite_to_talent_pool(pg_temp.id('pool'), 'sam@bayside-audio.test');
select pg_temp.as_platform();
insert into app.org_cancellations (org_id, reason, canceled_at, read_only_until, purge_after) values (pg_temp.id('org_a'), 'Fixture.', now(), now() + interval '30 days', now() + interval '90 days');
select pg_temp.as_user('sam');
select is(pg_temp.refusal(format($$select app.respond_party_invitation('pool', '%s', true)$$, pg_temp.id('inv_sam'))), 'invitation_closed', 'a read-only org reads it closed');
select pg_temp.as_platform();
update app.org_cancellations set reactivated_at = now(), reactivated_by = pg_temp.id('alice') where org_id = pg_temp.id('org_a');
update app.talent_pool_invitations set expires_at = now() - interval '1 hour' where id = pg_temp.id('inv_sam');
select pg_temp.as_user('sam');
select is(pg_temp.refusal(format($$select app.respond_party_invitation('pool', '%s', true)$$, pg_temp.id('inv_sam'))), 'invitation_closed', 'an expired one too');
select pg_temp.as_user('alice');
select app.revoke_pool_invitation(pg_temp.id('inv_sam'));
select pg_temp.as_user('sam');
select is((select count(*)::int from app.my_pending_invitations() i where i.invitation_id = pg_temp.id('inv_sam')), 0, 'a revoked one is gone');

-- The daily cap --------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select private.note_rate_event('pool_invitation_email', pg_temp.id('org_a')::text) from generate_series(1, 2000);
select pg_temp.as_user('alice');
select is(pg_temp.refusal(format($$select app.invite_to_talent_pool('%s', 'capped@freelance.test')$$, pg_temp.id('pool'))), 'pool_invitation_daily_limit', 'an org queues at most 2000 emails in 24 hours');

-- Party orgs ------------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select ok(pg_temp.id('org_a') in (select private.party_org_ids(pg_temp.id('rae'))), 'a claimed invitation gives the party org');
select pg_temp.new_user('zed', 'zed@freelance.test', 'Zed Ortega');
insert into app.pool_members (talent_pool_id, person_id, standing) values (pg_temp.id('pool'), pg_temp.id('zed'), 'Approved');
select ok(pg_temp.id('org_a') not in (select private.party_org_ids(pg_temp.id('zed'))), 'an internally added member gains neither the org');
select ok(pg_temp.id('org_a') not in (select private.party_org_ids(pg_temp.id('quinn'))), 'nor a Do Not Engage person');
select pg_temp.as_user('alice');
with g as (insert into app.registration_pages (org_id, slug, title, talent_pool_id) values (pg_temp.id('org_a'), 'p', 'P', pg_temp.id('pool')) returning id) insert into world select 'page', id from g;
select app.transition_registration_page(pg_temp.id('page'), 'Draft', 'Open');
select pg_temp.new_user('tess', 'tess@freelance.test', 'Tess Ruiz');
select pg_temp.as_user('tess');
select app.confirm_minimum_age('Gateway');
insert into world select 'reg_tess', app.submit_crew_registration('northwind-live', 'p', '[]', true);
select pg_temp.as_platform();
select ok(pg_temp.id('org_a') in (select private.party_org_ids(pg_temp.id('tess'))), 'a registration gives the party org');
select pg_temp.as_user('tess');
select app.withdraw_crew_registration(pg_temp.id('reg_tess'));
select pg_temp.as_platform();
select ok(pg_temp.id('org_a') not in (select private.party_org_ids(pg_temp.id('tess'))), 'a Withdrawn one does not');

-- Audit redaction ---------------------------------------------------------------------------------------------------------------------------
select is(private.redact_personal_data('{"answer": "a", "invitee_name": "b", "work_phone": "c", "signed_name": "d", "kept": "e"}'::jsonb) ->> 'kept', 'e', 'other keys stay');
select ok(private.redact_personal_data('{"answer": "a"}'::jsonb) ->> 'answer' <> 'a' and private.redact_personal_data('{"invitee_name": "b"}'::jsonb) ->> 'invitee_name' <> 'b'
  and private.redact_personal_data('{"work_phone": "c"}'::jsonb) ->> 'work_phone' <> 'c' and private.redact_personal_data('{"signed_name": "d"}'::jsonb) ->> 'signed_name' <> 'd',
  'answer, invitee_name, work_phone and signed_name are redacted');

-- Account deletion ---------------------------------------------------------------------------------------------------------------------------
select ok(array['app.crew_registrations', 'app.crew_registration_answers', 'app.crew_access_links', 'app.talent_pool_invitations', 'app.pool_member_rates']::text[] <@ private.account_deletion_tables(), 'a legal hold on the new tables blocks the deletion');
select pg_temp.as_user('ned');
select app.delete_my_account('ned@freelance.test');
select pg_temp.as_user('rae');
select app.delete_my_account('rae@freelance.test');
select pg_temp.as_platform();
select is((select count(*)::int from app.talent_pool_invitations i where i.id = pg_temp.id('inv_rae')), 0, 'a claimed invitation is removed');
select is((select count(*)::int from app.talent_pool_invitations i where i.email = 'ned@freelance.test'), 0, 'unanswered and declined invitations for the address are removed');
select is((select count(*)::int from app.pool_member_rates r where r.pool_member_id = pg_temp.id('member_rae')), 0, 'the member''s rate is removed');
select ok(exists (select 1 from app.dsar_requests d where d.org_id = pg_temp.id('org_a') and d.subject_person_id = pg_temp.id('rae') and d.request_type = 'Erasure'), 'an Erasure row is recorded');

select * from finish();
rollback;

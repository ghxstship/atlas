-- pgTAP: the org blocklist of email addresses and domains (B16, 3050; Section 4.8.1, ADR 0155 D3). Every path that
-- adds a person to an org refuses a blocked address; current members stay.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(64);

create function pg_temp.as_service() returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('role', 'service_role', true);
end $$;

create temporary table k (key text primary key, id uuid, txt text);
grant select, insert, update on k to public;

-- Writing the list ------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$select * from app.add_blocklist_entry(pg_temp.id('org_a'), 'Domain', 'blocked.test')$$, '42501', null,
  'a Member without org.members.manage cannot add an entry');
select pg_temp.as_user('bob');
insert into k (key, id, txt) select 'example', b.entry_id, b.invites_revoked || '/' || b.requests_declined || '/' || b.members_matching
from app.add_blocklist_entry(pg_temp.id('org_a'), 'Domain', ' @Example.COM ', 'Spam sign-ups') b;
select is((select entry_kind::text || ' ' || entry_value || ' ' || reason from app.member_blocklist_entries where id = (select id from k where key = 'example')),
  'Domain example.com Spam sign-ups', 'the value is lowercased and trimmed, without a leading @');
select is((select txt from k where key = 'example'), '0/0/0', 'with nothing to revoke, decline or count');
select is((select count(*)::integer from app.member_blocklist_entries), 1, 'an admin holding org.members.manage reads the list');
select pg_temp.as_user('dave');
select is((select count(*)::integer from app.member_blocklist_entries), 0, 'a Member reads none of it');
select throws_ok($$select * from app.member_blocklist(pg_temp.id('org_a'))$$, '42501', null, 'nor through the RPC');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.member_blocklist_entries), 0, 'another org reads none of it');
select pg_temp.as_user('bob');
select throws_ok($$insert into app.member_blocklist_entries (org_id, entry_kind, entry_value) values (pg_temp.id('org_a'), 'Email', 'x@y.test')$$,
  '42501', null, 'a direct insert is refused');
select is((select count(*)::integer from (update app.member_blocklist_entries set reason = 'x' returning 1) u), 0,
  'a direct update changes nothing');
select throws_ok($$select * from app.add_blocklist_entry(pg_temp.id('org_a'), 'Email', 'not an address')$$, 'XR001',
  'blocklist_value_invalid: Enter an email address such as name@example.com, or a domain such as example.com.', 'a malformed address is refused');
select throws_ok($$select * from app.add_blocklist_entry(pg_temp.id('org_a'), 'Domain', 'localhost')$$, 'XR001', null, 'a domain needs a dot');
select throws_ok($$select * from app.add_blocklist_entry(pg_temp.id('org_a'), 'Domain', '*.spam.test')$$, 'XR001', null, 'a wildcard is refused');
select throws_ok($$select * from app.add_blocklist_entry(pg_temp.id('org_a'), 'Domain', 'service.xos.invalid')$$, 'XR001', null,
  'a .invalid domain is refused');
select throws_ok($$select * from app.add_blocklist_entry(pg_temp.id('org_a'), 'Domain', 'EXAMPLE.com')$$, 'XR001',
  'blocklist_duplicate: This address or domain is already on the blocklist.', 'a duplicate is refused, ignoring case');

-- The org's own verified domain cannot be blocked; one address inside it can.
select pg_temp.as_user('alice');
insert into app.org_domains (org_id, hostname, purpose, auto_join_role_id)
values (pg_temp.id('org_a'), 'crew.harbor.test', 'Verified Domain', pg_temp.system_role('member'));
select pg_temp.as_service();
select app.record_domain_verification((select id from app.org_domains where hostname = 'crew.harbor.test'), true);
select pg_temp.as_user('bob');
select throws_ok($$select * from app.add_blocklist_entry(pg_temp.id('org_a'), 'Domain', 'crew.harbor.test')$$, 'XR001',
  'blocklist_own_domain: This domain is, or contains, one of the organization''s verified domains. Block single addresses there instead.',
  'a verified domain is refused');
select throws_ok($$select * from app.add_blocklist_entry(pg_temp.id('org_a'), 'Domain', 'harbor.test')$$, 'XR001', null,
  'and so is its parent');
select lives_ok($$insert into k (key, id) select 'rogue_addr', b.entry_id from app.add_blocklist_entry(pg_temp.id('org_a'), 'Email', 'Rogue@crew.harbor.test') b$$,
  'one address inside a verified domain may be blocked');

-- The 1000 limit.
select pg_temp.as_platform();
insert into app.member_blocklist_entries (org_id, entry_kind, entry_value)
select pg_temp.id('org_a'), 'Email', 'filler' || g || '@filler.test' from generate_series(1, 998) g;
select pg_temp.as_user('bob');
select throws_ok($$select * from app.add_blocklist_entry(pg_temp.id('org_a'), 'Domain', 'one-more.test')$$, 'XR001',
  'blocklist_full: A blocklist holds at most 1,000 entries. Remove some, or block a domain instead of its addresses.',
  'a 1,001st live entry is refused');
select pg_temp.as_platform();
update app.member_blocklist_entries set deleted_at = now() where entry_value like 'filler%';

-- Matching -------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select ok(private.blocklist_matches('Domain', 'blocked.test', 'Ivan@Sub.Blocked.TEST'), 'a Domain entry matches a subdomain, ignoring case');
select ok(not private.blocklist_matches('Domain', 'blocked.test', 'ivan@notblocked.test'), 'but not a domain that merely ends the same way');
select ok(private.blocklist_matches('Email', 'jo@blocked.test', ' JO@blocked.test '), 'an Email entry matches the address, ignoring case');
select ok(not private.blocklist_matches('Email', 'jo@blocked.test', 'jo2@blocked.test'), 'and only that address');

-- Adding an entry revokes matching invitations and declines matching requests --------------------------------------
select pg_temp.new_user('ivan', 'ivan@sub.blocked.test', 'Ivan Petrov');
select pg_temp.new_user('jo', 'jo@blocked.test', 'Jo Marsh');
select pg_temp.new_user('kim', 'kim@other.test', 'Kim Soto');
select pg_temp.as_user('bob');
insert into k (key, txt) select 'jo_token', i.invite_token from app.invite_member(pg_temp.id('org_a'), 'jo@blocked.test', pg_temp.system_role('member')) i;
select app.invite_member(pg_temp.id('org_a'), 'ivan@sub.blocked.test', pg_temp.system_role('member'));
select app.invite_member(pg_temp.id('org_a'), 'kim@other.test', pg_temp.system_role('member'));
select pg_temp.as_user('alice');
select app.ensure_organization_profile(pg_temp.id('org_a'));
update app.organization_profiles set visibility = 'Public' where org_id = pg_temp.id('org_a');
select pg_temp.as_user('ivan');
insert into k (key, id) values ('ivan_request', app.request_to_join(pg_temp.id('org_a'), 'Hello.'));
select pg_temp.as_user('kim');
insert into k (key, id) values ('kim_request', app.request_to_join(pg_temp.id('org_a'), 'Hello.'));
select pg_temp.as_user('bob');
insert into k (key, id, txt) select 'blocked', b.entry_id, b.invites_revoked || '/' || b.requests_declined || '/' || b.members_matching
from app.add_blocklist_entry(pg_temp.id('org_a'), 'Domain', 'blocked.test') b;
select is((select txt from k where key = 'blocked'), '2/1/0', 'the RPC returns the revoked invitations, the declined requests and the matching members');
select is((select count(*)::integer from app.invites where org_id = pg_temp.id('org_a') and email like '%blocked.test' and revoked_at is null), 0,
  'pending invitations for the domain and its subdomains are revoked');
select ok((select revoked_at is null from app.invites where email = 'kim@other.test'), 'other invitations stay');
select is((select join_request_state::text || ' ' || (decided_by = pg_temp.id('bob'))::text from app.join_requests where id = (select id from k where key = 'ivan_request')),
  'Declined true', 'a matching pending request is declined by the admin, as decide_join_request does');
select is((select join_request_state::text from app.join_requests where id = (select id from k where key = 'kim_request')), 'Pending',
  'other requests stay pending');

-- Every join path refuses a blocked address -------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$select * from app.invite_member(pg_temp.id('org_a'), 'jo@blocked.test', pg_temp.system_role('member'))$$, '42501', null,
  'a person without org.members.invite learns nothing about the blocklist');
select pg_temp.as_user('bob');
select throws_ok($$select * from app.invite_member(pg_temp.id('org_a'), 'jo@blocked.test', pg_temp.system_role('member'))$$, 'XR001',
  'invite_blocked: This email address or its domain is on the organization''s blocklist. Remove it in Settings, Members, first.',
  'invite_member tells the inviter why');
select throws_ok($$select * from app.invite_member(pg_temp.id('org_a'), 'zed@deep.sub.blocked.test', pg_temp.system_role('member'))$$, 'XR001', null,
  'a subdomain of a blocked domain matches');

-- An invitation sent before the block (the revocation is undone here to reach accept_invite's check).
select pg_temp.as_platform();
update app.invites set revoked_at = null where email = 'jo@blocked.test';
select pg_temp.as_user('jo');
select is((select refusal || ' ' || reason from app.accept_invite((select txt from k where key = 'jo_token'))), 'REFUSE member_blocked',
  'accept_invite answers REFUSE member_blocked');
select is((select count(*)::integer from app.memberships m where m.person_id = pg_temp.id('jo')), 0, 'and creates no membership');

select pg_temp.as_user('bob');
insert into k (key, txt) select 'link', l.invite_token from app.create_invite_link(pg_temp.id('org_a'), pg_temp.system_role('viewer')) l;
select pg_temp.as_user('jo');
select throws_ok($$select app.accept_invite_link((select txt from k where key = 'link'))$$, 'XR001',
  'member_blocked: You cannot join this organization. Ask one of its administrators.', 'accept_invite_link refuses with the generic sentence');
select pg_temp.as_platform();
update auth.users set email_confirmed_at = null where id = pg_temp.id('jo_user');
select pg_temp.as_user('jo');
select throws_ok($$select app.accept_invite_link((select txt from k where key = 'link'))$$, 'XR001', null,
  'an unconfirmed address still matches');
select pg_temp.as_platform();
update auth.users set email_confirmed_at = now() where id = pg_temp.id('jo_user');

select pg_temp.as_user('jo');
select throws_ok($$select app.request_to_join(pg_temp.id('org_a'), 'Please.')$$, 'XR001',
  'member_blocked: You cannot join this organization. Ask one of its administrators.', 'request_to_join refuses with the generic sentence');

-- A request made before the block, decided after it (the decline is undone here to reach the approval).
select pg_temp.as_platform();
update app.join_requests set join_request_state = 'Pending', decided_by = null, decided_at = null where id = (select id from k where key = 'ivan_request');
select pg_temp.as_user('bob');
select throws_ok($$select app.decide_join_request((select id from k where key = 'ivan_request'), true, pg_temp.system_role('member'))$$, 'XR001',
  'member_blocked: You cannot join this organization. Ask one of its administrators.', 'approving a request refuses');

-- Automatic join for a verified domain.
select pg_temp.new_user('rogue', 'rogue@crew.harbor.test', 'Rory Gale');
select pg_temp.new_user('pat', 'pat@crew.harbor.test', 'Pat Lowe');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'security.auto_join_enabled', 'Organization', null, p_value_boolean => true);
select pg_temp.as_user('pat');
select is((select count(*)::integer from app.auto_join_offers()), 1, 'an unblocked address at the verified domain is offered the org');
select pg_temp.as_user('rogue');
select is((select count(*)::integer from app.auto_join_offers()), 0, 'auto_join_offers leaves the org out for a blocked address');
select throws_ok($$select app.join_by_verified_domain(pg_temp.id('org_a'))$$, 'XR001',
  'member_blocked: You cannot join this organization. Ask one of its administrators.', 'join_by_verified_domain refuses');

-- Single sign-on just in time, and SCIM.
select pg_temp.as_platform();
update app.subscriptions set plan_code = 'enterprise' where org_id = pg_temp.id('org_a');
select pg_temp.as_user('bob');
with p as (insert into app.identity_providers (org_id, protocol, name, auth_provider_id, default_role_id, jit_enabled, scim_enabled)
  values (pg_temp.id('org_a'), 'SAML', 'Northwind Okta', 'prov-1', pg_temp.system_role('member'), true, true) returning id)
insert into k (key, id) select 'idp', id from p;
select pg_temp.as_platform();
update auth.users set raw_app_meta_data = '{"provider": "sso:prov-1"}' where id in (pg_temp.id('rogue_user'), pg_temp.id('jo_user'));
select pg_temp.as_user('jo');
select throws_ok($$select app.join_by_sso(pg_temp.id('org_a'))$$, 'XR001',
  'member_blocked: You cannot join this organization. Ask one of its administrators.', 'join_by_sso refuses');
select throws_ok($$select * from app.join_by_sso_session()$$, 'XR001',
  'member_blocked: You cannot join this organization. Ask one of its administrators.', 'and so does join_by_sso_session, which Atlas calls');
select pg_temp.as_service();
select ok(app.scim_email_blocked((select id from k where key = 'idp'), 'Rogue@crew.harbor.test'),
  'SCIM can tell, before creating the user, that a blocked address would be refused');
select ok(not app.scim_email_blocked((select id from k where key = 'idp'), 'kim@other.test'), 'and that another would not');
select throws_ok($$select app.scim_provision((select id from k where key = 'idp'), 'okta-rogue', 'rogue@crew.harbor.test', pg_temp.id('rogue_user'), true, '{}')$$,
  'XR001', 'member_blocked: You cannot join this organization. Ask one of its administrators.', 'SCIM provisioning refuses');
select pg_temp.as_platform();
select is((select count(*)::integer from app.memberships m where m.person_id in (pg_temp.id('jo'), pg_temp.id('rogue'), pg_temp.id('ivan'))), 0,
  'no blocked person gained a membership');
select ok(not has_function_privilege('authenticated', 'app.scim_email_blocked(uuid, text)', 'execute'), 'only the service role asks SCIM''s question');

-- Existing members stay, and SCIM keeps syncing them ---------------------------------------------------------------
select pg_temp.as_user('bob');
insert into k (key, id, txt) select 'dave_block', b.entry_id, b.members_matching::text
from app.add_blocklist_entry(pg_temp.id('org_a'), 'Email', 'dave@northwind.test') b;
select ok((select valid_to is null from app.memberships where id = pg_temp.id('dave@org_a')), 'a matching member keeps their membership');
select is((select txt from k where key = 'dave_block'), '1', 'adding the entry counts the matching current member');
select is((select members_matching from app.member_blocklist(pg_temp.id('org_a')) where entry_id = (select id from k where key = 'dave_block')), 1,
  'and so does the list');
select is((select created_by_name from app.member_blocklist(pg_temp.id('org_a')) where entry_id = (select id from k where key = 'dave_block')),
  'Bob Okafor', 'the list says who added the entry');
select pg_temp.as_service();
select ok(not app.scim_email_blocked((select id from k where key = 'idp'), 'dave@northwind.test'), 'a current member is never blocked for SCIM');
select pg_temp.as_user('alice');
with g as (insert into app.scim_group_mappings (identity_provider_id, idp_group, team_id) values ((select id from k where key = 'idp'), 'crew', pg_temp.id('team_a')) returning id)
insert into k (key, id) select 'map', id from g;
select pg_temp.as_service();
select is(app.scim_provision((select id from k where key = 'idp'), 'okta-dave', 'dave@northwind.test', pg_temp.id('dave_user'), true, array['crew']),
  pg_temp.id('dave@org_a'), 'SCIM re-provisions a matching existing member');
select pg_temp.as_platform();
select is((select count(*)::integer from app.team_members where membership_id = pg_temp.id('dave@org_a') and team_id = pg_temp.id('team_a') and deleted_at is null), 1,
  'and their teams still sync');

-- Service accounts are never refused --------------------------------------------------------------------------------
select pg_temp.as_platform();
insert into app.member_blocklist_entries (org_id, entry_kind, entry_value) values (pg_temp.id('org_a'), 'Domain', 'service.xos.invalid');
select pg_temp.as_user('bob');
select lives_ok($$select app.create_service_account(pg_temp.id('org_a'), 'Ledger Export Bot', pg_temp.system_role('member'))$$,
  'a service account joins even when an entry matches its address');

-- Removing an entry reopens joining ---------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$select app.remove_blocklist_entry((select id from k where key = 'blocked'))$$, '42501', null, 'a Member cannot remove an entry');
select pg_temp.as_user('bob');
select lives_ok($$select app.remove_blocklist_entry((select id from k where key = 'blocked'))$$, 'an admin removes the domain');
select ok((select deleted_at is not null from app.member_blocklist_entries where id = (select id from k where key = 'blocked')), 'removal is a soft delete');
select pg_temp.as_user('jo');
select ok(app.accept_invite_link((select txt from k where key = 'link')) is not null, 'the same person joins once the entry is removed');
select pg_temp.as_user('bob');
select lives_ok($$select * from app.add_blocklist_entry(pg_temp.id('org_a'), 'Domain', 'blocked.test')$$, 'a removed entry can be added again');

-- Creating an org is unaffected -------------------------------------------------------------------------------------
select pg_temp.as_user('ivan');
select ok(app.create_organization('Ivan Rigging', 'ivan-rigging') is not null, 'a blocked person still creates their own org');

-- The audit trail, the classification and Trash ---------------------------------------------------------------------
select pg_temp.as_platform();
select ok(exists (select 1 from app.audit_events a where a.subject_table = 'app.member_blocklist_entries'
                  and a.subject_id = (select id from k where key = 'example')), 'adding an entry is in the audit trail');
select ok(not exists (select 1 from private.column_classifications c where c.table_name = 'app.member_blocklist_entries'),
  'entries are Internal, like invitation addresses: no classification row');
select ok(exists (select 1 from private.trash_excluded_tables where table_name = 'member_blocklist_entries'), 'the table is kept out of Trash');
select ok(exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = 'app.member_blocklist_entries'::regclass
                  and t.tgname = 't15_refuse_read_only_org'), 'and gets the read-only guard like any tenant table');

select * from finish();
rollback;

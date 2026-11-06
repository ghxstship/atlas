-- pgTAP: migration 2990 (B10, G-125), crew access links. Issuing (authority, batch, worker shape, working workers,
-- validity, one live link), hashes never readable, the anon read (only the worker's shifts, no Draft, no rate), the
-- token lockout and refusals, the one write and its ledger, closing when the worker stops working or deletes their
-- account, read-only orgs, and the Atlas reads.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2750_agency_world.psql

select no_plan();

create temporary table lnk (key text primary key, link_id uuid, token text, code text, gateway_host text);
grant select, insert, update, delete on lnk to public;

create function pg_temp.issue(p_key text, p_worker jsonb, p_project text default 'prj_a', p_valid interval default interval '7 days') returns void
language plpgsql as $$
begin
  insert into lnk select p_key, i.link_id, i.token, i.access_code, i.gateway_host
  from app.issue_crew_access_links(pg_temp.id(p_project), jsonb_build_array(p_worker), p_valid) i;
end $$;
grant execute on function pg_temp.issue(text, jsonb, text, interval) to public;

create function pg_temp.tok(p_key text) returns text language sql stable as $$ select token from lnk where key = p_key $$;
create function pg_temp.code(p_key text) returns text language sql stable as $$ select code from lnk where key = p_key $$;
grant execute on function pg_temp.tok(text), pg_temp.code(text) to public;

create function pg_temp.reason(p_key text, p_code text default null) returns text
language sql as $$ select s.reason from api_public.crew_access_shifts(pg_temp.tok(p_key), coalesce(p_code, pg_temp.code(p_key))) s limit 1 $$;
grant execute on function pg_temp.reason(text, text) to public;

-- Workers: frank by membership (sh_frank_day), stella by roster entry (slot_1 placed on her), ivy by engagement, and ivy's own
-- self entry on a shift of its own.
select pg_temp.as_user('olga');
select app.assign_roster_shift(pg_temp.id('slot_1'), pg_temp.id('e_stella'));
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.as_user('carol');
select pg_temp.shift('sh_ivy', 'engagement_id', pg_temp.id('eng_ivy_a'), 9, 12);
select pg_temp.as_platform();
select private.begin_trusted_operation('roster_shift_assignment');
select pg_temp.shift('sh_ivy_self', 'roster_entry_id', pg_temp.id('self_ivy'), 13, 15);
select private.end_trusted_operation('roster_shift_assignment');
select pg_temp.as_user('carol');
select pg_temp.shift('sh_ivy_draft', 'engagement_id', pg_temp.id('eng_ivy_a'), 20, 21);
select app.publish_shifts(array[pg_temp.id('sh_ivy'), pg_temp.id('sh_ivy_self')]);

-- Issuing -------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select throws_ok(format($$select * from app.issue_crew_access_links('%s', '[{"membership_id": "%s"}]')$$, pg_temp.id('prj_a'), pg_temp.id('frank@org_a')),
  '42501', null, 'a caller without crew.shift.write gets 42501');

select pg_temp.as_user('carol');
select pg_temp.issue('frank', jsonb_build_object('membership_id', pg_temp.id('frank@org_a')));
select ok(pg_temp.tok('frank') ~ '^xcrw_[0-9a-f]{64}$', 'the token is xcrw_ and 64 hex');
select ok(pg_temp.code('frank') ~ '^[0-9]{6}$', 'the code has 6 digits');
select is((select gateway_host from lnk where key = 'frank'), null, 'an org with no verified custom Gateway domain returns no host');
select throws_ok($$select token_hash from app.crew_access_links$$, '42501', null, 'signed-in callers cannot select the token hash');
select throws_ok($$select access_code_hash from app.crew_access_links$$, '42501', null, 'signed-in callers cannot select the code hash');
select pg_temp.as_platform();
select is((select l.token_hash from app.crew_access_links l where l.id = (select link_id from lnk where key = 'frank')),
  extensions.digest(pg_temp.tok('frank'), 'sha256'), 'only the SHA-256 of the token is stored');
select is((select l.access_code_hash from app.crew_access_links l where l.id = (select link_id from lnk where key = 'frank')),
  extensions.digest(pg_temp.tok('frank') || ':' || pg_temp.code('frank'), 'sha256'), 'and the SHA-256 of token:code');

select pg_temp.as_user('carol');
select is(pg_temp.refusal(format($$select * from app.issue_crew_access_links('%s', '[]')$$, pg_temp.id('prj_a'))), 'crew_access_batch', 'no workers is refused');
select is(pg_temp.refusal(format($$select * from app.issue_crew_access_links('%s', (select jsonb_agg(jsonb_build_object('membership_id', '%s')) from generate_series(1, 201)))$$, pg_temp.id('prj_a'), pg_temp.id('frank@org_a'))),
  'crew_access_batch', '201 workers is refused');
select is(pg_temp.refusal(format($$select * from app.issue_crew_access_links('%s', '[{}]')$$, pg_temp.id('prj_a'))), 'crew_access_worker', 'zero worker columns is refused');
select is(pg_temp.refusal(format($$select * from app.issue_crew_access_links('%s', '[{"membership_id": "%s", "engagement_id": "%s"}]')$$, pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), pg_temp.id('eng_ivy_a'))),
  'crew_access_worker', 'two worker columns are refused');
select is(pg_temp.refusal(format($$select * from app.issue_crew_access_links('%s', '[{"membership_id": "%s"}]')$$, pg_temp.id('prj_a'), pg_temp.id('gina@org_a'))),
  'crew_access_not_working', 'a member with no live Published or Accepted shift is refused');
select is(pg_temp.refusal(format($$select * from app.issue_crew_access_links('%s', '[{"engagement_id": "%s"}]')$$, pg_temp.id('prj_a'), pg_temp.id('eng_agency'))),
  'crew_access_not_working', 'an agency slot resolves to nobody and is refused');
select is(pg_temp.refusal(format($$select * from app.issue_crew_access_links('%s', '[{"membership_id": "%s"}]', interval '59 minutes')$$, pg_temp.id('prj_a'), pg_temp.id('frank@org_a'))),
  'crew_access_validity', '59 minutes is refused');
select is(pg_temp.refusal(format($$select * from app.issue_crew_access_links('%s', '[{"membership_id": "%s"}]', interval '31 days')$$, pg_temp.id('prj_a'), pg_temp.id('frank@org_a'))),
  'crew_access_validity', '31 days is refused');
select is(pg_temp.refusal(format($$select * from app.issue_crew_access_links('%s', '[{"membership_id": "%s"}, {"membership_id": "%s"}]')$$, pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), pg_temp.id('gina@org_a'))),
  'crew_access_not_working', 'a refused worker fails the whole call');
select is(pg_temp.reason('frank'), null, 'so frank''s link was not revoked by that call');

-- The other arms: roster, engagement and a self entry, whose person resolves through the engagement.
select pg_temp.issue('stella', jsonb_build_object('roster_entry_id', pg_temp.id('e_stella')));
select pg_temp.issue('ivy', jsonb_build_object('engagement_id', pg_temp.id('eng_ivy_a')));
select pg_temp.issue('ivy_self', jsonb_build_object('roster_entry_id', pg_temp.id('self_ivy')));
select is((select i.person_name from app.issue_crew_access_links(pg_temp.id('prj_a'), jsonb_build_array(jsonb_build_object('roster_entry_id', pg_temp.id('self_ivy')))) i),
  'Ivy Marchetti', 'a self entry issues and names its engaged person');
select is(pg_temp.reason('ivy_self'), 'crew_access_token_invalid', 'issuing again revokes the worker''s earlier live link');
delete from lnk where key = 'ivy_self';
select pg_temp.issue('ivy_self', jsonb_build_object('roster_entry_id', pg_temp.id('self_ivy')));

-- Reading --------------------------------------------------------------------------------------------------------------------
select pg_temp.as_anon();
select is((select array_agg(s.shift_id order by s.starts_at) from api_public.crew_access_shifts(pg_temp.tok('frank'), pg_temp.code('frank')) s),
  array[pg_temp.id('sh_frank_day')], 'frank reads only his own shift on the project');
select results_eq(format($$select person_name, project_name, job_title is not null, venue_name, time_zone from api_public.crew_access_shifts('%s', '%s')$$, pg_temp.tok('frank'), pg_temp.code('frank')),
  $$values ('Frank Adeyemi'::text, 'Northwind Summer Series'::text, true, 'Northwind Pier Pavilion'::text, 'America/New_York'::text)$$,
  'with the job title and the venue as text');
select is((select s.org_id from api_public.crew_access_shifts(pg_temp.tok('frank'), pg_temp.code('frank')) s limit 1), pg_temp.id('org_a'), 'and the org id for the brand scope check');
select is((select array_agg(s.shift_id order by s.starts_at) from api_public.crew_access_shifts(pg_temp.tok('stella'), pg_temp.code('stella')) s),
  array[pg_temp.id('slot_1')], 'stella reads her placed shift and no other worker''s');
select is((select array_agg(s.shift_id order by s.starts_at) from api_public.crew_access_shifts(pg_temp.tok('ivy'), pg_temp.code('ivy')) s),
  array[pg_temp.id('sh_ivy')], 'never a Draft');
select is((select array_agg(s.shift_id order by s.starts_at) from api_public.crew_access_shifts(pg_temp.tok('ivy_self'), pg_temp.code('ivy_self')) s),
  array[pg_temp.id('sh_ivy_self')], 'a self entry reads the shifts on that entry');
select is((select count(*)::int from pg_catalog.pg_proc p, unnest(p.proallargtypes, p.proargmodes, p.proargnames) as a (t, m, n)
    where p.oid = 'api_public.crew_access_shifts'::regproc and a.m = 't' and (a.n like '%rate%' or a.n like '%note%')), 0,
  'the read returns no rate and no note');
select pg_temp.as_platform();
select is((select l.open_count from app.crew_access_links l where l.id = (select link_id from lnk where key = 'frank')), 4, 'each open is counted');
update app.shifts set starts_at = now() + interval '20 days', ends_at = now() + interval '20 days 2 hours' where id = pg_temp.id('sh_ivy');
select pg_temp.as_anon();
select is((select array_agg(s.shift_id) filter (where s.shift_id is not null) from api_public.crew_access_shifts(pg_temp.tok('ivy'), pg_temp.code('ivy')) s),
  null, 'a shift more than 14 days ahead is left out');
select is((select s.person_name from api_public.crew_access_shifts(pg_temp.tok('ivy'), pg_temp.code('ivy')) s), 'Ivy Marchetti', 'and one row with no shift still names the worker');
select pg_temp.as_platform();
update app.shifts set starts_at = pg_temp.at_day(9), ends_at = pg_temp.at_day(12) where id = pg_temp.id('sh_ivy');

-- Refusals and the lockout -------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select pg_temp.as_user('olga');
select app.assign_roster_shift(pg_temp.id('slot_2'), pg_temp.id('e_theo'));
select pg_temp.as_user('carol');
select pg_temp.issue('lock', jsonb_build_object('roster_entry_id', pg_temp.id('e_theo')));
select pg_temp.as_anon();
select is(pg_temp.reason('lock', '000000x'), 'crew_access_access_code', 'a wrong code is refused');
select is(pg_temp.reason('lock', '000000x'), 'crew_access_access_code', 'twice');
select is(pg_temp.reason('lock', '000000x'), 'crew_access_access_code', 'three times');
select is(pg_temp.reason('lock', '000000x'), 'crew_access_access_code', 'four times');
select is(pg_temp.reason('lock', '000000x'), 'crew_access_token_locked', 'the fifth wrong code locks the link');
select is(pg_temp.reason('lock'), 'crew_access_token_locked', 'and the right code is then refused');
select is((select s.reason from api_public.crew_access_shifts('xcrw_unknown', '123456') s), 'crew_access_token_invalid', 'an unknown token is invalid');
select pg_temp.as_platform();
update app.crew_access_links set expires_at = now() - interval '1 minute' where id = (select link_id from lnk where key = 'ivy_self');
select pg_temp.as_anon();
select is(pg_temp.reason('ivy_self'), 'crew_access_token_expired', 'an expired link is refused');
select pg_temp.as_user('carol');
select app.revoke_crew_access_link((select link_id from lnk where key = 'ivy_self'));
select lives_ok(format($$select app.revoke_crew_access_link('%s')$$, (select link_id from lnk where key = 'ivy_self')), 'revoking twice keeps the first time');
select pg_temp.as_anon();
select is(pg_temp.reason('ivy_self'), 'crew_access_token_invalid', 'a revoked link is invalid');
select pg_temp.as_user('gina');
select throws_ok(format($$select app.revoke_crew_access_link('%s')$$, (select link_id from lnk where key = 'frank')), '42501', null, 'revoking needs crew.shift.write');

-- The one write ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_anon();
select is((select a.reason from api_public.crew_access_accept_shift(pg_temp.tok('frank'), pg_temp.code('frank'), pg_temp.id('slot_1')) a),
  'crew_access_shift_not_yours', 'another worker''s shift is refused');
select is((select a.shift_state::text from api_public.crew_access_accept_shift(pg_temp.tok('frank'), pg_temp.code('frank'), pg_temp.id('sh_frank_day')) a),
  'Accepted', 'the worker accepts their own Published shift');
select pg_temp.as_platform();
select is((select t.reason from app.shift_state_transitions t where t.shift_id = pg_temp.id('sh_frank_day') and t.to_state = 'Accepted'),
  'Accepted through a crew access link.', 'with the ledger reason');
select is((select count(*)::int from app.audit_events a where a.action = 'crew_access.shift_accepted' and a.subject_id = pg_temp.id('sh_frank_day')), 1, 'and an audit event');
select pg_temp.as_anon();
select is((select a.reason from api_public.crew_access_accept_shift(pg_temp.tok('frank'), pg_temp.code('frank'), pg_temp.id('sh_frank_day')) a),
  'crew_access_shift_state', 'an Accepted shift is refused');
select pg_temp.as_platform();
select throws_ok(format($$select private.transition_lifecycle('shift', 'app.shifts', 'shift_state', 'app.shift_state_transitions', 'shift_id', '%s', 'Accepted', 'Draft', 'Not a move.')$$, pg_temp.id('sh_frank_day')),
  'XR001', 'shift_transition_not_allowed: A shift cannot move from Accepted to Draft.', 'the rules forbid a move the link never makes');

-- Closing when the worker stops working ----------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select pg_temp.as_platform();
select private.transition_lifecycle('roster_entry', 'app.engagement_roster_entries', 'entry_state', 'app.roster_entry_state_transitions',
  'roster_entry_id', pg_temp.id('e_stella'), 'Accepted', 'Withdrawn', 'Fixture.');
select pg_temp.as_anon();
select is(pg_temp.reason('stella'), 'crew_access_not_working', 'a withdrawn roster entry closes the link');
select pg_temp.as_platform();
update app.memberships set valid_to = now() where id = pg_temp.id('frank@org_a');
select pg_temp.as_anon();
select is(pg_temp.reason('frank'), 'crew_access_not_working', 'an ended membership closes the link');

-- The Atlas reads --------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is((select l.link_status from app.crew_access_link_list l where l.id = (select link_id from lnk where key = 'stella')), 'Closed', 'a link whose worker stopped working reads Closed');
select is((select l.person_name from app.crew_access_link_list l where l.id = (select link_id from lnk where key = 'stella')), 'Stella Okafor', 'the list names a roster worker');
select is((select l.person_name from app.crew_access_link_list l where l.id = (select link_id from lnk where key = 'ivy')), 'Ivy Marchetti', 'and an engaged worker');
select is((select l.link_status from app.crew_access_link_list l where l.id = (select link_id from lnk where key = 'ivy')), 'Live', 'Live');
select is((select l.link_status from app.crew_access_link_list l where l.id = (select link_id from lnk where key = 'lock')), 'Locked', 'Locked');
select is((select l.link_status from app.crew_access_link_list l where l.id = (select link_id from lnk where key = 'ivy_self')), 'Revoked', 'Revoked');
select ok(exists (select 1 from app.crew_access_workers(pg_temp.id('prj_a')) w where w.engagement_id = pg_temp.id('eng_ivy_a') and w.person_name = 'Ivy Marchetti' and w.has_live_link),
  'an eligible worker is listed with their name and live link');
select ok(not exists (select 1 from app.crew_access_workers(pg_temp.id('prj_a')) w where w.engagement_id = pg_temp.id('eng_agency')), 'an agency slot is not');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.crew_access_link_list), 0, 'a reader without crew.shift.write reads no links');
select throws_ok(format($$select * from app.crew_access_workers('%s')$$, pg_temp.id('prj_a')), '42501', null, 'and no workers');
select pg_temp.as_platform();
select ok(not has_table_privilege('xos_backup', 'app.crew_access_link_list', 'select'), 'xos_backup cannot select the list');

-- A read-only org: reads keep working and the write refuses for anyone ---------------------------------------------------------
select pg_temp.as_user('carol');
select pg_temp.issue('ro', jsonb_build_object('roster_entry_id', pg_temp.id('e_theo')));
select pg_temp.as_platform();
insert into app.org_cancellations (org_id, reason, canceled_at, read_only_until, purge_after)
values (pg_temp.id('org_a'), 'Fixture.', now(), now() + interval '30 days', now() + interval '90 days');
select pg_temp.as_anon();
select is((select s.person_name from api_public.crew_access_shifts(pg_temp.tok('ro'), pg_temp.code('ro')) s limit 1), 'Theo Ramires', 'anon still reads on a read-only org');
select is((select a.reason from api_public.crew_access_accept_shift(pg_temp.tok('ro'), pg_temp.code('ro'), pg_temp.id('slot_2')) a),
  'crew_access_read_only', 'and anon cannot accept');
select pg_temp.as_user('gina');
select is(pg_temp.reason('ro', 'wrong-code'), 'crew_access_access_code', 'a signed-in visitor''s wrong code is counted and never raises');
select is((select a.reason from api_public.crew_access_accept_shift(pg_temp.tok('ro'), pg_temp.code('ro'), pg_temp.id('slot_2')) a),
  'crew_access_read_only', 'and a signed-in visitor cannot accept either');
select pg_temp.as_user('carol');
select is(pg_temp.refusal(format($$select * from app.issue_crew_access_links('%s', '[{"engagement_id": "%s"}]')$$, pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a'))),
  'org_read_only', 'issuing refuses a read-only org');
select pg_temp.as_platform();
update app.org_cancellations set reactivated_at = now(), reactivated_by = pg_temp.id('alice') where org_id = pg_temp.id('org_a');

-- A removed project closes the link ---------------------------------------------------------------------------------------------
select is(private.crew_access_worker_live(pg_temp.id('org_b'), pg_temp.id('prj_a'), null, pg_temp.id('eng_ivy_a'), null), false, 'a link''s org must own the project');

-- Deleting an account revokes every arm ---------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select pg_temp.shift('sh_dave', 'membership_id', pg_temp.id('dave@org_a'), 9, 12);
select app.publish_shifts(array[pg_temp.id('sh_dave')]);
select pg_temp.issue('dave', jsonb_build_object('membership_id', pg_temp.id('dave@org_a')));
select pg_temp.as_user('dave');
select app.delete_my_account('dave@northwind.test');
select pg_temp.as_user('theo');
select app.delete_my_account('theo@crestline-staffing.test');
select pg_temp.as_user('ivy');
select app.delete_my_account('ivy@freelance.test');
select pg_temp.as_anon();
select is(pg_temp.reason('dave'), 'crew_access_token_invalid', 'deleting the account revokes a membership link');
select is(pg_temp.reason('ro'), 'crew_access_token_invalid', 'a roster link on an Active engagement');
select is(pg_temp.reason('ivy'), 'crew_access_token_invalid', 'and an engagement link');

select * from finish();
rollback;

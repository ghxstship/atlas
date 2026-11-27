-- pgTAP: migration 904190901, the gated helpers (ADR 0169 work package 3, RRR-243). With every control off the three
-- helpers answer as their ungated twins. Where an organization refuses the session, the helpers leave that
-- organization out and keep the others, so a member of two organizations keeps the one whose rules the session
-- meets; a session refused as a whole keeps none. Observe refuses nothing, an organization's own mode and a support
-- override are honored, and another person's reach is never changed by the caller's session. A refused session
-- still reads the name of its organization and its own memberships, and nothing else of the refusing organization.
-- The catalog cases hold that the verdict never reaches a gated helper (the helpers cannot call themselves through
-- it), that the helpers reference no twin, and that the grants did not move.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql
\ir 904180200_session_gate_fixture.psql

select plan(52);

-- Mia is a member of Northwind Live (org_a) and a viewer of Harbor Lights Productions (org_b). The capability is one
-- both of her roles hold, so her reach can be read in both organizations.
create temporary table picked (name text primary key, value text);
grant select on picked to public;
insert into picked
select 'capability', (
  select rc.capability_code
  from app.role_capabilities rc
  join app.roles r on r.id = rc.role_id and r.org_id is null and r.code in ('member', 'viewer') and r.deleted_at is null
  where rc.deleted_at is null
  group by rc.capability_code
  having count(distinct r.code) = 2
  order by rc.capability_code
  limit 1);

create function pg_temp.cap() returns text
language sql stable as $$ select p.value from picked p where p.name = 'capability' $$;

-- The helpers under the token on the request, asked as the database owner (the private schema is closed to the
-- request roles; policies reach the helpers by their grants).
create function pg_temp.my_orgs() returns text
language sql as $$
  select pg_temp.private_text($q$select coalesce(string_agg(w.key, ',' order by w.key), '')
    from private.my_org_ids() o join world w on w.id = o and w.key like 'org\_%'$q$)
$$;

create function pg_temp.my_orgs_base() returns text
language sql as $$
  select pg_temp.private_text($q$select coalesce(string_agg(w.key, ',' order by w.key), '')
    from private.my_org_ids_base() o join world w on w.id = o and w.key like 'org\_%'$q$)
$$;

create function pg_temp.my_membership_orgs() returns text
language sql as $$
  select pg_temp.private_text($q$select coalesce(string_agg(w.key, ',' order by w.key), '')
    from private.my_membership_ids() i join app.memberships m on m.id = i join world w on w.id = m.org_id and w.key like 'org\_%'$q$)
$$;

create function pg_temp.reach(p_person text, p_org text, p_capability text default null, p_delegations boolean default true) returns text
language sql as $$
  select pg_temp.private_text(format('select private.person_capability_reach(%L, %L, %L, %L)::text',
    pg_temp.id(p_person), pg_temp.id(p_org), coalesce(p_capability, pg_temp.cap()), p_delegations))
$$;

create function pg_temp.reach_base(p_person text, p_org text, p_capability text default null) returns text
language sql as $$
  select pg_temp.private_text(format('select private.person_capability_reach_base(%L, %L, %L, true)::text',
    pg_temp.id(p_person), pg_temp.id(p_org), coalesce(p_capability, pg_temp.cap())))
$$;

create function pg_temp.has(p_org text) returns text
language sql as $$
  select pg_temp.private_text(format('select private.has_capability(%L, %L)::text', pg_temp.id(p_org), pg_temp.cap()))
$$;

create function pg_temp.orgs_with() returns text
language sql as $$
  select pg_temp.private_text(format($q$select coalesce(string_agg(w.key, ',' order by w.key), '')
    from private.orgs_with_capability(%L) o join world w on w.id = o and w.key like 'org\_%%'$q$, pg_temp.cap()))
$$;

-- What the request role itself reads through row-level security.
create function pg_temp.org_names() returns text
language sql as $$ select coalesce(string_agg(o.name, ', ' order by o.name), '') from app.organizations o $$;

create function pg_temp.own_membership_orgs() returns text
language sql as $$
  select coalesce(string_agg(w.key, ',' order by w.key), '')
  from app.memberships m join world w on w.id = m.org_id and w.key like 'org\_%'
  where m.person_id = pg_temp.id('mia')
$$;

create function pg_temp.role_rows(p_org text) returns integer
language sql as $$
  select count(*)::int from app.membership_roles mr join app.memberships m on m.id = mr.membership_id
  where m.org_id = pg_temp.id(p_org)
$$;

select pg_temp.as_platform();
select isnt(pg_temp.cap(), null, 'the world has a capability that both the member and the viewer role hold');

-- The catalog -------------------------------------------------------------------------------------------------------------------

select is((select count(*)::int from private.session_gate_config c
           where c.ended = 'off' and c.mfa = 'off' and c.lifetime = 'off' and c.idle = 'off' and c.network = 'off'), 1,
  'every control ships off: this migration switches none');
select is((select count(*)::int from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
           where r.rolname = 'authenticator' and exists (select 1 from unnest(s.setconfig) c where c like 'pgrst.db_pre_request=%')), 0,
  'and nothing is registered on the request path');
select ok((select p.prosrc ~ 'private\.session_refusal\(\) is null' and p.prosrc ~ '<> all \(array\(select private\.session_refused_org_ids\(\)\)\)'
           from pg_proc p where p.oid = 'private.my_org_ids()'::regprocedure),
  'private.my_org_ids reads the whole-session refusal and the refused set as one array');
select ok((select p.prosrc ~ 'private\.session_refusal\(\) is null' and p.prosrc ~ '<> all \(array\(select private\.session_refused_org_ids\(\)\)\)'
           from pg_proc p where p.oid = 'private.my_membership_ids()'::regprocedure),
  'private.my_membership_ids reads them the same way');
select ok((select p.prosrc ~ 'private\.session_org_refusal\(p_org_id\) is not null'
           from pg_proc p where p.oid = 'private.person_capability_reach(uuid, uuid, text, boolean)'::regprocedure),
  'private.person_capability_reach reads why the organization is closed, once');
select is_empty($$select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'private' and p.proname in ('my_org_ids', 'my_membership_ids', 'person_capability_reach')
                    and p.prosrc ~ '(my_org_ids_base|my_membership_ids_base|person_capability_reach_base|session_verdict_compute|session_verdict_store)'$$,
  'the gated helpers reference no twin and never compute or store a verdict themselves');
select ok(has_function_privilege('authenticated', 'private.my_org_ids()', 'execute')
  and has_function_privilege('service_role', 'private.my_org_ids()', 'execute')
  and has_function_privilege('authenticated', 'private.my_membership_ids()', 'execute')
  and has_function_privilege('service_role', 'private.my_membership_ids()', 'execute')
  and not has_function_privilege('anon', 'private.my_org_ids()', 'execute')
  and not has_function_privilege('anon', 'private.my_membership_ids()', 'execute')
  and not has_function_privilege('authenticated', 'private.person_capability_reach(uuid, uuid, text, boolean)', 'execute')
  and not has_function_privilege('anon', 'private.person_capability_reach(uuid, uuid, text, boolean)', 'execute'),
  'the grants of the three helpers did not move');
select ok((select p.prosecdef and p.provolatile = 's' and p.proconfig @> array['search_path=""']
           from pg_proc p where p.oid = 'private.my_org_ids()'::regprocedure)
  and (select p.prosecdef and p.provolatile = 's' and p.proconfig @> array['search_path=""']
       from pg_proc p where p.oid = 'private.my_membership_ids()'::regprocedure)
  and (select p.prosecdef and p.provolatile = 's' and p.proconfig @> array['search_path=""']
       from pg_proc p where p.oid = 'private.person_capability_reach(uuid, uuid, text, boolean)'::regprocedure),
  'they stay stable security definer functions with an empty search path');

-- The verdict must never reach a gated helper, or a helper would call itself through it once a control is on. Walk
-- every function private.session_verdict_compute reaches by name, in the schemas this repository owns.
create temporary table reached as
with recursive fns as (
  select p.oid, n.nspname || '.' || p.proname as name, p.prosrc
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('app', 'private', 'api_public', 'api_external', 'xpms') and p.prokind = 'f'
), walk (name) as (
  select 'private.session_verdict_compute'
  union
  select callee.name
  from walk w
  join fns caller on caller.name = w.name
  join fns callee on callee.name <> caller.name
    and caller.prosrc ~ ('\m' || replace(callee.name, '.', '\.') || '\s*\(')
)
select name from walk;

select ok((select count(*) from reached) > 5 and exists (select 1 from reached where name = 'private.mfa_required')
  and exists (select 1 from reached where name = 'private.break_glass_reaches_me'),
  'the walk follows the verdict into the functions it calls');
select is_empty($$select name from reached
                  where name in ('private.my_org_ids', 'private.my_membership_ids', 'private.person_capability_reach',
                                 'private.has_capability', 'private.capability_reach', 'private.orgs_with_capability',
                                 'private.project_ids_with', 'private.session_verdict', 'private.session_refusal',
                                 'private.session_refused_org_ids', 'private.session_org_refusal')$$,
  'the verdict reaches no gated helper and none of its own readers, so a helper cannot call itself through it');

-- The read policies.
select ok((select p.qual ~ 'my_org_ids_base\(\)' and p.qual !~ 'my_org_ids\(\)'
             and p.qual ~ 'orgs_with_capability\(''org\.settings\.read''' and p.qual ~ 'orgs_with_capability\(''org\.partner\.manage'''
           from pg_policies p where p.schemaname = 'app' and p.tablename = 'organizations' and p.policyname = 'organizations_read'),
  'organizations_read admits a member''s organizations through the ungated twin and keeps its two capability branches');
select ok((select p.qual ~ 'person_id = \( ?SELECT private\.current_person_id\(\)' and p.qual !~ '_base'
           from pg_policies p where p.schemaname = 'app' and p.tablename = 'memberships' and p.policyname = 'memberships_read'),
  'memberships_read admits the caller''s own memberships by person, which reads no gated helper');
select is((select count(*)::int from pg_policies p
           where (coalesce(p.qual, '') || coalesce(p.with_check, '')) ~ '(my_org_ids_base|my_membership_ids_base|person_capability_reach_base)'), 1,
  'one policy reads a twin, and no other');

-- Every control off: the helpers answer as their twins ---------------------------------------------------------------------

select pg_temp.rule('org_a', 'alice', 'security.mfa_policy', 'everyone');
select pg_temp.as_session('mia', 'aal1', interval '10 minutes');
select is(pg_temp.my_orgs(), 'org_a,org_b', 'off: a single-factor member of an organization that asks everyone to verify keeps both organizations');
select is(pg_temp.my_orgs(), pg_temp.my_orgs_base(), 'off: private.my_org_ids answers as its twin');
select is(pg_temp.my_membership_orgs(), 'org_a,org_b', 'off: and both memberships');
select is(pg_temp.reach('mia', 'org_a'), pg_temp.reach_base('mia', 'org_a'), 'off: private.person_capability_reach answers as its twin');
select isnt(pg_temp.reach('mia', 'org_a'), null, 'off: and that is a reach');
select is(pg_temp.has('org_a'), 'true', 'off: private.has_capability follows');

-- The second-factor control in observe refuses nothing -----------------------------------------------------------------------

select pg_temp.gate('mfa', 'observe');
select pg_temp.as_session('mia', 'aal1', interval '10 minutes');
select is(pg_temp.private_text('select private.session_verdict() -> ''observed'' -> 0 ->> ''reason'''), 'session_mfa_required',
  'observe: the verdict records what enforce would refuse');
select is(pg_temp.my_orgs(), 'org_a,org_b', 'observe: the helpers leave nothing out');
select isnt(pg_temp.reach('mia', 'org_a'), null, 'observe: and the reach stands');

-- Enforce: the refusing organization is left out, the other is kept ---------------------------------------------------------

select pg_temp.gate('mfa', 'enforce');
select pg_temp.as_session('mia', 'aal1', interval '10 minutes');
select is(pg_temp.org_reasons('org_a'), 'session_mfa_required', 'enforce: Northwind Live refuses the single-factor session');
select is(pg_temp.my_orgs(), 'org_b', 'enforce: private.my_org_ids keeps only the organization whose rules the session meets');
select is(pg_temp.my_orgs_base(), 'org_a,org_b', 'enforce: the twin still names both');
select is(pg_temp.my_membership_orgs(), 'org_b', 'enforce: private.my_membership_ids leaves the refusing organization''s membership out');
select is(pg_temp.reach('mia', 'org_a'), null, 'enforce: the caller has no reach in the refusing organization');
select is(pg_temp.reach('mia', 'org_a', p_delegations => false), null, 'enforce: with or without delegations');
select is(pg_temp.reach('mia', 'org_b'), pg_temp.reach_base('mia', 'org_b'), 'enforce: and the reach she holds in the other organization');
select is(pg_temp.has('org_a'), 'false', 'enforce: private.has_capability follows in the refusing organization');
select is(pg_temp.has('org_b'), 'true', 'enforce: and in the other');
select is(pg_temp.orgs_with(), (select case when pg_temp.reach_base('mia', 'org_b') = 'organization' then 'org_b' else '' end),
  'enforce: private.orgs_with_capability never names the refusing organization');
select is(pg_temp.reach('alice', 'org_a', 'org.security.write'), pg_temp.reach_base('alice', 'org_a', 'org.security.write'),
  'enforce: another person''s reach is not changed by the caller''s session');
select isnt(pg_temp.reach('alice', 'org_a', 'org.security.write'), null, 'enforce: the Owner''s reach is still read as a reach');

-- What the refused session reads through row-level security.
select is(pg_temp.org_names(), 'Harbor Lights Productions, Northwind Live',
  'enforce: a refused session still reads the name of the organization that refuses it');
select is(pg_temp.own_membership_orgs(), 'org_a,org_b', 'enforce: and its own memberships in both');
select is(pg_temp.role_rows('org_a'), 0, 'enforce: it reads no role assignment of the refusing organization, not even its own');
select ok(pg_temp.role_rows('org_b') > 0, 'enforce: and still reads its own in the other organization');
select results_eq($$select org_name, closed, reason from app.my_session_gate() order by org_name$$,
  $$values ('Harbor Lights Productions', false, null::text), ('Northwind Live', true, 'session_mfa_required')$$,
  'enforce: app.my_session_gate names the closed organization and why');

-- A session that meets the rule keeps everything.
select pg_temp.as_session('mia', 'aal2', interval '10 minutes');
select is(pg_temp.my_orgs(), 'org_a,org_b', 'enforce: a second-factor session keeps both organizations');
select isnt(pg_temp.reach('mia', 'org_a'), null, 'enforce: and its reach in both');

-- An organization's own mode, and a support override ---------------------------------------------------------------------------

select pg_temp.as_platform();
select pg_temp.gate('mfa', 'off');
select pg_temp.gate_org('org_a', 'mfa', 'enforce');
select pg_temp.as_session('mia', 'aal1', interval '10 minutes');
select is(pg_temp.my_orgs(), 'org_b', 'an organization''s own mode enforces for that organization while the global mode is off');
select pg_temp.as_platform();
insert into private.session_gate_overrides (org_id, control, actor, reason, expires_at)
values (pg_temp.id('org_a'), 'mfa', 'support: pgTAP', 'Every Owner lost their authenticator during the tour.', now() + interval '2 hours');
select pg_temp.as_session('mia', 'aal1', interval '10 minutes');
select is(pg_temp.my_orgs(), 'org_a,org_b', 'a support override suspends the control, and the helpers admit the organization again');
select pg_temp.as_platform();
update private.session_gate_overrides set ended_at = now();
select pg_temp.gate_org('org_a', 'mfa', null);

-- A session refused as a whole keeps nothing -----------------------------------------------------------------------------------

select pg_temp.gate('ended', 'enforce');
select pg_temp.as_session('mia', 'aal2', interval '10 minutes', p_row => false);
select is(pg_temp.private_text('select private.session_refusal()'), 'session_ended', 'signed out: the session is refused as a whole');
select is(pg_temp.my_orgs(), '', 'signed out: private.my_org_ids answers nothing');
select is(pg_temp.my_membership_orgs(), '', 'signed out: private.my_membership_ids answers nothing');
select is(pg_temp.reach('mia', 'org_b'), null, 'signed out: the caller has no reach anywhere');
select is(pg_temp.org_names(), 'Harbor Lights Productions, Northwind Live',
  'signed out: the organizations can still be named, for the page that says the session ended');

-- Tokens the verdict skips ---------------------------------------------------------------------------------------------------------

select pg_temp.as_platform();
select pg_temp.gate_all('enforce');
select set_config('request.jwt.claims', '{"role": "service_role"}', true);
select is(pg_temp.reach('alice', 'org_a', 'org.security.write'), pg_temp.reach_base('alice', 'org_a', 'org.security.write'),
  'service_role: a worker reads a person''s reach with every control in enforce');
select pg_temp.as_platform();
select is(pg_temp.reach('alice', 'org_a', 'org.security.write'), pg_temp.reach_base('alice', 'org_a', 'org.security.write'),
  'no token: and so does a job');
select pg_temp.gate_all('off');
select pg_temp.as_session('mia', 'aal1', interval '10 minutes', p_row => false);
select is(pg_temp.my_orgs(), 'org_a,org_b', 'every control off again: the helpers answer as before, whatever the session');

select * from finish();
rollback;

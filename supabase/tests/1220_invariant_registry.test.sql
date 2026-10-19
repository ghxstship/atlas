-- pgTAP: Section 18 gate 4, Section 7.5 invariant traceability (A54, RRR-99). The registry holds the 24 invariants with
-- the codes assertions name (packages/testing/test/invariant-coverage.test.ts checks that each code is named by an
-- assertion). This suite checks the registry and extends the catalog checks of invariants 6 and 7, which 0205 runs
-- over app and private only, to every application schema: api_public, api_external and xpms included.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(9);

-- The registry ----------------------------------------------------------------------------------------------------
select is((select count(*)::int from private.invariants), 24, 'the registry holds the 24 Section 7.5 invariants');
select is((select array_agg(number order by number) from private.invariants), (select array_agg(g) from generate_series(1, 24) g),
  'the invariants are numbered 1 to 24 without gaps');
select throws_ok($$insert into private.invariants (code, number, area, statement, enforced_by)
  values ('inv_25_extra', 25, 'Money', 'Extra.', 'Nothing.')$$, '23514', null, 'an invariant outside Section 7.5 is refused');
select throws_ok($$update private.invariants set code = 'inv_02_wrong' where number = 1$$, '23514', null,
  'a code always carries its own invariant number');

-- Invariant 6 across every application schema -----------------------------------------------------------------------
select is(
  (select coalesce(string_agg(p.oid::regprocedure::text, ', '), '') from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('app', 'private', 'api_public', 'api_external', 'xpms')
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
     and not ('search_path=""' = any(coalesce(p.proconfig, '{}')))),
  '', 'inv_06_function_hardening: every function in app, private, api_public, api_external and xpms pins an empty search_path');
select is(
  (select coalesce(string_agg(p.oid::regprocedure::text, ', '), '') from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname not in ('api_public', 'pg_catalog', 'information_schema', 'extensions', 'graphql', 'graphql_public',
       'auth', 'storage', 'realtime', '_realtime', 'vault', 'net', 'cron', 'supabase_functions', 'supabase_migrations', 'pgbouncer')
     and n.nspname not like 'pg\_%'
     and p.prosecdef
     and has_schema_privilege('anon', n.oid, 'usage')
     and has_function_privilege('anon', p.oid, 'execute')),
  '', 'inv_06_function_hardening: anon executes no SECURITY DEFINER function outside the api_public token RPCs');

-- Invariant 7 across every application schema -----------------------------------------------------------------------
select is(
  (select coalesce(string_agg(c.oid::regclass::text, ', '), '') from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('app', 'private', 'api_public', 'api_external', 'xpms', 'public')
     and c.relkind in ('r', 'v', 'm', 'f', 'p')
     and (has_table_privilege('anon', c.oid, 'select') or has_any_column_privilege('anon', c.oid, 'select'))),
  '', 'inv_07_anon_surface: anon selects from no table or view, so no select * projection can reach it');
select is(
  (select coalesce(string_agg(p.oid::regprocedure::text, ', '), '') from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('app', 'private', 'api_external', 'xpms', 'public')
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
     and has_schema_privilege('anon', n.oid, 'usage')
     and has_function_privilege('anon', p.oid, 'execute')),
  '', 'inv_07_anon_surface: anon reaches functions only through api_public');

-- Invariant 24 from the catalog: every canon text column refuses the em dash -----------------------------------------
select is(
  (select coalesce(string_agg(a.attrelid::regclass::text || '.' || a.attname, ', '), '')
   from pg_attribute a join pg_class k on k.oid = a.attrelid join pg_namespace n on n.oid = k.relnamespace
   join pg_type t on t.oid = a.atttypid
   where n.nspname = 'xpms' and k.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped
     and (t.oid in ('text'::regtype, 'varchar'::regtype) or (t.typtype = 'd' and t.typbasetype in ('text'::regtype, 'varchar'::regtype)))
     and not exists (select 1 from pg_constraint c where c.contypid = t.oid and c.contype = 'c'
       and (pg_get_constraintdef(c.oid) like '%chr(8212)%' or pg_get_constraintdef(c.oid) like '%~%'))),
  '', 'inv_24_no_em_dash: every text column of a canon table has a domain check that refuses the em dash');

select * from finish();
rollback;

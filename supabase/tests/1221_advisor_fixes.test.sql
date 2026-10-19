-- pgTAP: Section 18 gate 11, the Supabase advisor warnings fixed by migration 1221 (A54, RRR-99), held from the catalog
-- so they cannot come back: no table carries two permissive policies for one role and action
-- (multiple_permissive_policies), and no table carries two identical indexes (duplicate_index). The folded policies
-- keep admitting what both halves admitted; 0462 (open shifts) and 0805 (help desk) exercise them with rows.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(5);

select is(
  (select coalesce(string_agg(format('%s.%s %s %s', schemaname, tablename, r, c), ', '), '') from (
     select p.schemaname, p.tablename, r, c
     from pg_policies p
     cross join lateral unnest(p.roles) r
     cross join lateral (select unnest(case when p.cmd = 'ALL' then array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] else array[p.cmd] end) c) cmds
     where p.schemaname in ('app', 'private', 'xpms', 'api_public', 'api_external') and p.permissive = 'PERMISSIVE'
     group by 1, 2, 3, 4 having count(*) > 1) d),
  '', 'no table has two permissive policies for the same role and action');

select is(
  (select coalesce(string_agg(t, ', '), '') from (
     select i.indrelid::regclass::text as t
     from pg_index i join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('app', 'private', 'xpms')
     group by i.indrelid, i.indkey::text, i.indclass::text, coalesce(pg_get_expr(i.indexprs, i.indrelid), ''),
       coalesce(pg_get_expr(i.indpred, i.indrelid), ''), i.indisunique
     having count(*) > 1) d),
  '', 'no table has two identical indexes');

select ok((select qual from pg_policies where schemaname = 'app' and tablename = 'shifts' and policyname = 'shifts_read') like '%Published%',
  'the shifts read policy admits published open shifts');
select ok((select qual from pg_policies where schemaname = 'app' and tablename = 'support_tickets' and policyname = 'support_tickets_read')
  like '%my_help_desk_team_ids%', 'the support tickets read policy admits the help desk teams');
select ok(exists (select 1 from pg_indexes where schemaname = 'app' and indexname = 'identity_providers_org_id_idx')
  and exists (select 1 from pg_indexes where schemaname = 'app' and indexname = 'organization_verification_requests_org_id_idx'),
  'the org_id index of each table remains');

select * from finish();
rollback;

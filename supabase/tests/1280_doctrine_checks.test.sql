-- pgTAP: Section 3.15 and Section 7.1 catalog checks (A65, RRR-110 requirements trace). The A65 trace found two
-- doctrine rules that held on main but that no test guarded:
--   * Section 7.1: "Database comments (comment on) document every table and column." Every app and xpms table and
--     all their columns carried a comment, but a new table without one would have passed CI.
--   * Section 3.15: "There are no repeating groups and no arrays of foreign keys" and the schema lint fails on
--     "arrays of identifiers". No column held an array of uuids, but nothing refused one.
-- Partitions are left out: they inherit their parent's columns, and the parent carries the comments.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(5);

-- Section 7.1: comments on every table and column -------------------------------------------------------------------
select is(
  (select coalesce(string_agg(n.nspname || '.' || c.relname, ', ' order by n.nspname, c.relname), '')
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('app', 'xpms') and c.relkind in ('r', 'p') and not c.relispartition
     and obj_description(c.oid, 'pg_class') is null),
  '', 'every app and xpms table carries a comment (Section 7.1)');

select is(
  (select coalesce(string_agg(n.nspname || '.' || c.relname || '.' || a.attname, ', ' order by n.nspname, c.relname, a.attnum), '')
   from pg_attribute a
   join pg_class c on c.oid = a.attrelid
   join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('app', 'xpms') and c.relkind in ('r', 'p') and not c.relispartition
     and a.attnum > 0 and not a.attisdropped
     and col_description(a.attrelid, a.attnum) is null),
  '', 'every column of an app and xpms table carries a comment, which feeds the data dictionary (Section 7.1)');

select is(
  (select coalesce(string_agg(n.nspname || '.' || c.relname, ', ' order by n.nspname, c.relname), '')
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('app', 'xpms', 'api_external', 'api_public') and c.relkind in ('v', 'm')
     and obj_description(c.oid, 'pg_class') is null),
  '', 'every view in app, xpms, api_external and api_public carries a comment');

-- Section 3.15: no arrays of identifiers ----------------------------------------------------------------------------
select is(
  (select coalesce(string_agg(n.nspname || '.' || c.relname || '.' || a.attname, ', ' order by n.nspname, c.relname, a.attnum), '')
   from pg_attribute a
   join pg_class c on c.oid = a.attrelid
   join pg_namespace n on n.oid = c.relnamespace
   join pg_type t on t.oid = a.atttypid
   where n.nspname in ('app', 'xpms', 'private') and c.relkind in ('r', 'p') and not c.relispartition
     and a.attnum > 0 and not a.attisdropped
     and t.typcategory = 'A' and t.typelem = 'uuid'::regtype),
  '', 'no table column holds an array of uuids: relationships use junction tables (Section 3.15)');

-- Any other array column is a reviewed exception. A new array column fails here until it is reviewed and added,
-- with its reason, to this list.
--   app.api_keys.scopes, app.oauth_grants.scopes: scope group names checked against the capability registry (0936)
--   app.scim_identities.groups: group display names as the identity provider sent them (provider payload, ADR 0024)
--   app.survey_questions.choices, app.training_quiz_questions.options: the ordered answer texts of one question,
--     reviewed in gate 29 (1042: the quiz key follows its option)
select is(
  (select coalesce(string_agg(n.nspname || '.' || c.relname || '.' || a.attname, ', ' order by n.nspname, c.relname, a.attnum), '')
   from pg_attribute a
   join pg_class c on c.oid = a.attrelid
   join pg_namespace n on n.oid = c.relnamespace
   join pg_type t on t.oid = a.atttypid
   where n.nspname in ('app', 'xpms', 'private') and c.relkind in ('r', 'p') and not c.relispartition
     and a.attnum > 0 and not a.attisdropped
     and t.typcategory = 'A'
     and (n.nspname || '.' || c.relname || '.' || a.attname) not in (
       'app.api_keys.scopes',
       'app.oauth_grants.scopes',
       'app.scim_identities.groups',
       'app.survey_questions.choices',
       'app.training_quiz_questions.options')),
  '', 'every array column in a table is a reviewed exception (Section 3.15 schema lint)');

select * from finish();
rollback;

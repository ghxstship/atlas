-- pgTAP: the Section 3.15 schema lint (gate 29, A108, RRR-153, ADR 0068). Catalog checks over every app, private and
-- xpms table, each against an allow-list of the denormalization register (docs/adr/denormalization-register.yaml,
-- generated into 1282_denormalization_register.psql by `pnpm --filter @xos/schemas generate:denormalization`):
--   * every json or jsonb column is listed with its ADR 0002 exception (rich text, audit diff, provider payload);
--   * every array column is a reviewed exception (the list 1280 held before the register existed);
--   * a column with the same name and type as a column of the table one of its foreign keys references, outside that
--     table's primary key, restates that column and is listed. Own names (org_id, the row stamps, name and the like)
--     are never compared, a foreign key made only of own names is never followed, and a composite foreign key that
--     keeps the two columns equal is not a restatement;
--   * a non-generated column named like a total, count, sum, balance, score, percent or readiness is listed;
--   * every register entry still names a column or table its check would report, so a stale entry cannot hide a new
--     column of the same name. The tenant column check that reads the tenant exceptions is in 0202.
-- The last block adds probe tables inside a savepoint and shows that each lint reports a new violation.
-- Partitions are left out: they repeat their parent's columns and constraints.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

\ir 1282_denormalization_register.psql

-- Columns of the linted tables, with domains resolved to their base type.
create function pg_temp.lint_columns()
returns table (column_name text, table_name text, attrelid oid, attnum smallint, attname name, atttypid oid,
  base_type oid, is_array boolean, generated boolean)
language sql stable as $$
  select n.nspname || '.' || c.relname || '.' || a.attname, n.nspname || '.' || c.relname, a.attrelid, a.attnum,
    a.attname, a.atttypid, coalesce(nullif(t.typbasetype, 0), t.oid), bt.typcategory = 'A', a.attgenerated <> ''
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_type t on t.oid = a.atttypid
  join pg_type bt on bt.oid = coalesce(nullif(t.typbasetype, 0), t.oid)
  where n.nspname in ('app', 'private', 'xpms') and c.relkind in ('r', 'p') and not c.relispartition
    and a.attnum > 0 and not a.attisdropped
$$;

create function pg_temp.json_columns() returns setof text language sql stable as $$
  select column_name from pg_temp.lint_columns() where base_type in ('json'::regtype, 'jsonb'::regtype)
$$;

create function pg_temp.array_columns() returns setof text language sql stable as $$
  select column_name from pg_temp.lint_columns() where is_array
$$;

-- Each (column, parent column) pair where a child column repeats a column of the table one of its foreign keys
-- references, outside the key's own columns and the parent's primary key.
create function pg_temp.restated_columns() returns table (column_name text, parent_column text)
language sql stable as $$
  select distinct ch.column_name, pn.nspname || '.' || pc.relname || '.' || pa.attname
  from pg_constraint fk
  join pg_temp.lint_columns() ch on ch.attrelid = fk.conrelid and not (ch.attnum = any (fk.conkey))
  join pg_attribute pa on pa.attrelid = fk.confrelid and pa.attname = ch.attname and pa.atttypid = ch.atttypid
    and pa.attnum > 0 and not pa.attisdropped
  join pg_class pc on pc.oid = fk.confrelid
  join pg_namespace pn on pn.oid = pc.relnamespace
  where fk.contype = 'f' and fk.conparentid = 0 and fk.confrelid <> fk.conrelid
    and ch.attname::text not in (select column_name from register_own_names)
    -- a foreign key made only of own names, such as org_id or created_by, is never followed
    and exists (
      select 1 from pg_attribute k
      where k.attrelid = fk.conrelid and k.attnum = any (fk.conkey)
        and k.attname::text not in (select column_name from register_own_names))
    and not exists (
      select 1 from pg_constraint pk
      where pk.conrelid = fk.confrelid and pk.contype = 'p' and pa.attnum = any (pk.conkey))
    -- a composite foreign key that maps the child column onto the parent column keeps the two equal
    and not exists (
      select 1 from pg_constraint k
      where k.conrelid = fk.conrelid and k.confrelid = fk.confrelid and k.contype = 'f'
        and exists (
          select 1 from generate_subscripts(k.conkey, 1) i where k.conkey[i] = ch.attnum and k.confkey[i] = pa.attnum))
$$;

create function pg_temp.stored_totals() returns setof text language sql stable as $$
  select column_name from pg_temp.lint_columns()
  where not generated
    and attname ~ '(^|_)(totals?|counts?|sums?|balances?|scores?|percent|percentages?|readiness)(_|$)'
$$;

-- App tables without org_id or one of the audit columns, as 0202 checks them.
create function pg_temp.tables_outside_tenant_columns() returns setof text language sql stable as $$
  select n.nspname || '.' || c.relname
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'app' and c.relkind in ('r', 'p')
    and (select count(*) from pg_attribute a
         where a.attrelid = c.oid and not a.attisdropped
           and a.attname in ('org_id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'deleted_at')) <> 6
$$;

create function pg_temp.unregistered_json() returns text language sql stable as $$
  select coalesce(string_agg(c, ', ' order by c), '') from pg_temp.json_columns() c
  where c not in (select column_name from register_json)
$$;

create function pg_temp.unregistered_arrays() returns text language sql stable as $$
  select coalesce(string_agg(c, ', ' order by c), '') from pg_temp.array_columns() c
  where c not in (select column_name from register_arrays)
$$;

create function pg_temp.unregistered_restated() returns text language sql stable as $$
  select coalesce(string_agg(r.column_name || ' restates ' || r.parent_column, ', '
    order by r.column_name, r.parent_column), '')
  from pg_temp.restated_columns() r
  where not exists (
    select 1 from register_restated g where g.column_name = r.column_name and g.parent_column = r.parent_column)
$$;

create function pg_temp.unregistered_stored() returns text language sql stable as $$
  select coalesce(string_agg(c, ', ' order by c), '') from pg_temp.stored_totals() c
  where c not in (select column_name from register_stored)
$$;

select plan(15);

-- The schema as migrated -------------------------------------------------------------------------------------------
select is(pg_temp.unregistered_json(), '',
  'every json and jsonb column in app, private and xpms is registered with its ADR 0002 exception');
select is(pg_temp.unregistered_arrays(), '',
  'every array column in app, private and xpms is a registered exception (Section 3.15 schema lint)');
select is(pg_temp.unregistered_restated(), '',
  'every column restating a column of the table its foreign key references is registered');
select is(pg_temp.unregistered_stored(), '',
  'every stored column named like a total, count, sum, balance, score, percent or readiness is registered');

-- The register holds no stale entry ---------------------------------------------------------------------------------
select is(
  (select coalesce(string_agg(column_name, ', ' order by column_name), '') from register_json
   where column_name not in (select pg_temp.json_columns())),
  '', 'every JSON entry of the register names a json or jsonb column');
select is(
  (select coalesce(string_agg(column_name, ', ' order by column_name), '') from register_arrays
   where column_name not in (select pg_temp.array_columns())),
  '', 'every array entry of the register names an array column');
select is(
  (select coalesce(string_agg(g.column_name || ' restates ' || g.parent_column, ', '
     order by g.column_name, g.parent_column), '')
   from register_restated g
   where not exists (
     select 1 from pg_temp.restated_columns() r
     where r.column_name = g.column_name and r.parent_column = g.parent_column)),
  '', 'every restated entry of the register names a column that still restates its parent');
select is(
  (select coalesce(string_agg(column_name, ', ' order by column_name), '') from register_stored
   where column_name not in (select pg_temp.stored_totals())),
  '', 'every stored entry of the register names a stored column the lint matches');
select is(
  (select coalesce(string_agg(table_name, ', ' order by table_name), '') from register_tenant_exceptions
   where table_name not in (select pg_temp.tables_outside_tenant_columns())),
  '', 'every tenant exception of the register names an app table without the tenant columns');

-- Each lint reports a new violation ---------------------------------------------------------------------------------
savepoint probes;
create table app.lint_probe_parent (
  id uuid primary key,
  org_id uuid references app.organizations (id),
  venue_id uuid,
  label text
);
create table app.lint_probe_child (
  id uuid primary key,
  org_id uuid references app.organizations (id),
  parent_id uuid references app.lint_probe_parent (id),
  venue_id uuid,
  label text,
  slug text,
  details jsonb,
  tags text[],
  line_total bigint,
  doubled_total bigint generated always as (line_total * 2) stored
);

select is(pg_temp.unregistered_json(), 'app.lint_probe_child.details',
  'an unregistered jsonb column fails the JSON lint');
select is(pg_temp.unregistered_arrays(), 'app.lint_probe_child.tags',
  'an unregistered array column fails the array lint');
select is(pg_temp.unregistered_restated(), 'app.lint_probe_child.venue_id restates app.lint_probe_parent.venue_id',
  'a restated parent column fails the restated-column lint; an own name and the org_id key do not');
select is(pg_temp.unregistered_stored(), 'app.lint_probe_child.line_total',
  'a stored total fails the stored-total lint; a generated total does not');

-- A composite foreign key that keeps the restated column equal to the parent's satisfies the lint.
alter table app.lint_probe_parent add constraint lint_probe_parent_venue unique (id, venue_id);
alter table app.lint_probe_child add constraint lint_probe_child_parent_venue
  foreign key (parent_id, venue_id) references app.lint_probe_parent (id, venue_id);
select is(pg_temp.unregistered_restated(), '',
  'a composite foreign key that keeps the column equal to its parent''s is not a restatement');

rollback to savepoint probes;
select is(pg_temp.unregistered_json() || pg_temp.unregistered_arrays() || pg_temp.unregistered_restated()
  || pg_temp.unregistered_stored(), '',
  'the probes are gone, and the lints pass again');

select * from finish();
rollback;

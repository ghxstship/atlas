-- 2840_inventory_search_candidates.sql
-- P7 (RRR-221), gap G-290, Section 11.7 Search, Section 11.10 item 1. Global search reaches the org's own
-- inventory: asset classes by name, and asset units by asset tag, by the name of their class and by serial (2841).
--
--   * Indexes on exactly the expressions the search reads, with the 'simple' configuration of 1440: class names,
--     asset tags and serials (GIN), exact serials compared in upper case (as issued, 0352), and newest-first
--     indexes for filter-only queries such as type:asset.
--   * app.search_asset_candidates(table, org, terms, keys, limit): the ids of the classes or units that match,
--     found through those indexes as the definer among the rows the caller's own read policies admit, like
--     app.search_title_candidates (1440). Row level security evaluates the policy before the text match, which
--     is not leakproof, so under RLS a match could not use its index. app.global_search reads every id again
--     under the caller's row level security, which stays the only judge of what they see.
--   No table, column or view is added, so no register entry (ADR 0103), Trash decision (ADR 0110) or
--   xos_backup revoke (1650) is needed.

create index asset_classes_name_search_idx on app.asset_classes using gin (to_tsvector('simple', name));
create index asset_units_tag_search_idx on app.asset_units using gin (to_tsvector('simple', asset_tag));
create index asset_identifiers_serial_search_idx on app.asset_identifiers using gin (to_tsvector('simple', value))
  where scheme = 'serial' and deleted_at is null;
create index asset_identifiers_serial_upper_idx on app.asset_identifiers (org_id, upper(value))
  where scheme = 'serial' and deleted_at is null;
create index asset_units_org_updated_idx on app.asset_units (org_id, updated_at desc) where deleted_at is null;
create index asset_classes_org_updated_idx on app.asset_classes (org_id, updated_at desc) where deleted_at is null;

-- Each table's read predicate (private.read_policy_predicate, 1440) names its columns unqualified, so it is only
-- ever applied where that table is alone in scope: in its own subquery, select * from app.<table> where ....
create or replace function app.search_asset_candidates(
  p_table text,
  p_org_id uuid,
  p_terms tsquery[],
  p_keys text[],
  p_limit integer default 500
)
returns table (id uuid, key_match boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_terms tsquery[] := array(select q from unnest(p_terms[1:16]) q where q is not null and numnode(q) > 0);
  v_keys text[] := array(select upper(k) from unnest(p_keys[1:12]) k where k is not null and k <> '');
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 1000);
  v_all tsquery;
  v_q tsquery;
  v_units text;
  v_classes text;
  v_identifiers text;
  v_sets text;
begin
  if p_table is null or p_table not in ('asset_classes', 'asset_units') or auth.uid() is null
     or cardinality(v_terms) + cardinality(v_keys) = 0 then
    return;
  end if;
  perform private.require_membership_in(p_org_id);
  v_classes := private.read_policy_predicate('app.asset_classes'::regclass);

  -- Classes: the name matches every term, so it matches their conjunction.
  if p_table = 'asset_classes' then
    if cardinality(v_terms) = 0 then
      return;
    end if;
    foreach v_q in array v_terms loop
      v_all := case when v_all is null then v_q else v_all && v_q end;
    end loop;
    return query execute format(
      'select c.id, false from (select * from app.asset_classes where org_id = $1 and deleted_at is null '
      'and to_tsvector(''simple'', name) @@ $2 and %s) c order by c.updated_at desc, c.id limit $3',
      v_classes)
    using p_org_id, v_all, v_limit;
    return;
  end if;

  -- Units: every term matches the tag, the name of a class the caller reads, or a serial the caller reads. Each
  -- term's set is the union of the three, each through its own index, and a unit qualifies in every set.
  v_units := private.read_policy_predicate('app.asset_units'::regclass);
  v_identifiers := private.read_policy_predicate('app.asset_identifiers'::regclass);
  select string_agg(format(
      '(select u.id, u.updated_at from (select * from app.asset_units where org_id = $1 and deleted_at is null '
      'and to_tsvector(''simple'', asset_tag) @@ $2[%1$s] and %2$s) u '
      'union select u.id, u.updated_at from (select * from app.asset_units where org_id = $1 and deleted_at is null and %2$s) u '
      'where u.asset_class_id in (select c.id from (select * from app.asset_classes where org_id = $1 and deleted_at is null '
      'and to_tsvector(''simple'', name) @@ $2[%1$s] and %3$s) c) '
      'union select u.id, u.updated_at from (select * from app.asset_units where org_id = $1 and deleted_at is null and %2$s) u '
      'where u.id in (select i.asset_unit_id from (select * from app.asset_identifiers where org_id = $1 '
      'and scheme = ''serial'' and deleted_at is null and to_tsvector(''simple'', value) @@ $2[%1$s] and %4$s) i))',
      n, v_units, v_classes, v_identifiers), ' intersect ' order by n)
  into v_sets
  from generate_subscripts(v_terms, 1) n;

  -- Keys: the exact tag, or a serial in upper case on both sides.
  return query execute format(
    'with k as ('
    '(select u.id, u.updated_at from (select * from app.asset_units where org_id = $1 and deleted_at is null '
    'and asset_tag = any ($3) and %1$s) u) '
    'union (select u.id, u.updated_at from (select * from app.asset_units where org_id = $1 and deleted_at is null and %1$s) u '
    'where u.id in (select i.asset_unit_id from (select * from app.asset_identifiers where org_id = $1 '
    'and scheme = ''serial'' and deleted_at is null and upper(value) = any ($3) and %2$s) i))), '
    't as (%3$s), '
    'm as (select k.id, k.updated_at, true as key_match from k union all select t.id, t.updated_at, false from t) '
    'select m.id, bool_or(m.key_match) from m '
    'group by m.id, m.updated_at order by 2 desc, m.updated_at desc, m.id limit $4',
    v_units, v_identifiers, coalesce(v_sets, 'select null::uuid as id, null::timestamptz as updated_at where false'))
  using p_org_id, v_terms, v_keys, v_limit;
end;
$$;

comment on function app.search_asset_candidates(text, uuid, tsquery[], text[], integer) is 'For app.global_search: ids of an org''s asset classes (p_table asset_classes: the name matches every term) or asset units (asset_units: every term matches the asset tag, the name of a class the caller reads, or a serial the caller reads; or the tag or a serial is one of p_keys, key_match true), found through the search indexes among the rows the caller''s own read policies admit. Key matches first, then newest updated, at most 1,000. Reads at most 16 terms and 12 keys. app.global_search reads them again under row level security (P7).';
revoke all on function app.search_asset_candidates(text, uuid, tsquery[], text[], integer) from public, anon;
grant execute on function app.search_asset_candidates(text, uuid, tsquery[], text[], integer) to authenticated, service_role;

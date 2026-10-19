-- Key-table fingerprints for the restore drill (Section 9) and for verifying a point-in-time
-- recovery. Read-only: one row per table with its row count and a content checksum.
--
-- The checksum is the MD5 of every row's MD5, sorted, so it is independent of physical order and
-- of primary keys, and changes when any value in any row changes. Run it against the source and the
-- restored copy and compare the output; `infra/drills/restore-drill.sh` does that automatically.
-- In a hosted project, paste it into the SQL editor of the original and of the restored project.
--
-- Tables: identity and tenancy, the work and money spine, audit, the plan and permission registries,
-- the canon (whose round trip pgTAP also hashes) and the migration history.
select format('%s %s %s', key_table, rows, checksum)
from (
  select 'auth.users' as key_table, count(*) as rows, md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) as checksum from auth.users t
  union all select 'app.organizations', count(*), md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from app.organizations t
  union all select 'app.memberships', count(*), md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from app.memberships t
  union all select 'app.people', count(*), md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from app.people t
  union all select 'app.subscriptions', count(*), md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from app.subscriptions t
  union all select 'app.api_keys', count(*), md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from app.api_keys t
  union all select 'app.projects', count(*), md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from app.projects t
  union all select 'app.records', count(*), md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from app.records t
  union all select 'app.engagements', count(*), md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from app.engagements t
  union all select 'app.time_entries', count(*), md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from app.time_entries t
  union all select 'app.purchase_orders', count(*), md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from app.purchase_orders t
  union all select 'app.invoices', count(*), md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from app.invoices t
  union all select 'app.audit_events', count(*), md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from app.audit_events t
  union all select 'app.domain_events', count(*), md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from app.domain_events t
  union all select 'app.plans', count(*), md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from app.plans t
  union all select 'app.capabilities', count(*), md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from app.capabilities t
  union all select 'app.role_capabilities', count(*), md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from app.role_capabilities t
  union all select 'xpms.dim_department', count(*), md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from xpms.dim_department t
  union all select 'xpms.elements', count(*), md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from xpms.elements t
  union all select 'xpms.element_price_bands', count(*), md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from xpms.element_price_bands t
  union all select 'xpms.playbook_column', count(*), md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from xpms.playbook_column t
  union all select 'xpms.production_template_values', count(*), md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from xpms.production_template_values t
  union all select 'storage.buckets', count(*), md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from storage.buckets t
  union all select 'storage.objects', count(*), md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from storage.objects t
  union all select 'supabase_migrations.schema_migrations', count(*), md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from supabase_migrations.schema_migrations t
) fingerprints
order by key_table;

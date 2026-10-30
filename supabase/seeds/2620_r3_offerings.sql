-- 2620_r3_offerings.sql
-- R3 Org and project offerings (RRR-181, owner decision 7). Offerings default to Not Offered, and the migration's
-- backfill (2624) runs before seeds load, so it sees no demo data. This seed does for the demo org (Demo Productions,
-- 0010) what the backfill does on a live database: every project of the org offers travel, lodging, catering, per
-- diem and a guest list, so the Gateway Travel and lodging, Per diem, Hospitality and Guest list tabs open on a fresh
-- reset. Parking, uniforms, radios and carts stay Not Offered. Idempotent: a project that already has a value for a
-- setting keeps it.

insert into app.setting_values (org_id, setting_key, scope_kind, scope_id, value_text, locked)
select p.org_id, k.setting_key, 'Project', p.id, 'provided', false
from app.projects p
cross join (values ('offerings.travel'), ('offerings.lodging'), ('offerings.catering'), ('offerings.per_diem'),
  ('offerings.guest_list')) k (setting_key)
where p.org_id = '01920000-0000-7000-8000-000000000001' and p.deleted_at is null
  and not exists (
    select 1 from app.setting_values v
    where v.setting_key = k.setting_key and v.scope_kind = 'Project' and v.scope_id = p.id and v.deleted_at is null);

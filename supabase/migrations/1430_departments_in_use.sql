-- 1430_departments_in_use.sql
-- A86 Settings surfaces (RRR-131, finding A65-004, WP3), Section 4.5.6 org settings item 8: Departments and
-- Disciplines in Use, "which canon departments and disciplines the org works in, and extensions".
--   * app.org_departments_in_use and app.org_disciplines_in_use: one row per canon department and discipline the
--     org works in. Junction tables, never arrays of codes (doctrine, 1280). An org that chose none works in every
--     department, so nothing narrows until an Admin chooses.
--   * app.set_departments_in_use: replaces both lists at once (org.departments.write). A discipline needs its
--     department in the list. Every added and removed row is audited.
--   * The org's own discipline extensions are the Approved rows of app.canon_extension_proposals (0490); they
--     are in use by definition and are not repeated here.
-- Readers: the department pickers for feed audiences and the project scope matrix narrow to the departments in
-- use (packages/data/src/org-setup.ts#departmentsInUse).

create table app.org_departments_in_use (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  dept_code text not null references xpms.dim_department (dept_code)
);

call private.install_domain_table('app.org_departments_in_use');
create unique index org_departments_in_use_key on app.org_departments_in_use (org_id, dept_code) where deleted_at is null;
create index org_departments_in_use_dept_code_idx on app.org_departments_in_use (dept_code);
call private.describe('app.org_departments_in_use', 'A canon department the org works in (Section 4.5.6 item 8). An org with no rows works in every department; once it chooses, department pickers offer only these. Set in Settings, Departments and Disciplines in Use.', array[
  'dept_code', 'Canon department code (xpms.dim_department), for example 5000.'
]);

call private.install_policies('app.org_departments_in_use',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('org.departments.write'))$$);
call private.install_audit_trail('app.org_departments_in_use');

create table app.org_disciplines_in_use (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  disc_code text not null references xpms.dim_discipline (disc_code)
);

call private.install_domain_table('app.org_disciplines_in_use');
create unique index org_disciplines_in_use_key on app.org_disciplines_in_use (org_id, disc_code) where deleted_at is null;
create index org_disciplines_in_use_disc_code_idx on app.org_disciplines_in_use (disc_code);
call private.describe('app.org_disciplines_in_use', 'A canon discipline the org works in (Section 4.5.6 item 8), always under a department it also works in. The org''s own Approved discipline extensions (app.canon_extension_proposals) count as in use without a row here.', array[
  'disc_code', 'Canon discipline code (xpms.dim_discipline), for example 5000.01.'
]);

call private.install_policies('app.org_disciplines_in_use',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('org.departments.write'))$$);
call private.install_audit_trail('app.org_disciplines_in_use');

-- RPC -----------------------------------------------------------------------------------------------------------------

create or replace function app.set_departments_in_use(p_org_id uuid, p_dept_codes text[], p_disc_codes text[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_depts text[] := coalesce((select array_agg(distinct d) from unnest(p_dept_codes) d where d is not null), '{}');
  v_discs text[] := coalesce((select array_agg(distinct d) from unnest(p_disc_codes) d where d is not null), '{}');
  v_bad text;
begin
  perform private.require_person();
  if p_org_id is null or p_org_id not in (select private.orgs_with_capability('org.departments.write')) then
    raise exception using errcode = '42501', message = 'org.departments.write is required to choose departments in use';
  end if;
  select d into v_bad from unnest(v_depts) d
  where not exists (select 1 from xpms.dim_department x where x.dept_code = d) limit 1;
  if v_bad is not null then
    perform private.refuse('department_unknown', format('%s is not a canon department.', v_bad));
  end if;
  select d into v_bad from unnest(v_discs) d
  where not exists (select 1 from xpms.dim_discipline x where x.disc_code = d) limit 1;
  if v_bad is not null then
    perform private.refuse('discipline_unknown', format('%s is not a canon discipline.', v_bad));
  end if;
  select d into v_bad from unnest(v_discs) d
  join xpms.dim_discipline x on x.disc_code = d
  where not (x.dept_code = any (v_depts)) limit 1;
  if v_bad is not null then
    perform private.refuse('discipline_department_not_in_use', format('Choose the department of %s first.', v_bad));
  end if;

  update app.org_departments_in_use set deleted_at = now()
  where org_id = p_org_id and deleted_at is null and not (dept_code = any (v_depts));
  insert into app.org_departments_in_use (org_id, dept_code)
  select p_org_id, d from unnest(v_depts) d
  where not exists (select 1 from app.org_departments_in_use u where u.org_id = p_org_id and u.dept_code = d and u.deleted_at is null);

  update app.org_disciplines_in_use set deleted_at = now()
  where org_id = p_org_id and deleted_at is null and not (disc_code = any (v_discs));
  insert into app.org_disciplines_in_use (org_id, disc_code)
  select p_org_id, d from unnest(v_discs) d
  where not exists (select 1 from app.org_disciplines_in_use u where u.org_id = p_org_id and u.disc_code = d and u.deleted_at is null);
end;
$$;

comment on function app.set_departments_in_use(uuid, text[], text[]) is 'Replaces the canon departments and disciplines an org works in (Section 4.5.6 item 8; org.departments.write). Empty lists mean every department. A discipline needs its department in the list. Each change is audited.';

-- Retention -----------------------------------------------------------------------------------------------------------

call private.install_default_retention('app.org_departments_in_use', interval '90 days');
call private.install_default_retention('app.org_disciplines_in_use', interval '90 days');

-- Privileges ----------------------------------------------------------------------------------------------------------

revoke all on function app.set_departments_in_use(uuid, text[], text[]) from public, anon;
grant execute on function app.set_departments_in_use(uuid, text[], text[]) to authenticated;

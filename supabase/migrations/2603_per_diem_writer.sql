-- 2603_per_diem_writer.sql
-- R1 Advancing wiring fixes (RRR-179, ADR 0100 to 0104). Atlas Crew > Per Diems adds allowances for a run of days in
-- one call, for a member or for the person of an engagement (0981).
--
--   * app.add_per_diems(project, membership or engagement, from, to, amount, currency) inserts one row a day.
--     It needs crew.time_entry.write on the project, the per diem write policy (0981). It refuses a call that
--     names both workers or neither, a range that runs backwards or over 62 days, a membership outside the
--     project's org, and a day the worker already has a live per diem on the project.
--   * The table's triggers still decide the rest: a closed production (t40_guard_per_diem), an engagement that
--     names no person or is not Active or Closing (t38_guard_engaged_worker), another project's engagement (t39)
--     and a negative amount.
--   * app.can_add_per_diems(project) says whether the signed-in person holds crew.time_entry.write on the project,
--     so Atlas shows Add and Remove by the project, not by org-wide reach. For showing controls only.
-- Removing a per diem stays a soft delete under the write policy.

create or replace function app.add_per_diems(
  p_project_id uuid,
  p_membership_id uuid,
  p_engagement_id uuid,
  p_from date,
  p_to date,
  p_amount_minor bigint,
  p_currency_code char(3)
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_taken date;
  v_count integer;
begin
  perform private.require_person();
  if not private.can_on_project(p_project_id, 'crew.time_entry.write') then
    raise exception using errcode = '42501', message = 'crew.time_entry.write is required on the project';
  end if;
  if num_nonnulls(p_membership_id, p_engagement_id) <> 1 then
    perform private.refuse('per_diem_one_worker', 'A per diem goes to one member or one engagement.');
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 61 then
    perform private.refuse('per_diem_range', 'Per diems cover 1 to 62 days, from the first day to the last.');
  end if;
  select p.org_id into v_org from app.projects p where p.id = p_project_id;

  if p_membership_id is not null then
    if not exists (
        select 1 from app.memberships m
        where m.id = p_membership_id and m.org_id = v_org and m.deleted_at is null
          and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())) then
      perform private.refuse('per_diem_member_org', 'Per diems go to a current member of the project''s org.');
    end if;
  else
    -- The engagement branch, the one place engagement rules go: t38 refuses an engagement that names no person or
    -- is not Active or Closing, and t39 one of another project, on insert. R3 adds the per diem offering check here.
    null;
  end if;

  select d.day into v_taken
  from app.per_diems d
  where d.project_id = p_project_id and d.deleted_at is null and d.day between p_from and p_to
    and (d.membership_id = p_membership_id or d.engagement_id = p_engagement_id)
  order by d.day
  limit 1;
  if v_taken is not null then
    perform private.refuse('per_diem_day_taken', format('A per diem for %s is already recorded.', to_char(v_taken, 'YYYY-MM-DD')));
  end if;

  insert into app.per_diems (org_id, project_id, membership_id, engagement_id, day, amount_minor, currency_code)
  select v_org, p_project_id, p_membership_id, p_engagement_id, g.day::date, p_amount_minor, p_currency_code
  from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g (day);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function app.add_per_diems(uuid, uuid, uuid, date, date, bigint, char) is 'Atlas Crew > Per Diems (R1): adds one per diem a day from p_from to p_to (at most 62 days) for one member of the project''s org or one engagement, with org_id from the project. Needs crew.time_entry.write on the project. Refusals: per_diem_one_worker, per_diem_range, per_diem_member_org, and per_diem_day_taken naming the first day already recorded; the table''s triggers refuse a closed production and an engagement that names no person or is not Active or Closing. Returns the number of days added.';
revoke all on function app.add_per_diems(uuid, uuid, uuid, date, date, bigint, char) from public, anon;
grant execute on function app.add_per_diems(uuid, uuid, uuid, date, date, bigint, char) to authenticated, service_role;

create or replace function app.can_add_per_diems(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.can_on_project(p_project_id, 'crew.time_entry.write');
$$;

comment on function app.can_add_per_diems(uuid) is 'True when the signed-in person holds crew.time_entry.write on the project, the check app.add_per_diems and the per diem write policy apply (R1). For showing the Atlas Per Diems Add and Remove controls only; the function and the policy still decide every write.';
revoke all on function app.can_add_per_diems(uuid) from public, anon;
grant execute on function app.can_add_per_diems(uuid) to authenticated, service_role;

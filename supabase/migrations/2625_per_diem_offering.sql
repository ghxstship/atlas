-- 2625_per_diem_offering.sql
-- R3 Org and project offerings (RRR-181, owner decision 7). Per diem is an offering: an engagement gets per diems only
-- where the org, the project or an audience rule offers per diem (private.effective_offerings, 2622).
--
--   * app.add_per_diems (from 2603, unchanged otherwise) refuses offering_not_offered in its engagement branch when per
--     diem resolves Not Offered on the engagement. Per diems for members of the org are not subject to offerings.
--   * t41_guard_per_diem_offered holds the same rule on every other path to app.per_diems: a direct insert under the
--     table's write policy (0981) or the v1 API's perDiems create and update. It checks a new engagement per diem and
--     a row moved to another engagement; a row whose engagement stays the same is left alone, so turning per diem off
--     later never blocks edits to per diems already recorded.

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
    -- The engagement branch, the one place engagement rules go: per diem must be offered on the engagement (R3,
    -- private.effective_offerings); t38 refuses an engagement that names no person or is not Active or Closing, and
    -- t39 one of another project, on insert. Members are not subject to offerings.
    perform private.assert_offered(p_engagement_id, 'Per Diem');
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

comment on function app.add_per_diems(uuid, uuid, uuid, date, date, bigint, char) is 'Atlas Crew > Per Diems (R1): adds one per diem a day from p_from to p_to (at most 62 days) for one member of the project''s org or one engagement, with org_id from the project. Needs crew.time_entry.write on the project. Refusals: per_diem_one_worker, per_diem_range, per_diem_member_org, offering_not_offered for an engagement whose project does not offer per diem (R3, private.assert_offered; members are not subject to offerings), and per_diem_day_taken naming the first day already recorded; the table''s triggers refuse a closed production and an engagement that names no person or is not Active or Closing. Returns the number of days added.';
revoke all on function app.add_per_diems(uuid, uuid, uuid, date, date, bigint, char) from public, anon;
grant execute on function app.add_per_diems(uuid, uuid, uuid, date, date, bigint, char) to authenticated, service_role;

create or replace function private.guard_per_diem_offered()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.engagement_id is not distinct from old.engagement_id then
    return new;
  end if;
  perform private.assert_offered(new.engagement_id, 'Per Diem');
  return new;
end;
$$;

comment on function private.guard_per_diem_offered() is 'Per diems paid through an engagement (R3): refuses offering_not_offered when per diem resolves Not Offered on the engagement (private.assert_offered), on insert and when a row moves to another engagement. Per diems for members are not subject to offerings.';
revoke all on function private.guard_per_diem_offered() from public, anon, authenticated;

create trigger t41_guard_per_diem_offered before insert or update of engagement_id on app.per_diems
  for each row when (new.engagement_id is not null) execute function private.guard_per_diem_offered();

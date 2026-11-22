-- Seat messages follow what is on sale (RRR-243; ADR 0035, 2026-11-15 amendment; release 4.18).
-- packages/schemas/plans.yaml states extra seats not_on_sale (offering.extra_seats), and Billing and Plan offers none,
-- but two database messages still told a person to buy them:
--   1. private.assert_within_plan_limit (latest 1250): the seat_limit_reached refusal, for a plan that prices extra
--      seats, said "Buy extra seats in Billing and Plan, or upgrade the plan."
--   2. private.over_limit_refusal (latest 3070): the plan_limit_read_only explanation for a read-only seat said an
--      Owner can "buy extra seats or upgrade the plan."
-- Both now name what a person can do today: upgrade the plan, or free a seat. Only the two sentences change. The
-- rules, the SQLSTATE (XR001), the refusal codes (seat_limit_reached, seat_limit_upgrade, plan_limit_exceeded,
-- plan_limit_read_only) and every other message are as 1250 and 3070 left them, so Atlas still tells a plan that
-- prices extra seats from one that prices none by the code. packages/i18n/test/seat-copy.test.ts holds the latest
-- definition of each function to plans.yaml: when extra seats go on sale, the migration that restores the offer
-- ships with the status change.

create or replace function private.assert_within_plan_limit(p_org_id uuid, p_limit app.plan_limit_code, p_prospective bigint)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit bigint := private.plan_limit(p_org_id, p_limit);
  v_plan text;
begin
  if v_limit is null or p_prospective <= v_limit then
    return;
  end if;
  if p_limit = 'seats' then
    select distinct l.plan_code into v_plan from private.org_plan_limits l where l.org_id = p_org_id;
    if exists (select 1 from private.plan_extra_seat_prices x where x.plan_code = v_plan) then
      perform private.refuse('seat_limit_reached',
        format('All %s seats are in use. Upgrade the plan in Billing and Plan, or remove a member to free a seat. If you are not an Owner, ask an Owner to upgrade.', v_limit));
    end if;
    perform private.refuse('seat_limit_upgrade',
      format('All %s seats are in use, and the %s plan sells no extra seats. Upgrade the plan to add seats.', v_limit, v_plan));
  end if;
  perform private.refuse('plan_limit_exceeded',
    format('The plan allows %s %s; this change needs %s.', v_limit, p_limit, p_prospective));
end;
$$;

comment on function private.assert_within_plan_limit(uuid, app.plan_limit_code, bigint) is 'Refuses when a prospective count exceeds the org''s plan limit. Seats refuse with seat_limit_reached when the plan prices extra seats, and seat_limit_upgrade otherwise; every other limit refuses with plan_limit_exceeded (ADR 0035). While plans.yaml states extra seats not on sale, the seat_limit_reached message names the upgrade and freeing a seat, and offers no purchase (904180101).';

create or replace function private.over_limit_refusal(p_org_id uuid, p_limit app.plan_limit_code)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_plan text;
  v_limit bigint;
  v_count bigint;
begin
  select initcap(l.plan_code), l.limit_value into v_plan, v_limit
  from private.org_plan_limits l where l.org_id = p_org_id and l.limit_code = p_limit;
  select count(*) into v_count from private.over_limit_candidates(p_org_id) c where c.limit_code = p_limit;
  return case p_limit
    when 'active_projects' then format(
      'This project is read-only: the %s plan allows %s active %s and the organization has %s. An Owner can choose which projects stay writable in Settings, Billing and Plan, archive a project or upgrade the plan. No data is deleted.',
      v_plan, v_limit, case when v_limit = 1 then 'project' else 'projects' end, v_count)
    when 'seats' then format(
      'Your seat is read-only: the %s plan includes %s %s and %s members hold one. An Owner can choose who keeps a seat in Settings, Billing and Plan, or upgrade the plan. No data is deleted.',
      v_plan, v_limit, case when v_limit = 1 then 'seat' else 'seats' end, v_count)
    else format(
      'Your field seat is read-only: the %s plan includes Compass for %s field %s and the organization has %s. An Owner can choose who keeps one in Settings, Billing and Plan or upgrade the plan. No data is deleted.',
      v_plan, v_limit, case when v_limit = 1 then 'member' else 'members' end, v_count)
  end;
end;
$$;

comment on function private.over_limit_refusal(uuid, app.plan_limit_code) is 'The explanation of a plan_limit_read_only refusal: the plan, the limit, how many the org has and how to lift it (ADR 0081). While plans.yaml states extra seats not on sale, the seat explanation offers no purchase (904180101).';

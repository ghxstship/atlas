-- 1398_payroll_calendar_and_away_since.sql
-- Orchestrator (RRR-116, A71 and A76). Pay periods follow the org's calendar, never the database's UTC date:
--
--   * app.next_pay_period_dates (1323) took p_today default current_date, and app.create_next_pay_period called it
--     without a date, so an org's first pay period lined up on the UTC date. At 21:00 on Oct 31 in New York (Nov 1
--     in UTC) a monthly org got November; a biweekly org with Sunday weeks got the next week on a Saturday evening.
--     Atlas's proposal passed the org's date, so the two disagreed. p_today now defaults to null, which means today
--     on the org's calendar (private.org_today, 1305), and create_next_pay_period passes that date. Every other
--     behavior of 1323 is unchanged.

-- Pay periods on the org's calendar -------------------------------------------------------------------------------

create or replace function app.next_pay_period_dates(p_org_id uuid, p_today date default null)
returns table (starts_on date, ends_on date)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pay_period text := coalesce(private.setting_text(p_org_id, 'payroll.pay_period'), 'biweekly');
  v_week_start integer := case private.setting_text(p_org_id, 'payroll.week_start') when 'monday' then 1 else 0 end;
  v_latest date;
  v_start date;
begin
  if p_org_id is null or p_org_id not in (select private.my_org_ids()) then
    raise exception using errcode = '42501', message = 'the org does not exist or you are not in it';
  end if;
  p_today := coalesce(p_today, private.org_today(p_org_id));
  select max(p.ends_on) into v_latest from app.pay_periods p where p.org_id = p_org_id and p.deleted_at is null;
  if v_latest is not null then
    v_start := v_latest + 1;
  elsif v_pay_period in ('weekly', 'biweekly') then
    v_start := p_today - ((extract(dow from p_today)::integer - v_week_start + 7) % 7);
  elsif v_pay_period = 'semimonthly' then
    v_start := case when extract(day from p_today) <= 15 then date_trunc('month', p_today)::date
      else (date_trunc('month', p_today) + interval '15 days')::date end;
  else
    v_start := date_trunc('month', p_today)::date;
  end if;
  return query select v_start, private.pay_period_end(v_start, v_pay_period);
end;
$$;

comment on function app.next_pay_period_dates(uuid, date) is 'The next pay period an org adds (1323): the day after its latest period, or for its first period today aligned to the org''s week start (weekly and biweekly), the 1st or 16th (semimonthly) or the 1st (monthly); it lasts as long as payroll.pay_period says. Today is p_today, or the org''s date (private.org_today) when it is null or omitted, never the UTC date (1398). For members of the org.';

create or replace function app.create_next_pay_period(p_org_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_dates record;
  v_id uuid;
begin
  perform private.require_person();
  if not private.has_capability(p_org_id, 'crew.pay_period.manage') then
    raise exception using errcode = '42501', message = 'crew.pay_period.manage is required';
  end if;
  select * into v_dates from app.next_pay_period_dates(p_org_id, private.org_today(p_org_id));
  insert into app.pay_periods (org_id, starts_on, ends_on) values (p_org_id, v_dates.starts_on, v_dates.ends_on)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.create_next_pay_period(uuid) is 'Adds the org''s next pay period on the dates app.next_pay_period_dates proposes for today on the org''s calendar (payroll.pay_period and payroll.week_start, 1323; private.org_today, 1398). Needs crew.pay_period.manage. Returns the period id.';

revoke all on function app.next_pay_period_dates(uuid, date) from public, anon;
revoke all on function app.create_next_pay_period(uuid) from public, anon;
grant execute on function app.next_pay_period_dates(uuid, date) to authenticated, service_role;
grant execute on function app.create_next_pay_period(uuid) to authenticated, service_role;

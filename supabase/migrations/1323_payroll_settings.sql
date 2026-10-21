-- 1323_payroll_settings.sql
-- A76 Settings enforcement (RRR-121, A65-001, WP1): the Payroll settings (Section 4.5.6 item 26) shape the pay
-- periods an org adds. app.next_pay_period_dates proposes the next period and app.create_next_pay_period adds it:
--
--   * payroll.pay_period (default biweekly): weekly periods last 7 days, biweekly 14, semimonthly run from the 1st
--     to the 15th and from the 16th to the month's last day, monthly cover a calendar month.
--   * payroll.week_start (default sunday): the first weekly or biweekly period starts on the org's first day of the
--     week, on or before today. Payroll reads the org's value; a person's own week start only changes their
--     calendars.
--
-- The next period starts the day after the org's latest one; the first one starts today, aligned as above.

create or replace function private.pay_period_end(p_starts_on date, p_pay_period text)
returns date
language sql
immutable
set search_path = ''
as $$
  select case p_pay_period
    when 'weekly' then p_starts_on + 6
    when 'semimonthly' then case when extract(day from p_starts_on) <= 15
      then (date_trunc('month', p_starts_on) + interval '14 days')::date
      else (date_trunc('month', p_starts_on) + interval '1 month' - interval '1 day')::date end
    when 'monthly' then (date_trunc('month', p_starts_on) + interval '1 month' - interval '1 day')::date
    else p_starts_on + 13
  end;
$$;

comment on function private.pay_period_end(date, text) is 'The last day of a pay period that starts on a date, for a payroll.pay_period choice: weekly, biweekly, semimonthly or monthly.';
revoke all on function private.pay_period_end(date, text) from public, anon, authenticated;

create or replace function app.next_pay_period_dates(p_org_id uuid, p_today date default current_date)
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

comment on function app.next_pay_period_dates(uuid, date) is 'The next pay period an org adds (1323): the day after its latest period, or for its first period today aligned to the org''s week start (weekly and biweekly), the 1st or 16th (semimonthly) or the 1st (monthly); it lasts as long as payroll.pay_period says. For members of the org.';

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
  select * into v_dates from app.next_pay_period_dates(p_org_id);
  insert into app.pay_periods (org_id, starts_on, ends_on) values (p_org_id, v_dates.starts_on, v_dates.ends_on)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.create_next_pay_period(uuid) is 'Adds the org''s next pay period on the dates app.next_pay_period_dates proposes (payroll.pay_period and payroll.week_start, 1323). Needs crew.pay_period.manage. Returns the period id.';

revoke all on function app.next_pay_period_dates(uuid, date) from public, anon;
revoke all on function app.create_next_pay_period(uuid) from public, anon;
grant execute on function app.next_pay_period_dates(uuid, date) to authenticated, service_role;
grant execute on function app.create_next_pay_period(uuid) to authenticated, service_role;

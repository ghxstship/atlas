-- A pause's months as the Owner chose them, at month end too (RRR-248).
--
-- app.subscription_pause_status (6051) counted months with age(resumes_at, starts_at). A pause resumes exactly p_months
-- whole months after it starts (private.pause_resume_at), and that addition clamps to a shorter month's last day: three
-- months from the 30th of November resumes on the 28th of February, which age() reads as two months and some days, so
-- Billing and Plan showed 2 months for a 3-month pause. The count now finds the whole number of months whose resume date
-- is exactly the recorded one, and falls back to the age reading only for a pause whose dates Stripe set.

create or replace function private.pause_months(p_starts_at timestamptz, p_resumes_at timestamptz)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case
    when p_resumes_at is null then null
    else coalesce(
      (select m from generate_series(1, 120) as m
        where private.pause_resume_at(p_starts_at, m) = p_resumes_at
        order by m limit 1),
      (extract(year from age(p_resumes_at at time zone 'UTC', p_starts_at at time zone 'UTC')) * 12
        + extract(month from age(p_resumes_at at time zone 'UTC', p_starts_at at time zone 'UTC')))::integer)
  end;
$$;

comment on function private.pause_months(timestamptz, timestamptz) is 'How many whole months a pause lasts: the m whose private.pause_resume_at(starts, m) is exactly the resume instant, so a pause that resumes on a shorter month''s last day still counts the months chosen; otherwise the UTC age in whole months, for a pause whose dates Stripe set; null for an open-ended pause.';
revoke all on function private.pause_months(timestamptz, timestamptz) from public, anon, authenticated;

-- Restated from 6051 with only the months column changed.
create or replace function app.subscription_pause_status(p_org_id uuid)
returns table (
  pause_id uuid,
  source app.subscription_pause_source,
  months integer,
  starts_at timestamptz,
  resumes_at timestamptz,
  started boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_capability(p_org_id, 'org.billing.read') then
    raise exception using errcode = '42501', message = 'org.billing.read is required';
  end if;
  return query
    select p.id, p.source, private.pause_months(p.starts_at, p.resumes_at),
           p.starts_at, p.resumes_at, p.starts_at <= now()
    from app.subscription_pauses p
    where p.org_id = p_org_id and p.ended_at is null and p.deleted_at is null;
end;
$$;

comment on function app.subscription_pause_status(uuid) is 'The org''s open subscription pause for Billing and Plan (org.billing.read, 42501 otherwise): who started it, how many months (private.pause_months; null for an open-ended Stripe pause), when it starts and resumes, and whether it has started. No row without one.';
revoke all on function app.subscription_pause_status(uuid) from public, anon;
grant execute on function app.subscription_pause_status(uuid) to authenticated, service_role;

-- 6163_sensitive_data_backlog_and_report.sql
-- RRR-248 issue 5, ADR 0164. Values entered before consent was recorded, the daily job, and the report.
--
--   * No consent is invented for a value already held. Each one gets a field record with no consent and awaiting_since set.
--     Reads treat it as absent from now on (6851). The person keeps seeing it, is told once by the daily job
--     (account.sensitive_consent_needed), and either consents, which keeps it, or it is cleared 30 days after that notice.
--   * private.run_sensitive_data_job, daily: sends those notices, and only a notice that went out starts the clock; clears
--     values waiting more than 30 days; clears values a legal hold kept after a withdrawal once the hold ends; links guest
--     needs to an account opened later and tells the person; deletes guest values whose attestation is gone; deletes a guest's
--     needs 90 days after the project ends, or a year after they last changed on a project with no end date.
--   * app.my_sensitive_states: what waits for the person's consent, what a hold keeps, and their meal preferences, so Work
--     Details can show them.
--   * app.sensitive_consent_report: consent state per subject and field for an org's data.request.manage holders, never
--     a value. A person's own consent shows only where they shared the category with that org, or against a meal preference
--     on its project, which its readers already see as locked.

-- Values already held -------------------------------------------------------------------------------------------------

insert into app.sensitive_field_records (field_code, person_id, entered_at, awaiting_since)
select f.code, w.person_id, w.created_at, now()
from app.person_work_details w
cross join lateral (values
  ('dietary_needs', cardinality(w.dietary_needs) > 0),
  ('allergies', w.allergies is not null),
  ('dietary_notes', w.dietary_notes is not null),
  ('accessibility_needs', cardinality(w.accessibility_needs) > 0),
  ('accessibility_notes', w.accessibility_notes is not null)) f (code, held)
where w.deleted_at is null and f.held;

insert into app.sensitive_field_records (field_code, person_id, entered_at, awaiting_since)
select 'meal_preference', r.person_id, min(t.created_at), now()
from app.roster_travel_requests t
join private.roster_people r on r.roster_entry_id = t.roster_entry_id
where t.meal_preference is not null and t.deleted_at is null and r.person_id is not null
group by r.person_id;

insert into app.sensitive_field_records (field_code, person_id, account_id, entered_at, awaiting_since)
select f.code, c.person_id, c.account_id, min(c.created_at), now()
from app.supplier_diversity_certifications c
cross join lateral (values
  ('supplier_diversity_kind', true),
  ('supplier_diversity_certificate', c.certificate_number is not null)) f (code, held)
where c.deleted_at is null and f.held
group by f.code, c.person_id, c.account_id;

-- The daily job -------------------------------------------------------------------------------------------------------

create or replace function private.sensitive_subject_reachable(p_person_id uuid, p_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from app.people p where p.id = p_person_id and p.user_id is not null)
    or exists (
      select 1 from app.account_memberships m
      join app.account_membership_roles o on o.account_membership_id = m.id and o.account_role = 'Account Owner' and o.deleted_at is null
      join app.people p on p.id = m.person_id and p.user_id is not null
      where m.org_id = p_account_id and m.deleted_at is null and m.valid_to is null);
$$;

comment on function private.sensitive_subject_reachable(uuid, uuid) is 'True when the daily job can tell a person or a company''s Owner about a value waiting for consent. With nobody to tell, its 30 days run from when it started waiting; otherwise only from a notice that went out.';
revoke all on function private.sensitive_subject_reachable(uuid, uuid) from public, anon, authenticated;

create or replace function private.run_sensitive_data_job()
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_count bigint := 0;
  v_category app.sensitive_data_category;
  v_user uuid;
begin
  -- Tell each person, once, what is waiting for their consent. A notice that fails leaves the row to try again tomorrow.
  for v_row in
    select distinct r.person_id, p.user_id
    from app.sensitive_field_records r
    join app.people p on p.id = r.person_id
    where r.awaiting_since is not null and r.awaiting_notified_at is null and r.cleared_at is null and p.user_id is not null
      and r.guest_list_entry_id is null
  loop
    begin
      perform private.notify_account(v_row.user_id, 'account.sensitive_consent_needed', '{}'::jsonb);
      update app.sensitive_field_records r set awaiting_notified_at = now()
      where r.person_id = v_row.person_id and r.awaiting_since is not null and r.awaiting_notified_at is null and r.cleared_at is null;
    exception when others then
      raise warning 'account.sensitive_consent_needed was not sent to sign-in %: %', v_row.user_id, sqlerrm;
    end;
  end loop;
  for v_row in
    select distinct r.account_id, p.user_id
    from app.sensitive_field_records r
    join app.account_memberships m on m.org_id = r.account_id and m.deleted_at is null and m.valid_to is null
    join app.account_membership_roles o on o.account_membership_id = m.id and o.account_role = 'Account Owner' and o.deleted_at is null
    join app.people p on p.id = m.person_id
    where r.account_id is not null and r.awaiting_since is not null and r.awaiting_notified_at is null and r.cleared_at is null and p.user_id is not null
  loop
    begin
      perform private.notify_account(v_row.user_id, 'account.sensitive_consent_needed', '{}'::jsonb);
      update app.sensitive_field_records r set awaiting_notified_at = now()
      where r.account_id = v_row.account_id and r.awaiting_since is not null and r.awaiting_notified_at is null and r.cleared_at is null;
    exception when others then
      raise warning 'account.sensitive_consent_needed was not sent to sign-in %: %', v_row.user_id, sqlerrm;
    end;
  end loop;

  -- Clear what waited more than 30 days, and what a legal hold kept after a withdrawal once the hold has ended.
  for v_row in
    select distinct r.person_id, r.account_id, f.category
    from app.sensitive_field_records r
    join private.sensitive_fields f on f.code = r.field_code
    left join app.sensitive_data_consents c on c.id = r.consent_id
    where r.cleared_at is null and r.guest_list_entry_id is null
      and ((r.awaiting_since is not null and (r.awaiting_notified_at < now() - interval '30 days'
            or (r.awaiting_notified_at is null and r.awaiting_since < now() - interval '30 days'
                and not private.sensitive_subject_reachable(r.person_id, r.account_id))))
        or (c.id is not null and c.withdrawn_at is not null))
  loop
    -- A grant given since then wins.
    continue when (v_row.account_id is not null and private.sensitive_account_consent_id(v_row.account_id, v_row.category) is not null)
      or (v_row.person_id is not null and private.sensitive_consent_stands(v_row.person_id, v_row.category));
    if private.clear_ungranted_sensitive_values(v_row.person_id, v_row.account_id, v_row.category) then
      v_count := v_count + 1;
      if v_row.person_id is not null then
        perform private.log_work_detail_event(v_row.person_id, 'sensitive_consent.values_cleared', null, null, '{}', '{}', null);
      end if;
    end if;
  end loop;

  -- An account opened, or an address confirmed, after the entry: link it, tell the person, and honor a withdrawal.
  for v_row in
    select distinct private.person_with_verified_email(n.guest_email) as person_id
    from app.guest_care_needs n
    where n.guest_person_id is null and n.guest_email is not null and private.person_with_verified_email(n.guest_email) is not null
  loop
    perform private.link_guest_needs_to_person(v_row.person_id);
    select p.user_id into v_user from app.people p where p.id = v_row.person_id;
    perform private.log_work_detail_event(v_row.person_id, 'sensitive_consent.attested', null, null, '{}', '{}', null);
    foreach v_category in array array['Dietary and Allergies', 'Accessibility']::app.sensitive_data_category[] loop
      if private.person_withdrew_sensitive(v_row.person_id, v_category) then
        perform private.close_guest_needs(n.guest_list_entry_id, v_category)
        from app.guest_care_needs n where n.guest_person_id = v_row.person_id;
      elsif exists (select 1 from app.sensitive_data_consents c
                    where c.person_id = v_row.person_id and c.category = v_category and c.guest_list_entry_id is not null and c.withdrawn_at is null) then
        begin
          perform private.notify_account(v_user, 'account.sensitive_data_attested', jsonb_build_object('category', v_category));
        exception when others then
          raise warning 'account.sensitive_data_attested was not sent to sign-in %: %', v_user, sqlerrm;
        end;
      end if;
    end loop;
  end loop;

  -- A guest's values with no standing attestation: what a hold kept, now that it has ended.
  for v_row in
    select n.guest_list_entry_id, x.category
    from app.guest_care_needs n
    cross join lateral (values
      ('Dietary and Allergies'::app.sensitive_data_category, cardinality(n.dietary_needs) > 0 or n.allergies is not null or n.dietary_notes is not null),
      ('Accessibility'::app.sensitive_data_category, cardinality(n.accessibility_needs) > 0 or n.accessibility_notes is not null)) x (category, held)
    where x.held and not private.guest_needs_on_hold(n)
      and not exists (select 1 from app.sensitive_data_consents c
                      where c.guest_list_entry_id = n.guest_list_entry_id and c.category = x.category and c.withdrawn_at is null)
  loop
    perform private.close_guest_needs(v_row.guest_list_entry_id, v_row.category);
    v_count := v_count + 1;
  end loop;
  delete from app.guest_care_needs n
  where cardinality(n.dietary_needs) = 0 and n.allergies is null and n.dietary_notes is null
    and cardinality(n.accessibility_needs) = 0 and n.accessibility_notes is null and not private.guest_needs_on_hold(n);

  -- A guest's needs last until 90 days after the project ends, in its own time zone: the earliest of its last day and when it
  -- was archived or deleted. A project with no end date never ends, so they last until a year after they last changed. An
  -- attestation whose values were not saved goes the same way. A legal hold defers the deletion, not the end of use: the
  -- attestation closes now, nothing reads the values, and the step above deletes them when the hold ends.
  for v_row in
    select distinct g.id as entry
    from app.guest_list_entries g
    join app.projects p on p.id = g.project_id
    left join app.guest_care_needs n on n.guest_list_entry_id = g.id
    left join app.sensitive_data_consents c on c.guest_list_entry_id = g.id and c.withdrawn_at is null
    where (n.id is not null or c.id is not null)
      and (c.id is not null or not private.guest_needs_on_hold(n))
      and (least(p.ends_on, (p.archived_at at time zone p.time_zone)::date, (p.deleted_at at time zone p.time_zone)::date)
             < ((now() at time zone p.time_zone) - interval '90 days')::date
        or (p.ends_on is null and p.archived_at is null and p.deleted_at is null
            and greatest(n.updated_at, c.given_at) < now() - interval '1 year'))
  loop
    perform private.close_guest_needs(v_row.entry);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

comment on function private.run_sensitive_data_job() is 'The daily job of ADR 0164: tells each person once what waits for their consent, and a failed notice is tried again and starts no clock; clears values that waited over 30 days and values a legal hold kept after a withdrawal once the hold ends; links guest needs to an account opened later and tells the person; deletes guest values with no standing attestation; deletes a guest''s needs 90 days after the project ends, or a year after they last changed on a project with no end date. A legal hold defers every deletion but not the end of use. Returns how many it cleared.';
revoke all on function private.run_sensitive_data_job() from public, anon, authenticated;
grant execute on function private.run_sensitive_data_job() to service_role;

select cron.schedule('xos_run_sensitive_data_job', '37 3 * * *', 'select private.run_sensitive_data_job()');

-- What Work Details shows ---------------------------------------------------------------------------------------------

create or replace function app.my_sensitive_states(p_account_id uuid default null)
returns table (
  category app.sensitive_data_category,
  waiting boolean,
  held boolean,
  meal_preferences text[]
)
language sql
stable
security definer
set search_path = ''
as $$
  with me as (select private.require_person() as id)
  select f.category,
    bool_or(r.awaiting_since is not null),
    bool_or(r.awaiting_since is null and c.withdrawn_at is not null),
    case when f.category = 'Dietary and Allergies' and p_account_id is null then array(
      select distinct t.meal_preference from app.roster_travel_requests t
      join private.roster_people x on x.roster_entry_id = t.roster_entry_id, me
      where x.person_id = me.id and t.meal_preference is not null and t.deleted_at is null
        and private.roster_meal_grant_id(t.roster_entry_id) is null order by 1) else '{}'::text[] end
  from me
  join app.sensitive_field_records r on r.guest_list_entry_id is null and (
    (p_account_id is null and r.person_id = me.id and r.account_id is null)
    or (p_account_id is not null and r.account_id = p_account_id
        and p_account_id in (select private.my_account_ids(array['Account Owner', 'Account Admin']::app.account_role[]))))
  join private.sensitive_fields f on f.code = r.field_code
  left join app.sensitive_data_consents c on c.id = r.consent_id
  where r.cleared_at is null and (r.awaiting_since is not null or c.withdrawn_at is not null)
    and not (case when p_account_id is null then private.sensitive_consent_stands(me.id, f.category)
                  else private.sensitive_account_consent_id(p_account_id, f.category) is not null end)
  group by f.category
  order by f.category;
$$;

comment on function app.my_sensitive_states(uuid) is 'For the signed-in person, or a company they are an Owner or Admin of, each category with a value no own grant covers: waiting (from before consent was recorded, cleared 30 days after they are told unless they agree), held (they withdrew and a legal hold keeps it hidden until it ends), and the person''s meal preferences no grant covers, so Work Details can show them.';
revoke all on function app.my_sensitive_states(uuid) from public, anon;
grant execute on function app.my_sensitive_states(uuid) to authenticated, service_role;

-- The report ----------------------------------------------------------------------------------------------------------

create type app.sensitive_consent_standing as enum ('Consent Given', 'Attested', 'Withdrawn', 'No Record');
comment on type app.sensitive_consent_standing is 'Consent state of a sensitive field for a report, computed and never stored: the person''s or company''s grant stands (Consent Given), someone else''s attestation stands (Attested), the last grant was withdrawn (Withdrawn), or none was ever recorded (No Record).';

create or replace function private.sensitive_standing_of(p_consent app.sensitive_data_consents)
returns app.sensitive_consent_standing
language sql
immutable
set search_path = ''
as $$
  select case
    when p_consent.id is null then 'No Record'::app.sensitive_consent_standing
    when p_consent.withdrawn_at is not null then 'Withdrawn'::app.sensitive_consent_standing
    when p_consent.basis = 'Own Consent' then 'Consent Given'::app.sensitive_consent_standing
    else 'Attested'::app.sensitive_consent_standing end;
$$;

comment on function private.sensitive_standing_of(app.sensitive_data_consents) is 'The report''s consent state of one grant.';
revoke all on function private.sensitive_standing_of(app.sensitive_data_consents) from public, anon, authenticated;

create or replace function app.sensitive_consent_report(p_org_id uuid)
returns table (
  subject_kind text,
  subject_id uuid,
  subject_name text,
  category app.sensitive_data_category,
  field_code text,
  standing app.sensitive_consent_standing,
  notice_version text,
  given_at timestamptz,
  given_by_name text,
  withdrawn_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_person();
  if not private.has_capability(p_org_id, 'data.request.manage') then
    raise exception using errcode = '42501', message = 'data.request.manage is required';
  end if;
  return query
  with people_shared as (
    -- People who share a category of work details with this org.
    select distinct s.person_id, unnest(s.categories) as shared
    from app.work_detail_shares s
    where s.org_id = p_org_id and s.revoked_at is null and s.deleted_at is null
  ), subjects as (
    select 'Person'::text as kind, ps.person_id as id, null::uuid as account, null::uuid as guest,
      case ps.shared when 'Dietary Needs' then 'Dietary and Allergies'::app.sensitive_data_category
                     else 'Accessibility'::app.sensitive_data_category end as cat
    from people_shared ps where ps.shared in ('Dietary Needs', 'Accessibility Needs')
    union
    select case when c.account_id is not null then 'Company' else 'Person' end, c.person_id, c.account_id, null::uuid, 'Supplier Diversity'
    from app.supplier_diversity_shares s
    join app.supplier_diversity_certifications c on c.id = s.supplier_diversity_certification_id
    where s.org_id = p_org_id and s.revoked_at is null and s.deleted_at is null
    union
    select 'Guest', null::uuid, null::uuid, c.guest_list_entry_id, c.category
    from app.sensitive_data_consents c
    where c.org_id = p_org_id and c.guest_list_entry_id is not null
    union
    -- Whoever this org rosters can give a meal preference, and whoever it attested for as a company has one.
    select 'Person', r.person_id, null::uuid, null::uuid, 'Dietary and Allergies'
    from app.engagements e
    join app.engagement_roster_entries x on x.engagement_id = e.id and x.deleted_at is null
    join private.roster_people r on r.roster_entry_id = x.id
    where e.org_id = p_org_id and e.deleted_at is null and r.person_id is not null
    union
    select 'Person', c.person_id, null::uuid, null::uuid, c.category
    from app.sensitive_data_consents c
    where c.org_id = p_org_id and c.guest_list_entry_id is null and c.account_id is null
  ), shared_fields as (
    -- Which fields each subject's category covers for this org. A roster alone gives the meal preference; a company's
    -- attestation covers nothing else.
    select s.kind, s.id, s.account, s.guest, s.cat, f.code, f.sort_order
    from subjects s
    join private.sensitive_fields f on f.category = s.cat
      and (case when s.guest is not null then f.table_name = 'app.guest_care_needs'
                when s.cat = 'Supplier Diversity' then f.table_name = 'app.supplier_diversity_certifications'
                when f.code = 'meal_preference' then true
                when f.table_name = 'app.person_work_details' then exists (
                  select 1 from people_shared ps where ps.person_id = s.id
                    and ps.shared = case s.cat when 'Dietary and Allergies' then 'Dietary Needs'::app.work_detail_category
                                               else 'Accessibility Needs'::app.work_detail_category end)
                else false end)
  )
  select s.kind,
    coalesce(s.guest, s.account, s.id),
    coalesce(g.guest_name, a.name, p.full_name),
    s.cat,
    s.code,
    private.sensitive_standing_of(k),
    k.notice_version,
    k.given_at,
    b.full_name,
    k.withdrawn_at
  from shared_fields s
  left join app.people p on p.id = s.id
  left join app.organizations a on a.id = s.account
  left join app.guest_list_entries g on g.id = s.guest
  left join lateral (
    select c.* from app.sensitive_data_consents c
    where c.category = s.cat
      and case when s.guest is not null then c.guest_list_entry_id = s.guest
               when s.account is not null then c.account_id = s.account
               else c.person_id = s.id and c.guest_list_entry_id is null and (
                 -- A person's own consent is this org's to know where they shared the category with it, or where a meal
                 -- preference standing on it is on this org's project, which its readers already see as locked. Anyone else
                 -- it merely rosters reads as No Record: whether they consented or withdrew elsewhere is not its business.
                 (c.basis = 'Own Consent' and (s.code <> 'meal_preference'
                   or exists (select 1 from people_shared ps where ps.person_id = s.id and ps.shared = 'Dietary Needs')
                   or (c.withdrawn_at is null and exists (
                     select 1 from app.roster_travel_requests t
                     join private.roster_people r on r.roster_entry_id = t.roster_entry_id
                     join app.engagement_roster_entries x on x.id = t.roster_entry_id and x.deleted_at is null
                     join app.engagements e on e.id = x.engagement_id and e.org_id = p_org_id and e.deleted_at is null
                     where r.person_id = s.id and t.meal_preference is not null and t.deleted_at is null))))
                 -- A company's attestation covers its meal preference and nothing else.
                 or (s.code = 'meal_preference' and c.basis = 'Attested Authority' and (c.org_id = p_org_id or c.withdrawn_at is null and exists (
                   select 1 from private.roster_people r
                   join app.engagement_roster_entries x on x.id = r.roster_entry_id and x.deleted_at is null
                   join app.engagements e on e.id = x.engagement_id and e.org_id = p_org_id and e.deleted_at is null
                   join app.counterparties cp on cp.id = e.counterparty_id
                   where r.person_id = s.id and cp.organization_id = c.org_id)))) end
    order by c.withdrawn_at is null desc, (c.basis = 'Own Consent') desc, c.given_at desc
    limit 1) k on true
  left join app.people b on b.id = k.given_by
  order by 3, s.cat, s.sort_order;
end;
$$;

comment on function app.sensitive_consent_report(uuid) is 'Consent state per subject and sensitive field for an org''s data.request.manage holders, else 42501: the people who share a category with it, the people it rosters (their meal preference), the guests and people it attested for, and the owners of supplier diversity certifications shared with it. A company''s attestation is shown against the meal preference only. Never a value. Every field a subject''s category covers is listed whether or not a value is held; a person''s own consent shows only where they shared the category with this org, or against a meal preference on its project, and otherwise reads as No Record.';
revoke all on function app.sensitive_consent_report(uuid) from public, anon;
grant execute on function app.sensitive_consent_report(uuid) to authenticated, service_role;


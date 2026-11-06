-- 6163_sensitive_data_backlog_and_report.sql
-- RRR-248 issue 5, ADR 0164. Values entered before consent was recorded, the daily job, and the report.
--
--   * No consent is invented for a value already held. Each one gets a field record with no consent and awaiting_since set.
--     Reads treat it as absent from now on (6161). The person keeps seeing it, is told once by the daily job
--     (account.sensitive_consent_needed), and either consents, which keeps it, or it is cleared after 30 days.
--   * private.run_sensitive_data_job, daily: sends those notices; clears values waiting more than 30 days; clears values
--     a legal hold kept after a withdrawal once the hold ends; deletes a guest's needs 90 days after the project ends.
--   * app.sensitive_consent_report: consent state per subject and field for an org's data.request.manage holders, never
--     a value, and never whether a value is held.

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
begin
  -- Tell each person, once, what is waiting for their consent.
  for v_row in
    select distinct r.person_id, p.user_id
    from app.sensitive_field_records r
    join app.people p on p.id = r.person_id
    where r.awaiting_since is not null and r.awaiting_notified_at is null and r.cleared_at is null and p.user_id is not null
  loop
    begin
      perform private.notify_account(v_row.user_id, 'account.sensitive_consent_needed', '{}'::jsonb);
    exception when others then
      raise warning 'account.sensitive_consent_needed was not sent to sign-in %: %', v_row.user_id, sqlerrm;
    end;
    update app.sensitive_field_records r set awaiting_notified_at = now()
    where r.person_id = v_row.person_id and r.awaiting_since is not null and r.awaiting_notified_at is null;
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
    exception when others then
      raise warning 'account.sensitive_consent_needed was not sent to sign-in %: %', v_row.user_id, sqlerrm;
    end;
    update app.sensitive_field_records r set awaiting_notified_at = now()
    where r.account_id = v_row.account_id and r.awaiting_since is not null and r.awaiting_notified_at is null;
  end loop;

  -- Clear what waited more than 30 days, and what a legal hold kept after a withdrawal once the hold has ended.
  for v_row in
    select distinct r.person_id, r.account_id, f.category
    from app.sensitive_field_records r
    join private.sensitive_fields f on f.code = r.field_code
    left join app.sensitive_data_consents c on c.id = r.consent_id
    where r.cleared_at is null and r.guest_list_entry_id is null
      and (r.awaiting_since < now() - interval '30 days' or (c.id is not null and c.withdrawn_at is not null))
  loop
    if private.erase_sensitive_category(v_row.person_id, v_row.account_id, v_row.category) then
      v_count := v_count + 1;
      if v_row.person_id is not null then
        perform private.log_work_detail_event(v_row.person_id, 'sensitive_consent.values_cleared', null, null, '{}', '{}', null);
      end if;
    end if;
  end loop;

  -- A guest's needs last until 90 days after the project ends.
  for v_row in
    select n.guest_list_entry_id
    from app.guest_care_needs n
    join app.projects p on p.id = n.project_id
    where p.ends_on is not null and p.ends_on < (now() - interval '90 days')::date
  loop
    perform private.close_guest_needs(v_row.guest_list_entry_id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

comment on function private.run_sensitive_data_job() is 'The daily job of ADR 0164: tells each person once what waits for their consent, clears values that waited over 30 days and values a legal hold kept after a withdrawal once the hold ends, and deletes a guest''s needs 90 days after the project ends. Returns how many it cleared.';
revoke all on function private.run_sensitive_data_job() from public, anon, authenticated;
grant execute on function private.run_sensitive_data_job() to service_role;

select cron.schedule('xos_run_sensitive_data_job', '37 3 * * *', 'select private.run_sensitive_data_job()');

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
    select 'Guest', c.person_id, null::uuid, c.guest_list_entry_id, c.category
    from app.sensitive_data_consents c
    where c.org_id = p_org_id and c.guest_list_entry_id is not null
    union
    select 'Person', c.person_id, null::uuid, null::uuid, c.category
    from app.sensitive_data_consents c
    where c.org_id = p_org_id and c.guest_list_entry_id is null and c.account_id is null
  )
  select s.kind,
    coalesce(s.guest, s.account, s.id),
    coalesce(g.guest_name, a.name, p.full_name),
    s.cat,
    f.code,
    private.sensitive_standing_of(k),
    k.notice_version,
    k.given_at,
    b.full_name,
    k.withdrawn_at
  from subjects s
  join private.sensitive_fields f on f.category = s.cat
    and f.table_name = case when s.guest is not null then 'app.guest_care_needs'
                            when s.cat = 'Supplier Diversity' then 'app.supplier_diversity_certifications'
                            else 'app.person_work_details' end
  left join app.people p on p.id = s.id
  left join app.organizations a on a.id = s.account
  left join app.guest_list_entries g on g.id = s.guest
  left join lateral (
    select c.* from app.sensitive_data_consents c
    where c.category = s.cat
      and case when s.guest is not null then c.guest_list_entry_id = s.guest
               when s.account is not null then c.account_id = s.account
               else c.person_id = s.id and c.guest_list_entry_id is null and (c.basis = 'Own Consent' or c.org_id = p_org_id) end
    order by c.withdrawn_at is null desc, c.given_at desc
    limit 1) k on true
  left join app.people b on b.id = k.given_by
  order by 3, s.cat, f.sort_order;
end;
$$;

comment on function app.sensitive_consent_report(uuid) is 'Consent state per subject and sensitive field for an org''s data.request.manage holders, else 42501: the people who share a category with it, the guests and people it attested for, and the owners of supplier diversity certifications shared with it. Never a value, and never whether a value is held: every field of the category is listed.';
revoke all on function app.sensitive_consent_report(uuid) from public, anon;
grant execute on function app.sensitive_consent_report(uuid) to authenticated, service_role;


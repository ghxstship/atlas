-- 1306_org_calendar_dates.sql
-- A71 (RRR-116): org-wide dates on the org's calendar (its locale.time_zone setting, private.org_today in 1305),
-- not the database's UTC date, which runs a day ahead every evening in the Americas:
--   * app.assign_training and access review campaigns refused a due date of today after 20:00 in New York
--     ("Pick a due date from today on")
--   * app.issue_training_certification dated a certification by the UTC day of the completion, so a course
--     passed in the evening was certified tomorrow and expired a day late
--   * onboarding verifications expired, stopped passing and came due for a reminder on the UTC day
--   * app.form_1099_nec_rows allowed next year's form from 19:00 on New Year's Eve in New York
-- The org-level calendar is UTC for an org that never set locale.time_zone, as before.

create or replace function app.assign_training(p_course_id uuid, p_membership_ids uuid[], p_due_on date default null, p_reason text default null)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_course app.training_courses;
  v_mine uuid;
  v_target uuid;
  v_count integer := 0;
  v_id uuid;
begin
  perform private.require_person();
  select * into v_course from app.training_courses c where c.id = p_course_id and c.deleted_at is null;
  if v_course.id is null or v_course.id not in (select private.editable_training_course_ids()) then
    raise exception using errcode = '42501', message = 'the course does not exist or you cannot assign it';
  end if;
  if v_course.course_state <> 'Published' then
    perform private.refuse('training_course_not_published', 'Only a published course is assigned.');
  end if;
  if p_due_on is not null and p_due_on < private.org_today(v_course.org_id) then
    perform private.refuse('training_due_past', 'Pick a due date from today on.');
  end if;
  v_mine := private.my_membership_in(v_course.org_id);
  foreach v_target in array coalesce(p_membership_ids, '{}') loop
    if not exists (select 1 from app.memberships m where m.id = v_target and m.org_id = v_course.org_id and m.deleted_at is null
                   and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())) then
      perform private.refuse('training_assignee_inactive', 'Training is assigned only to active members of the org.');
    end if;
    if not exists (select 1 from app.training_assignments a where a.training_course_id = p_course_id and a.membership_id = v_target and a.deleted_at is null) then
      insert into app.training_assignments (training_course_id, membership_id, assigned_by_membership_id, due_on, reason)
      values (p_course_id, v_target, v_mine, p_due_on, nullif(btrim(p_reason), ''))
      returning id into v_id;
      perform private.emit_event(v_course.org_id, 'training.assigned', 'training_assignments', v_id, null,
        jsonb_build_object('training_course_id', p_course_id, 'due_on', p_due_on));
      perform private.notify(v_course.org_id, (select m.person_id from app.memberships m where m.id = v_target), 'training.assigned',
        'app.training_courses', p_course_id, null, jsonb_build_object('title', v_course.title, 'due_on', p_due_on));
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

create or replace function app.issue_training_certification(p_completion_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_completion app.training_completions;
  v_course app.training_courses;
  v_person uuid;
  v_holder uuid;
begin
  perform private.require_person();
  select * into v_completion from app.training_completions c where c.id = p_completion_id and c.deleted_at is null;
  if v_completion.id is null or not private.has_capability(v_completion.org_id, 'people.certification.verify') then
    raise exception using errcode = '42501', message = 'issuing certifications needs people.certification.verify';
  end if;
  select * into v_course from app.training_courses c where c.id = v_completion.training_course_id;
  if v_course.certification_id is null then
    perform private.refuse('training_no_certification', 'This course does not grant a certification.');
  end if;
  if not v_completion.passed then
    perform private.refuse('training_not_passed', 'Only a passed completion grants the certification.');
  end if;
  if v_completion.certification_holder_id is not null then
    return v_completion.certification_holder_id;
  end if;
  v_person := (select m.person_id from app.memberships m where m.id = v_completion.membership_id);
  insert into app.certification_holders (certification_id, person_id, issued_on, expires_on)
  values (v_course.certification_id, v_person, private.zone_date(v_completion.completed_at, private.org_time_zone(v_completion.org_id)),
    private.zone_date(v_completion.expires_at, private.org_time_zone(v_completion.org_id)))
  returning id into v_holder;
  update app.training_completions set certification_holder_id = v_holder where id = p_completion_id;
  perform private.emit_event(v_completion.org_id, 'training.certified', 'training_completions', p_completion_id, null,
    jsonb_build_object('certification_holder_id', v_holder));
  return v_holder;
end;
$$;

create or replace function private.guard_access_review_campaign()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.in_trusted_operation('access_review_close') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.campaign_state := 'Active';
    new.opened_at := now();
    new.closed_at := null;
    if new.due_on < private.org_today(new.org_id) then
      perform private.refuse('access_review_due_past', 'Choose a due date from today on.');
    end if;
    return new;
  end if;
  if new.campaign_state is distinct from old.campaign_state or new.opened_at is distinct from old.opened_at
     or new.closed_at is distinct from old.closed_at then
    perform private.refuse('access_review_state', 'A campaign completes when every item is decided and is canceled by deleting it.');
  end if;
  if old.deleted_at is not null then
    perform private.refuse('access_review_deleted', 'A deleted campaign cannot change.');
  end if;
  if new.deleted_at is not null then
    if old.campaign_state = 'Active' then
      new.campaign_state := 'Canceled';
      new.closed_at := now();
    end if;
    return new;
  end if;
  if old.campaign_state <> 'Active' then
    perform private.refuse('access_review_closed', 'A completed or canceled campaign cannot change.');
  end if;
  return new;
end;
$$;

create or replace function private.guard_onboarding_verification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.current_person_id();
  v_engagement app.engagements;
  v_requirement app.onboarding_requirements;
begin
  select e.* into v_engagement from app.onboarding_items i join app.engagements e on e.id = i.engagement_id where i.id = new.onboarding_item_id;
  select r.* into v_requirement from app.onboarding_items i join app.onboarding_requirements r on r.id = i.onboarding_requirement_id
  where i.id = new.onboarding_item_id;
  new.verified_by := v_me;
  new.verified_at := now();
  if v_me is not null and v_requirement.verification_method = 'Automatic' then
    perform private.refuse('verification_automatic', 'This item is verified automatically by its integration.');
  end if;
  if v_me is not null and (v_engagement.person_id = v_me or v_engagement.counterparty_id in (
      select c.id from app.counterparties c where c.organization_id in (select private.my_account_ids(null)))) then
    perform private.refuse('sod_onboarding_self_verify', 'An engaged party cannot verify their own onboarding.');
  end if;
  if new.outcome = 'Passed' and new.expires_on is null and v_requirement.valid_for_days is not null then
    new.expires_on := private.org_today(v_requirement.org_id) + v_requirement.valid_for_days;
  end if;
  return new;
end;
$$;

create or replace function private.onboarding_item_passes(p_item_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select v.outcome = 'Passed' and (v.expires_on is null or v.expires_on >= private.org_today(v.org_id))
    from app.onboarding_verifications v
    where v.onboarding_item_id = p_item_id
    order by v.verified_at desc, v.id desc limit 1), false);
$$;

create or replace view app.onboarding_item_status as
select i.id as onboarding_item_id, i.org_id, i.engagement_id, i.onboarding_requirement_id, r.name, r.item_kind, r.is_blocking,
  r.verification_method, i.submitted_at,
  lv.outcome as latest_outcome, lv.expires_on,
  private.onboarding_item_passes(i.id) as passes,
  (not private.onboarding_item_passes(i.id) and private.requirement_satisfied(i.engagement_id, i.onboarding_requirement_id)) as carried_over,
  (lv.expires_on is not null and r.remind_days_before is not null
    and lv.expires_on - r.remind_days_before <= private.org_today(i.org_id) and lv.expires_on >= private.org_today(i.org_id)) as reminder_due
from app.onboarding_items i
join app.onboarding_requirements r on r.id = i.onboarding_requirement_id
left join lateral (
  select v.outcome, v.expires_on from app.onboarding_verifications v
  where v.onboarding_item_id = i.id order by v.verified_at desc, v.id desc limit 1
) lv on true
where i.deleted_at is null
  and (i.engagement_id in (select private.internal_engagement_ids('opportunities.engagement.read'))
       or i.engagement_id in (select private.my_engagement_ids('onboarding')));


create or replace function app.form_1099_nec_rows(p_org_id uuid, p_year integer, p_include_tin boolean default false)
returns table (
  payee_person_id uuid,
  payee_organization_id uuid,
  payee_name text,
  tax_form_id uuid,
  w9_on_file boolean,
  tin_type smallint,
  tin_last4 text,
  tin text,
  street_address text,
  locality text,
  region_code text,
  postal_code text,
  address_complete boolean,
  amount_minor bigint,
  payment_count integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_person();
  if not private.has_capability(p_org_id, 'finance.payment.read') then
    raise exception using errcode = '42501', message = 'finance.payment.read is required';
  end if;
  if p_year is null or p_year < 2020 or p_year > extract(year from private.org_today(p_org_id))::integer then
    perform private.refuse('form_1099_year', 'Choose a tax year from 2020 to this year.');
  end if;
  if p_include_tin then
    if not private.has_capability(p_org_id, 'data.export.restricted') then
      perform private.refuse('export_restricted', 'The 1099-NEC file carries Restricted tax identifiers and needs the restricted export capability.');
    end if;
    if private.session_aal() <> 'aal2' then
      perform private.refuse('step_up_required', 'Exporting Restricted columns needs step-up authentication.');
    end if;
  end if;

  return query
  with paid as (
    select pm.payee_person_id as person_id, c.organization_id, sum(pm.amount_minor)::bigint as amount_minor, count(*)::integer as payment_count
    from app.payments pm
    left join app.counterparties c on c.id = pm.counterparty_id
    where pm.org_id = p_org_id and pm.deleted_at is null and pm.direction = 'Payable' and pm.payment_state = 'Approved'
      and pm.currency_code = 'USD' and pm.paid_on >= make_date(p_year, 1, 1) and pm.paid_on < make_date(p_year + 1, 1, 1)
    group by 1, 2
  ),
  contractors as (
    select p.* from paid p
    where p.amount_minor >= 60000
      and exists (
        select 1 from app.engagements e
        left join app.counterparties ec on ec.id = e.counterparty_id
        where e.org_id = p_org_id and e.deleted_at is null and e.worker_classification = 'INDEPENDENT_CONTRACTOR'
          and ((p.person_id is not null and e.counterparty_id is null and e.person_id = p.person_id)
            or (p.organization_id is not null and ec.organization_id = p.organization_id)))
  )
  select k.person_id, k.organization_id,
    coalesce(w.legal_name, case when k.person_id is not null then pe.full_name else o.name end),
    w.id, w.id is not null,
    case when w.id is null then null when k.person_id is not null then 2 else 1 end::smallint,
    w.tin_last4,
    case when p_include_tin and w.id is not null then private.tax_form_tin(w.id) end,
    w.street_address, w.locality, w.region_code, w.postal_code,
    (w.street_address is not null and w.locality is not null and w.region_code is not null and w.postal_code is not null),
    k.amount_minor, k.payment_count
  from contractors k
  left join app.people pe on pe.id = k.person_id
  left join app.organizations o on o.id = k.organization_id
  left join lateral (
    select t.* from app.tax_forms t
    where t.org_id = p_org_id and t.deleted_at is null and t.form_kind = 'W-9'
      and ((k.person_id is not null and t.person_id = k.person_id) or (k.organization_id is not null and t.organization_id = k.organization_id))
    order by t.signed_at desc
    limit 1
  ) w on true
  order by 3, 1, 2;

  if p_include_tin then
    perform private.write_audit_event(p_org_id, 'finance.form_1099_nec_exported', 'app.tax_forms', null,
      jsonb_build_object('tax_year', p_year, 'classification', 'Restricted'));
  end if;
end;
$$;

comment on function app.assign_training(uuid, uuid[], date, text) is 'Assigns a published course to active members (knowledge.sop.publish) with an optional due date, from today on the org''s calendar (A71), and reason, notifying each new assignee. Members already assigned are skipped. Returns how many were assigned.';

comment on function app.issue_training_certification(uuid) is 'A verifier (people.certification.verify, never the learner) issues the certification a passed course grants, dated by the completion and expiring with it, both on the org''s calendar (A71). Issuing twice returns the first record. Returns the certification holder id.';

comment on function private.guard_access_review_campaign() is 'Access review campaigns open Active with today''s date and a due date from today on the org''s calendar (A71); the state changes only by completing every item or by deleting an Active campaign, which cancels it; closed campaigns are read-only.';

comment on function private.guard_onboarding_verification() is 'Verifications: reviewer stamped from the session, never the engaged party (Section 8.2), Reviewer items only by people and Automatic items only by the platform, and a Passed verification expires after the requirement''s validity, counted from today on the org''s calendar (A71).';

comment on function private.onboarding_item_passes(uuid) is 'True when the item''s latest verification passed and has not expired on the org''s calendar (A71).';

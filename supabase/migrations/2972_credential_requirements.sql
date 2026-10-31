-- 2972_credential_requirements.sql
-- B8 Training required before a badge (RRR-232, gap G-148, ADR 0147 decision 4). A credential category can require a
-- training course or a certification. Issuing the category to someone who does not meet every requirement now is
-- refused (credential_training_incomplete), whether the badge is issued directly, through app.issue_allocation (R7) or
-- through the API. Credentials that existed before a requirement was added are untouched.
--
--   * A course requirement is met by a passed app.training_completions row of that course, through a membership of the
--     holder in the course's org, that has not expired. Only org members train (0804).
--   * A certification requirement is met by a live app.certification_holders row of the holder that has not expired.
--     A verifier records it (0352, invariant 21), so anyone, member or not, meets it; that is how a pass desk records
--     an in-person induction. Because the row now opens a gate, private.guard_certification_holder (0352, its only
--     definition) also stops the holder changing anything but their consent: 0352's update policy lets the holder
--     update their own row for that consent, and without this they could clear an expiry or restore a removed record.
--   * private.credential_requirements_state answers, for a category, a holder and the badge's end, each requirement
--     with is_met and, for a met one that expires before the badge ends, when it expires. The guard calls it directly.
--     private.credential_requirements_missing is the same answer for readers: app.credential_review (2973) calls it as
--     its reader, so it is granted to authenticated and answers nothing to someone who cannot read the category's
--     credentials (ADR 0016 rule 14: it takes values, never a credential id).
--   * app.credential_issue_check lists what the issue form shows before Issue; 2973 adds the accreditation checks.

create table app.credential_category_requirements (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  credential_category_id uuid not null references app.credential_categories (id),
  training_course_id uuid references app.training_courses (id),
  certification_id uuid references app.certifications (id),
  constraint credential_category_requirements_one check (num_nonnulls(training_course_id, certification_id) = 1)
);
create index credential_category_requirements_category_idx on app.credential_category_requirements (credential_category_id);
create index credential_category_requirements_course_idx on app.credential_category_requirements (training_course_id);
create index credential_category_requirements_certification_idx on app.credential_category_requirements (certification_id);
call private.install_domain_table('app.credential_category_requirements', 'app.credential_categories', 'credential_category_id',
  array['app.training_courses', 'training_course_id', 'app.certifications', 'certification_id']);
create unique index credential_category_requirements_course_key on app.credential_category_requirements (credential_category_id, training_course_id)
  where deleted_at is null and training_course_id is not null;
create unique index credential_category_requirements_certification_key on app.credential_category_requirements (credential_category_id, certification_id)
  where deleted_at is null and certification_id is not null;
call private.describe('app.credential_category_requirements', 'What a credential category requires before it is issued (gap G-148, ADR 0147 decision 4): a training course passed through a membership of the org, or a certification a verifier recorded. Issuing the category to someone who does not meet each one now is refused.', array[
  'credential_category_id', 'Category that requires it.',
  'training_course_id', 'Course the holder must have passed, unexpired; NULL for a certification requirement.',
  'certification_id', 'Certification the holder must hold, unexpired; NULL for a course requirement.'
]);
call private.install_policies('app.credential_category_requirements',
  $$credential_category_id in (select c.id from app.credential_categories c where c.project_id in (select private.project_ids_with('credentials.credential.read')))$$,
  $$credential_category_id in (select c.id from app.credential_categories c where c.project_id in (select private.project_ids_with('credentials.category.write')))$$);
call private.install_audit_trail('app.credential_category_requirements');
call private.install_default_retention('app.credential_category_requirements');

-- The holder changes only their consent ------------------------------------------------------------------------------------

-- Recreated from 0352 (its only definition) with every rule kept; the new rule is the holder's.
create or replace function private.guard_certification_holder()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.current_person_id();
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then
      new.verified_by := v_me;
    end if;
    if new.verified_by = new.person_id then
      perform private.refuse('credential_self_issue', 'A person never issues their own credential or certification.');
    end if;
    new.verification_code := encode(extensions.gen_random_bytes(12), 'hex');
    new.public_verification_consented := false;
    return new;
  end if;
  if new.person_id <> old.person_id or new.verified_by is distinct from old.verified_by or new.verification_code <> old.verification_code then
    perform private.refuse('certification_holder_immutable', 'A certification record keeps its holder, verifier and code.');
  end if;
  if new.public_verification_consented <> old.public_verification_consented and auth.uid() is not null and v_me is distinct from new.person_id then
    perform private.refuse('certification_consent_holder_only', 'Only the holder consents to public verification.');
  end if;
  if auth.uid() is not null and v_me = old.person_id
     and (new.certification_id <> old.certification_id or new.issued_on <> old.issued_on
          or new.expires_on is distinct from old.expires_on or (old.deleted_at is not null and new.deleted_at is null)) then
    perform private.refuse('certification_holder_verifier_only',
      'The holder changes only their consent; a verifier corrects the dates or restores the record.');
  end if;
  return new;
end;
$$;
comment on function private.guard_certification_holder() is 'Certification holders: recorded by someone other than the holder (invariant 21), with a database-issued code; only the holder changes consent to public verification, and the holder changes nothing else but removing their own record (B8: a certification can be required before a badge, 2972), so a holder cannot clear an expiry, change the dates or restore a removed record.';
revoke all on function private.guard_certification_holder() from public, anon, authenticated;

-- Which requirements a holder meets ----------------------------------------------------------------------------------------

create function private.credential_requirements_state(p_category_id uuid, p_person_id uuid, p_valid_to timestamptz)
returns table (
  requirement_id uuid,
  training_course_id uuid,
  certification_id uuid,
  title text,
  is_met boolean,
  expires_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  with req as (
    select r.id, r.training_course_id, r.certification_id,
      coalesce(tc.title, ce.name) as title,
      case
        when r.training_course_id is not null then (
          select case when bool_or(t.expires_at is null) then 'infinity'::timestamptz else max(t.expires_at) end
          from app.training_completions t
          join app.memberships m on m.id = t.membership_id
          where t.training_course_id = r.training_course_id and t.passed and t.deleted_at is null
            and m.person_id = p_person_id and m.org_id = tc.org_id
            and (t.expires_at is null or t.expires_at > now()))
        else (
          select case when bool_or(h.expires_on is null) then 'infinity'::timestamptz
                      else (max(h.expires_on) + 1)::timestamp at time zone 'UTC' end
          from app.certification_holders h
          where h.certification_id = r.certification_id and h.person_id = p_person_id and h.deleted_at is null
            and (h.expires_on is null or h.expires_on >= current_date))
      end as good_until
    from app.credential_category_requirements r
    left join app.training_courses tc on tc.id = r.training_course_id
    left join app.certifications ce on ce.id = r.certification_id
    where r.credential_category_id = p_category_id and r.deleted_at is null
  )
  select req.id, req.training_course_id, req.certification_id, req.title, req.good_until is not null,
    case when req.good_until is not null and req.good_until <> 'infinity'::timestamptz
              and (p_valid_to is null or req.good_until < p_valid_to) then req.good_until end
  from req
  order by req.title, req.id;
$$;
comment on function private.credential_requirements_state(uuid, uuid, timestamptz) is 'Each live requirement of a credential category for a holder: is_met when a passed, unexpired completion of the course through the holder''s membership of the course''s org, or a live, unexpired certification of the holder, exists now; expires_at when a met requirement stops being met before p_valid_to (the badge''s end; NULL for an open-ended badge). Internal: the issue guard and the checks call it.';
revoke all on function private.credential_requirements_state(uuid, uuid, timestamptz) from public, anon, authenticated;

create function private.credential_requirements_missing(p_category_id uuid, p_person_id uuid, p_valid_to timestamptz)
returns table (
  requirement_id uuid,
  training_course_id uuid,
  certification_id uuid,
  title text,
  is_met boolean,
  expires_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.can_on_project((select c.project_id from app.credential_categories c where c.id = p_category_id),
                                'credentials.credential.read') then
    return;
  end if;
  return query select * from private.credential_requirements_state(p_category_id, p_person_id, p_valid_to);
end;
$$;
comment on function private.credential_requirements_missing(uuid, uuid, timestamptz) is 'private.credential_requirements_state for a reader with credentials.credential.read on the category''s project; nothing for anyone else, so it is no oracle. Takes values, never a credential id, because app.credential_review calls it as its reader (ADR 0016 rule 14).';
revoke all on function private.credential_requirements_missing(uuid, uuid, timestamptz) from public, anon;
grant execute on function private.credential_requirements_missing(uuid, uuid, timestamptz) to authenticated, service_role;

-- The guard -------------------------------------------------------------------------------------------------------------------

create function private.guard_credential_requirements()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_missing integer;
begin
  select count(*) into v_missing
  from private.credential_requirements_state(new.credential_category_id, new.holder_person_id, new.valid_to) s
  where not s.is_met;
  if v_missing > 0 then
    perform private.refuse('credential_training_incomplete',
      format('The holder has not completed %s of the training or certifications this category requires.', v_missing));
  end if;
  return new;
end;
$$;
comment on function private.guard_credential_requirements() is 'Credentials: issuing a category to someone who does not meet each of its requirements now is refused (credential_training_incomplete), for direct issue, app.issue_allocation and the API alike. Existing credentials are untouched.';
revoke all on function private.guard_credential_requirements() from public, anon, authenticated;
create trigger t44_guard_credential_requirements before insert on app.credentials
  for each row execute function private.guard_credential_requirements();

-- What the issue form checks ---------------------------------------------------------------------------------------------------

create function app.credential_issue_check(
  p_category_id uuid,
  p_holder_person_id uuid,
  p_valid_from timestamptz default null,
  p_valid_to timestamptz default null
)
returns table (
  check_code text,
  blocking boolean,
  requirement_id uuid,
  title text,
  other_credential_id uuid,
  project_id uuid,
  project_key text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_project uuid := (select c.project_id from app.credential_categories c where c.id = p_category_id and c.deleted_at is null);
begin
  perform private.require_person();
  if v_project is null or not private.can_on_project(v_project, 'credentials.credential.issue') then
    raise exception using errcode = '42501', message = 'credentials.credential.issue is required on the project';
  end if;
  return query
    select case when s.is_met then 'training_expires_first' else 'training_missing' end, not s.is_met, s.requirement_id,
      s.title, null::uuid, null::uuid, null::text
    from private.credential_requirements_state(p_category_id, p_holder_person_id, p_valid_to) s
    where not s.is_met or s.expires_at is not null;
end;
$$;
comment on function app.credential_issue_check(uuid, uuid, timestamptz, timestamptz) is 'What the issue form shows before Issue (credentials.credential.issue on the category''s project): training_missing (blocking) for each unmet requirement and training_expires_first (not blocking) for one that expires before the badge ends. Migration 2973 adds the accreditation checks.';
revoke all on function app.credential_issue_check(uuid, uuid, timestamptz, timestamptz) from public, anon;
grant execute on function app.credential_issue_check(uuid, uuid, timestamptz, timestamptz) to authenticated, service_role;

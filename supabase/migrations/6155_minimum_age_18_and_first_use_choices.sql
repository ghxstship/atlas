-- 6155_minimum_age_18_and_first_use_choices.sql
-- RRR-248, legal issue 4: Compass recorded no acceptance and asked no age, and the documents, Google Play and the AI text
-- disagreed about the age. One minimum age of 18 now holds for every XOS account in every app, and Compass asks before
-- anything else. This migration:
--   * raises the age the shells ask to 18. private.age_confirmations keeps every 16 confirmation as the evidence it was
--     when given, so a person can hold one row per age, and only an 18 confirmation counts from here on;
--   * records a refusal: private.age_refusals holds the surface, the time and what happened to the account, and nothing
--     that identifies anyone. app.refuse_minimum_age closes the signed-in person's account, and
--     api_public.record_age_refusal counts an answer given before any account exists;
--   * answers what a Compass sign-in still owes (app.my_legal_standing): the age, the personal documents accepted so far,
--     whether the Worker Terms apply and the AI choice. Acceptances still go through app.record_legal_acceptances (0850)
--     and announced changes through app.pending_legal_reacceptances (1383);
--   * records the first-use AI choice (Apple guideline 5.1.2(i)) in private.ai_disclosure_choices, append-only, and makes
--     a decline bind on the server: app.ai_begin_request refuses it and app.ai_enabled_features answers nothing, whichever
--     app asks. A person with no recorded choice keeps the org's setting, since only Compass asks today.

-- Minimum age ------------------------------------------------------------------------------------------------------------

alter table private.age_confirmations
  drop constraint age_confirmations_person_key,
  drop constraint age_confirmations_minimum_age,
  alter column minimum_age set default 18,
  add constraint age_confirmations_person_age_key unique (person_id, minimum_age),
  add constraint age_confirmations_minimum_age check (minimum_age in (16, 18));

comment on table private.age_confirmations is 'Each person''s confirmation of the account minimum age (Section 14.3 Children, Section 14.9 Minors; Terms of Service 3.2): one row per person and age, written at sign-up from the answer on the form or later through app.confirm_minimum_age, never changed. The minimum is 18; a row at 16 is evidence of the earlier rule and no longer counts. Read by the person through app.minimum_age_confirmed().';
comment on column private.age_confirmations.minimum_age is 'The age confirmed: 18, the account minimum, or 16 for a confirmation given under the earlier rule.';

create or replace function app.confirm_minimum_age(p_surface text, p_client_ip inet default null)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_at timestamptz;
begin
  if p_surface is null or p_surface not in ('Atlas', 'Gateway', 'Compass') then
    perform private.refuse('age_surface', 'Name the surface the confirmation came from: Atlas, Gateway or Compass.');
  end if;
  insert into private.age_confirmations (person_id, user_id, minimum_age, surface, ip)
  values (v_person, (select auth.uid()), 18, p_surface, coalesce(p_client_ip, private.request_ip()))
  on conflict (person_id, minimum_age) do nothing;
  select c.confirmed_at into v_at from private.age_confirmations c where c.person_id = v_person and c.minimum_age = 18;
  return v_at;
end;
$$;

comment on function app.confirm_minimum_age(text, inet) is 'Records that the signed-in person confirmed they are 18 or older (Section 14.3, 14.9), on the surface they used. The first confirmation stands; a repeat answers its time. The client address comes from the platform server, or from the request when absent.';
revoke all on function app.confirm_minimum_age(text, inet) from public, anon;
grant execute on function app.confirm_minimum_age(text, inet) to authenticated, service_role;

create or replace function app.minimum_age_confirmed()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.age_confirmations c
    where c.person_id = private.current_person_id() and c.minimum_age = 18);
$$;

comment on function app.minimum_age_confirmed() is 'True when the signed-in person has confirmed they are 18 or older. A confirmation at the earlier age of 16 does not count. The shells ask before a new account creates or joins an org, and Compass asks at first sign-in.';
revoke all on function app.minimum_age_confirmed() from public, anon;
grant execute on function app.minimum_age_confirmed() to authenticated, service_role;

create or replace function app.minimum_age_outdated()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.age_confirmations c
    where c.person_id = private.current_person_id() and c.minimum_age = 16)
    and not exists (
      select 1 from private.age_confirmations c
      where c.person_id = private.current_person_id() and c.minimum_age = 18);
$$;

comment on function app.minimum_age_outdated() is 'True when the signed-in person confirmed 16 under the earlier rule and has not answered at 18. The web shells ask them at their next sign-in.';
revoke all on function app.minimum_age_outdated() from public, anon;
grant execute on function app.minimum_age_outdated() to authenticated, service_role;

-- A form still in a browser during the release can send 16: it is kept as what it was, and the person is asked again.
create or replace function private.record_signup_age_confirmation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_surface text := coalesce(new.raw_user_meta_data ->> 'signup_surface', 'Atlas');
  v_age smallint := case coalesce(new.raw_user_meta_data ->> 'age_confirmed', '') when '18' then 18 when '16' then 16 end;
begin
  if v_age is null then
    return new;
  end if;
  insert into private.age_confirmations (person_id, user_id, minimum_age, surface, ip)
  select p.id, new.id, v_age, case when v_surface in ('Atlas', 'Gateway', 'Compass') then v_surface else 'Atlas' end, private.request_ip()
  from app.people p where p.user_id = new.id
  on conflict (person_id, minimum_age) do nothing;
  return new;
end;
$$;

comment on function private.record_signup_age_confirmation() is 'After a sign-up whose metadata says age_confirmed = 18 (the person answered 18 or older on a sign-up form), records the age confirmation for the new person. A 16 from a form loaded before the rule changed is kept as a 16, which does not count.';
revoke all on function private.record_signup_age_confirmation() from public, anon, authenticated;

-- Refusals ---------------------------------------------------------------------------------------------------------------

create table private.age_refusals (
  id uuid primary key default private.uuid_v7(),
  surface text not null,
  minimum_age smallint not null default 18,
  outcome text not null,
  refused_at timestamptz not null default now(),
  constraint age_refusals_surface check (surface in ('Atlas', 'Gateway', 'Compass')),
  constraint age_refusals_minimum_age check (minimum_age = 18),
  constraint age_refusals_outcome check (outcome in ('No Account', 'Account Removed', 'Account Closed', 'Account Held'))
);

comment on table private.age_refusals is 'Each time someone answered that they are under 18 (Section 14.3, 14.9): only the surface, the time and what happened to the account. It names no person, sign-in, email or address, so nothing here identifies anyone who was refused.';
comment on column private.age_refusals.id is 'Refusal id (UUID v7).';
comment on column private.age_refusals.surface is 'Where the person answered: Atlas, Gateway or Compass.';
comment on column private.age_refusals.minimum_age is 'The minimum age the person answered they do not meet.';
comment on column private.age_refusals.outcome is 'No Account: answered before any account existed. Account Removed: an account with no org behind it and nothing written was removed entirely. Account Closed: the account was deleted as app.delete_my_account does, and orgs keep the records the law requires. Account Held: a legal hold, an open shift or being the only owner stops deletion, so the sign-in stays and is asked again.';
comment on column private.age_refusals.refused_at is 'When the person answered. Set by the database.';

alter table private.age_refusals enable row level security;
revoke all on private.age_refusals from public, anon, authenticated;
grant select on private.age_refusals to service_role;

create or replace function api_public.record_age_refusal(p_surface text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_client text;
begin
  perform private.require_read_write();
  if p_surface is null or p_surface not in ('Atlas', 'Gateway', 'Compass') then
    return false;
  end if;
  v_client := coalesce(host(private.request_ip()), 'unknown');
  if private.rate_limit_exceeded('age_refusal', v_client, 30, interval '10 minutes') then
    return false;
  end if;
  perform private.note_rate_event('age_refusal', v_client);
  insert into private.age_refusals (surface, outcome) values (p_surface, 'No Account');
  return true;
end;
$$;

comment on function api_public.record_age_refusal(text) is 'Named public RPC for a sign-up form (Section 14.3, 14.9): counts an answer of under 18 given before any account exists, so nothing the person typed is kept. At most 30 per client address in 10 minutes. Returns false when refused.';
revoke all on function api_public.record_age_refusal(text) from public;
grant execute on function api_public.record_age_refusal(text) to anon, authenticated, service_role;

create or replace function app.refuse_minimum_age(p_surface text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_person uuid := private.require_person();
  v_email text;
  v_blocker jsonb;
begin
  if p_surface is null or p_surface not in ('Atlas', 'Gateway', 'Compass') then
    perform private.refuse('age_surface', 'Name the surface the refusal came from: Atlas, Gateway or Compass.');
  end if;
  -- Someone who has confirmed 18 is not asked again, so an answer of under 18 from them is not an answer to this question.
  if exists (select 1 from private.age_confirmations c where c.person_id = v_person and c.minimum_age = 18) then
    perform private.refuse('age_already_confirmed', 'This account has confirmed its age. To close it, delete your account in Settings.');
  end if;

  v_blocker := private.account_deletion_blockers(v_person) -> 0;
  if v_blocker is not null then
    insert into private.age_refusals (surface, outcome) values (p_surface, 'Account Held');
    return jsonb_build_object('outcome', 'Account Held', 'reason', v_blocker ->> 'code', 'org_name', v_blocker ->> 'org_name');
  end if;

  v_email := (select lower(u.email) from auth.users u where u.id = v_uid);

  -- A person some org has records about: those records stay as the law requires, so the deletion runs as it always does.
  if exists (select 1 from private.person_related_org_ids(v_person)) then
    perform app.delete_my_account(v_email);
    insert into private.age_refusals (surface, outcome) values (p_surface, 'Account Closed');
    return jsonb_build_object('outcome', 'Account Closed');
  end if;

  -- No org behind the account: nothing has to stay, so neither the sign-in nor the person remains. Something the person
  -- wrote before answering (an earlier acceptance, a profile) can still hold the row, and then the deletion runs as usual.
  begin
    delete from auth.users where id = v_uid;
    delete from app.people where id = v_person;
  exception when foreign_key_violation or restrict_violation then
    perform app.delete_my_account(v_email);
    insert into private.age_refusals (surface, outcome) values (p_surface, 'Account Closed');
    return jsonb_build_object('outcome', 'Account Closed');
  end;
  insert into private.age_refusals (surface, outcome) values (p_surface, 'Account Removed');
  return jsonb_build_object('outcome', 'Account Removed');
end;
$$;

comment on function app.refuse_minimum_age(text) is 'The signed-in person answered that they are under 18 (Section 14.3, 14.9). An account with no org behind it and nothing written is removed entirely. Otherwise it is deleted as app.delete_my_account does, so orgs keep what the law requires and learn only of an erasure. A legal hold, an open shift or being the only owner stops deletion, and the answer names why. Each case records one row in private.age_refusals, which identifies no one. Refuses an account that has already confirmed 18.';
revoke all on function app.refuse_minimum_age(text) from public, anon;
grant execute on function app.refuse_minimum_age(text) to authenticated, service_role;

-- The AI choice ----------------------------------------------------------------------------------------------------------

create table private.ai_disclosure_choices (
  id uuid primary key default private.uuid_v7(),
  person_id uuid not null references app.people (id) on delete cascade,
  surface text not null,
  disclosure_version text not null,
  choice text not null,
  decided_at timestamptz not null default now(),
  ip inet,
  constraint ai_disclosure_choices_surface check (surface in ('Atlas', 'Gateway', 'Compass')),
  constraint ai_disclosure_choices_version check (char_length(btrim(disclosure_version)) between 1 and 50),
  constraint ai_disclosure_choices_choice check (choice in ('Allowed', 'Declined'))
);

create index ai_disclosure_choices_person_idx on private.ai_disclosure_choices (person_id, decided_at desc, id desc);

comment on table private.ai_disclosure_choices is 'What each person chose when told what AI features send to a third-party AI provider (Apple guideline 5.1.2(i), AI Features Notice): append-only, one row per choice, the latest one stands. A Declined choice turns AI features off for the person in every app.';
comment on column private.ai_disclosure_choices.id is 'Choice id (UUID v7).';
comment on column private.ai_disclosure_choices.person_id is 'Person who chose.';
comment on column private.ai_disclosure_choices.surface is 'Where the person chose: Atlas, Gateway or Compass.';
comment on column private.ai_disclosure_choices.disclosure_version is 'Version of the words the person was shown.';
comment on column private.ai_disclosure_choices.choice is 'Allowed or Declined.';
comment on column private.ai_disclosure_choices.decided_at is 'When the person chose. Set by the database.';
comment on column private.ai_disclosure_choices.ip is 'Client address the choice came from, as the platform server or the database saw it.';

alter table private.ai_disclosure_choices enable row level security;
revoke all on private.ai_disclosure_choices from public, anon, authenticated;
grant select on private.ai_disclosure_choices to service_role;

create or replace function private.ai_declined(p_person_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select c.choice = 'Declined' from private.ai_disclosure_choices c
    where c.person_id = p_person_id
    order by c.decided_at desc, c.id desc
    limit 1), false);
$$;

comment on function private.ai_declined(uuid) is 'True when the person''s latest AI choice is Declined. No recorded choice is not a decline.';
revoke all on function private.ai_declined(uuid) from public, anon, authenticated;

create or replace function app.record_ai_choice(
  p_surface text,
  p_disclosure_version text,
  p_choice text,
  p_client_ip inet default null
)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_at timestamptz;
begin
  if p_surface is null or p_surface not in ('Atlas', 'Gateway', 'Compass') then
    perform private.refuse('ai_choice_surface', 'Name the surface the choice came from: Atlas, Gateway or Compass.');
  end if;
  if p_choice is null or p_choice not in ('Allowed', 'Declined') then
    perform private.refuse('ai_choice_value', 'The choice is Allowed or Declined.');
  end if;
  if p_disclosure_version is null or char_length(btrim(p_disclosure_version)) not between 1 and 50 then
    perform private.refuse('ai_choice_version', 'Name the version of the words the person was shown.');
  end if;
  insert into private.ai_disclosure_choices (person_id, surface, disclosure_version, choice, ip)
  values (v_person, p_surface, btrim(p_disclosure_version), p_choice, coalesce(p_client_ip, private.request_ip()))
  returning decided_at into v_at;
  return v_at;
end;
$$;

comment on function app.record_ai_choice(text, text, text, inet) is 'Records what the signed-in person chose when told what AI features send to a third-party AI provider, with the version of the words they saw. Each choice adds a row and the latest stands. Answers the time.';
revoke all on function app.record_ai_choice(text, text, text, inet) from public, anon;
grant execute on function app.record_ai_choice(text, text, text, inet) to authenticated, service_role;

-- What a sign-in still owes ----------------------------------------------------------------------------------------------

create or replace function app.my_legal_standing()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_member boolean;
  v_engaged boolean;
  v_choice record;
begin
  v_member := exists (
    select 1 from app.memberships m
    where m.person_id = v_person and m.deleted_at is null and (m.valid_to is null or m.valid_to > now()));
  v_engaged := exists (select 1 from app.engagements e where e.person_id = v_person and e.deleted_at is null)
    or exists (select 1 from private.my_roster_entry_ids('roster'));
  select c.choice, c.disclosure_version, c.decided_at into v_choice
  from private.ai_disclosure_choices c
  where c.person_id = v_person
  order by c.decided_at desc, c.id desc
  limit 1;
  return jsonb_build_object(
    'age_confirmed', exists (
      select 1 from private.age_confirmations c where c.person_id = v_person and c.minimum_age = 18),
    'accepted_documents', coalesce((
      select jsonb_agg(distinct a.document_slug) from app.legal_acceptances a
      where a.person_id = v_person and a.org_id is null and a.deleted_at is null), '[]'::jsonb),
    -- The Worker Terms govern anyone not working purely as an org's member (Mobile EULA section 1).
    'worker_terms_apply', v_engaged or not v_member,
    'ai_choice', v_choice.choice,
    'ai_disclosure_version', v_choice.disclosure_version);
end;
$$;

comment on function app.my_legal_standing() is 'What the signed-in person has given so far, for the Compass first sign-in step: the 18 confirmation, the personal documents accepted at any version, whether the Worker Terms apply to them (they hold an engagement or a roster entry, or no active membership) and their latest AI choice with the version of the words they saw. Announced changes come from app.pending_legal_reacceptances.';
revoke all on function app.my_legal_standing() from public, anon;
grant execute on function app.my_legal_standing() to authenticated, service_role;

-- A decline binds on the server ------------------------------------------------------------------------------------------

create or replace function app.ai_begin_request(
  p_org_id uuid,
  p_feature app.ai_feature,
  p_model text,
  p_subject_table text default null,
  p_subject_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.current_person_id();
  v_request uuid;
begin
  if v_me is null or not private.is_member(p_org_id) then
    raise exception using errcode = '42501', message = 'Aurora requests need an active membership in the org';
  end if;
  if private.ai_declined(v_me) then
    perform private.refuse('ai_declined_by_person', 'You turned AI features off. Nothing was sent. You can turn them back on in Compass, Settings.');
  end if;
  if not private.org_has_feature(p_org_id, 'aurora_ai') then
    perform private.refuse('aurora_not_in_plan', 'Aurora AI is not in this org''s plan. Upgrade to Core or above to use it.');
  end if;
  if not private.ai_feature_enabled(p_org_id, p_feature) then
    perform private.refuse('aurora_feature_off', format('An Admin has not turned on %s in Settings, AI Features.', replace(p_feature::text, '_', ' ')));
  end if;
  -- One request at a time per org passes the count, so concurrent requests cannot overrun the allowance.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('aurora:' || p_org_id::text, 0));
  perform private.assert_within_plan_limit(p_org_id, 'aurora_requests_per_month', private.ai_requests_this_month(p_org_id) + 1);

  insert into app.ai_requests (org_id, person_id, feature, model, subject_table, subject_id)
  values (p_org_id, v_me, p_feature, p_model, p_subject_table, p_subject_id)
  returning id into v_request;
  insert into app.ai_usage (request_id) values (v_request);
  return v_request;
end;
$$;

comment on function app.ai_begin_request(uuid, app.ai_feature, text, text, uuid) is 'Authorizes and meters one Aurora request (ADR 0020): active membership, the person has not declined AI features (XR001 ai_declined_by_person), aurora_ai in the plan, the feature turned on, and the monthly allowance (XR001 plan_limit_exceeded when it is used up). Returns the request id the caller completes with app.ai_complete_request.';
revoke all on function app.ai_begin_request(uuid, app.ai_feature, text, text, uuid) from public, anon;
grant execute on function app.ai_begin_request(uuid, app.ai_feature, text, text, uuid) to authenticated, service_role;

create or replace function app.ai_enabled_features(p_org_id uuid)
returns setof app.ai_feature
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- plpgsql resolves 'aurora_ai' at call time: the enum value arrives in 0901, after this migration.
  if not private.is_member(p_org_id) or not private.org_has_feature(p_org_id, 'aurora_ai')
     or private.ai_declined(private.current_person_id()) then
    return;
  end if;
  return query select f from unnest(enum_range(null::app.ai_feature)) as f
    where private.ai_feature_enabled(p_org_id, f);
end;
$$;

comment on function app.ai_enabled_features(uuid) is 'Features a member may use right now: turned on by an Admin and included in the plan. Empty for non-members and for a person who declined AI features.';
revoke all on function app.ai_enabled_features(uuid) from public, anon;
grant execute on function app.ai_enabled_features(uuid) to authenticated, service_role;

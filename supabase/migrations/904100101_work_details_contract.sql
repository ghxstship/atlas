-- R6b (4.10): the contract half of R6a's expand and contract (4660 to 4664, applied in production). It drops the ten
-- retired profile columns from app.person_work_details: shirt_size, jacket_size, pants_size, shoe_size, glove_size,
-- hat_size and uniform_notes, and seat_preference, meal_preference and home_airport. Uniform sizes and travel preferences
-- are entered per roster entry (R5's app.roster_uniform_sizes and app.roster_travel_requests, which keep their own
-- columns of these names). API v1 stays additive: WorkDetails and SharedWorkDetails keep the fields, always null.
--
-- The enum value 'Uniform Sizes' stays on app.work_detail_category: app.work_detail_events, the seven-year append-only
-- access log (1340), holds it, and the API enum keeps it. R6a's constraint work_detail_shares_no_retired_category and the
-- share refusal keep it out of live shares. app.garment_letter_size and app.seat_preference stay, for R5's tables.
--
-- Functions start from their latest definitions: 6851_sensitive_data_restricted_reads.sql for
-- app.roster_shared_work_details, 6850_sensitive_data_consent.sql for private.guard_person_work_details and
-- 4664_work_details_profile_move.sql for private.log_work_detail_change. app.shared_work_details (4663) and
-- private.empty_work_details read none of the columns.

-- 1. Guard: R6a's move is complete and no live share names the retired category, or nothing changes.
do $guard$
begin
  if exists (select 1 from app.person_work_details where num_nonnulls(shirt_size, jacket_size, pants_size, shoe_size, glove_size, hat_size, uniform_notes, seat_preference, meal_preference, home_airport) > 0) then
    raise exception using errcode = 'P0001',
      message = 'R6b: a retired work detail column still holds a value; R6a''s move (4664) has not run';
  end if;
  if exists (select 1 from app.work_detail_shares s
             where 'Uniform Sizes' = any (s.categories) and s.revoked_at is null and s.deleted_at is null) then
    raise exception using errcode = 'P0001', message = 'R6b: a live work detail share still names Uniform Sizes';
  end if;
end;
$guard$;

-- 2. The roster read: uniform is null, and the travel object keeps its three keys, null, beside loyalty_programs.
create or replace function app.roster_shared_work_details(p_roster_entry_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_entry app.engagement_roster_entries;
  v_engagement app.engagements;
  v_person uuid;
  v_account uuid;
  v_reader text;
  v_share app.work_detail_shares;
  v_details app.person_work_details;
  v_readable app.work_detail_category[];
  v_holder boolean := false;
  v_medical boolean := false;
  v_diet_shared boolean := false;
  v_access_shared boolean := false;
  v_diet_ok boolean;
  v_access_ok boolean;
  v_diet_on_file boolean;
  v_access_on_file boolean;
  v_diet_unmasked boolean;
  v_access_unmasked boolean;
  v_allergies jsonb;
  v_logged app.work_detail_category[];
  v_log_org uuid;
begin
  select * into v_entry from app.engagement_roster_entries r where r.id = p_roster_entry_id and r.deleted_at is null;
  select * into v_engagement from app.engagements e where e.id = v_entry.engagement_id and e.deleted_at is null;
  if v_entry.id is null or v_engagement.id is null then
    raise exception using errcode = '42501', message = 'the roster entry is not readable';
  end if;
  v_person := private.roster_entry_person_id(v_entry.is_self, v_entry.person_id, v_engagement.person_id);
  select c.organization_id into v_account from app.counterparties c where c.id = v_engagement.counterparty_id;

  if private.work_detail_share_visible(v_engagement.id) then
    v_reader := 'org';
  elsif v_account is not null and v_person is not null and v_person <> v_me and v_entry.entry_state <> 'Withdrawn'
        and (v_entry.is_self or v_entry.person_response = 'Accepted')
        and private.can_manage_roster(v_engagement.id) and private.account_roster_consent(v_account, v_person) is not null then
    v_reader := 'company';
  else
    raise exception using errcode = '42501', message = 'the roster entry is not readable';
  end if;

  if not private.engagement_shares_work_details(v_engagement.engagement_state) then
    return private.empty_work_details(v_engagement, v_person, v_entry.id, v_reader);
  end if;
  select * into v_share from app.work_detail_shares s
  where s.roster_entry_id = v_entry.id and s.revoked_at is null and s.deleted_at is null;

  if v_reader = 'org' then
    if v_share.id is null then
      return private.empty_work_details(v_engagement, v_person, v_entry.id, v_reader);
    end if;
    select coalesce(array_agg(c order by c), '{}') into v_readable from unnest(v_share.categories) c
    where private.can_read_work_detail_category(v_engagement.project_id, c);
    -- The Restricted read: the share names the category and the reader holds the capability on the project.
    v_holder := private.can_on_project(v_engagement.project_id, 'data.restricted.read.medical');
    v_diet_shared := 'Dietary Needs' = any (v_share.categories);
    v_access_shared := 'Accessibility Needs' = any (v_share.categories);
    v_medical := v_holder and (v_diet_shared or v_access_shared);
    v_log_org := v_engagement.org_id;
  else
    -- Owner decision 4: the company reads every category of a person who accepted its roster entry, except the
    -- retired Uniform Sizes (R6a). ADR 0164: dietary, allergy and accessibility values stay masked for it.
    v_readable := array_remove(enum_range(null::app.work_detail_category), 'Uniform Sizes');
    v_log_org := v_account;
  end if;
  select * into v_details from app.person_work_details w where w.person_id = v_person and w.deleted_at is null;

  -- ADR 0164: nothing leaves while the person's consent does not stand.
  v_diet_ok := private.sensitive_consent_stands(v_person, 'Dietary and Allergies');
  v_access_ok := private.sensitive_consent_stands(v_person, 'Accessibility');
  v_diet_on_file := v_diet_ok and (cardinality(v_details.dietary_needs) > 0 or v_details.dietary_notes is not null);
  v_access_on_file := v_access_ok and (cardinality(v_details.accessibility_needs) > 0 or v_details.accessibility_notes is not null);
  v_diet_unmasked := v_holder and v_diet_shared and v_diet_on_file;
  v_access_unmasked := v_holder and v_access_shared and v_access_on_file;

  if cardinality(v_readable) > 0 or v_medical then
    v_logged := (select array_agg(distinct c order by c) from unnest(v_readable
      || case when v_holder and v_diet_shared then array['Dietary Needs']::app.work_detail_category[] else '{}'::app.work_detail_category[] end
      || case when v_holder and v_access_shared then array['Accessibility Needs']::app.work_detail_category[] else '{}'::app.work_detail_category[] end) c);
    -- Allergies leave only through the Restricted read, which logs each unmasked read; the company never holds it.
    if v_reader = 'org' and v_diet_ok and ('Dietary Needs' = any (v_readable) or (v_holder and v_diet_shared)) then
      v_allergies := private.read_allergies(v_engagement.project_id, v_person, v_engagement.org_id, v_engagement.id,
        'app.engagement_roster_entries', v_entry.id, v_details.allergies, v_entry.id);
    else
      v_allergies := jsonb_build_object('allergies', null, 'allergies_masked', v_diet_ok and v_details.allergies is not null);
    end if;
    perform private.log_work_detail_event(v_person, 'work_details.viewed', v_log_org, v_engagement.id, v_logged, '{}', null, v_entry.id);
    if v_diet_unmasked then
      perform private.log_work_detail_event(v_person, 'dietary_needs.viewed', v_log_org, v_engagement.id,
        array['Dietary Needs']::app.work_detail_category[], '{}', null, v_entry.id);
    end if;
    if v_access_unmasked then
      perform private.log_work_detail_event(v_person, 'accessibility_needs.viewed', v_log_org, v_engagement.id,
        array['Accessibility Needs']::app.work_detail_category[], '{}', null, v_entry.id);
    end if;
    perform private.write_audit_event(v_engagement.org_id, 'work_details.viewed', 'app.engagement_roster_entries', v_entry.id,
      jsonb_build_object('categories', to_jsonb(v_logged), 'reader', v_reader,
        'allergies_unmasked', v_allergies ->> 'allergies' is not null,
        'dietary_unmasked', v_diet_unmasked, 'accessibility_unmasked', v_access_unmasked));
  end if;

  return jsonb_build_object(
    'engagement_id', v_engagement.id,
    'person_id', v_person,
    'org_id', v_engagement.org_id,
    'roster_entry_id', v_entry.id,
    'reader', v_reader,
    'work_detail_share_id', v_share.id,
    'shared_at', v_share.shared_at,
    'categories', coalesce(to_jsonb(v_share.categories), '[]'::jsonb),
    'readable', to_jsonb(v_readable),
    'sharing_open', true,
    'emergency_contacts', case when 'Emergency Contacts' = any (v_readable) then coalesce((
      select jsonb_agg(jsonb_build_object('full_name', c.full_name, 'relationship', c.relationship, 'phone_e164', c.phone_e164,
        'alternate_phone_e164', c.alternate_phone_e164, 'email', c.email, 'sort_order', c.sort_order) order by c.sort_order, c.created_at)
      from app.person_emergency_contacts c where c.person_id = v_person and c.deleted_at is null), '[]'::jsonb) end,
    'contact', case when 'Contact' = any (v_readable) then jsonb_build_object(
      'email', private.recipient_address(v_person, 'Email'),
      'phone', private.recipient_address(v_person, 'SMS')) end,
    -- R6b: uniform sizes are entered per roster entry (R5's app.roster_uniform_sizes); the profile has none.
    'uniform', null,
    'dietary', case when 'Dietary Needs' = any (v_readable) then jsonb_build_object(
      'dietary_needs', to_jsonb(case when v_diet_unmasked then v_details.dietary_needs else '{}' end),
      'allergies', v_allergies -> 'allergies',
      'allergies_masked', coalesce((v_allergies ->> 'allergies_masked')::boolean, false),
      'allergies_on_file', v_diet_ok and v_details.allergies is not null,
      'dietary_notes', case when v_diet_unmasked then v_details.dietary_notes end,
      'dietary_masked', coalesce(v_diet_on_file and not v_diet_unmasked, false)) end,
    'medical', case when v_medical then jsonb_build_object(
      'allergies', case when v_diet_shared then v_allergies -> 'allergies' end,
      'dietary_needs', to_jsonb(case when v_diet_unmasked then v_details.dietary_needs else '{}' end),
      'dietary_notes', case when v_diet_unmasked then v_details.dietary_notes end,
      'accessibility_needs', to_jsonb(case when v_access_unmasked then v_details.accessibility_needs else '{}' end),
      'accessibility_notes', case when v_access_unmasked then v_details.accessibility_notes end) end,
    'accessibility', case when 'Accessibility Needs' = any (v_readable) then jsonb_build_object(
      'accessibility_needs', to_jsonb(case when v_access_unmasked then v_details.accessibility_needs else '{}' end),
      'accessibility_notes', case when v_access_unmasked then v_details.accessibility_notes end,
      'accessibility_masked', coalesce(v_access_on_file and not v_access_unmasked, false)) end,
    'travel', case when 'Travel Profile' = any (v_readable) then jsonb_build_object(
      -- R6b: travel preferences are entered per roster entry (R5's app.roster_travel_requests); the keys stay, null.
      'seat_preference', null, 'meal_preference', null, 'home_airport', null,
      'loyalty_programs', coalesce((
        select jsonb_agg(jsonb_build_object('program_kind', l.program_kind, 'program_name', l.program_name,
          'member_number', l.member_number) order by l.sort_order, l.program_kind, l.program_name)
        from app.person_loyalty_programs l where l.person_id = v_person and l.deleted_at is null), '[]'::jsonb)) end,
    'passport', case when 'Passport' = any (v_readable) then jsonb_build_object(
      'passport_number', null,
      'passport_number_last4', v_details.passport_number_last4,
      'passport_number_masked', v_details.passport_number_last4 is not null,
      'passport_issuing_country', v_details.passport_issuing_country,
      'passport_expires_on', v_details.passport_expires_on,
      'passport_name', v_details.passport_name) end
  );
end;
$$;

comment on function app.roster_shared_work_details(uuid) is 'The work details of the person on a roster entry (R4, owner decision 4; R6a; ADR 0164). Org readers (private.work_detail_share_visible) read the categories shared on the entry that their project capabilities cover; company readers (a roster manager who is not the person, while the person''s account_roster_sharing consent for the supplying account stands) read every category but the retired Uniform Sizes; anyone else gets 42501. Dietary needs and notes, allergies and accessibility needs and notes are Restricted and read as absent while the person''s sensitive data consent does not stand: they come back only to holders of data.restricted.read.medical on the project, in dietary or accessibility when the reader also reads the category and in medical whenever the share names it, each unmasked read logged; everyone else, the company always, reads them masked (dietary_masked, allergies_masked, accessibility_masked). contact is the verified sign-in email and phone. The passport number is always masked. Every read with something readable writes the person''s access log and the producing org''s audit ledger, without dedupe.';
revoke all on function app.roster_shared_work_details(uuid) from public, anon;
grant execute on function app.roster_shared_work_details(uuid) to authenticated, service_role;

-- 3. The guard no longer checks the dropped columns.
create or replace function private.guard_person_work_details()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT' and (new.passport_number is not null or new.passport_number_last4 is not null))
     or (tg_op = 'UPDATE' and (new.passport_number is distinct from old.passport_number
                               or new.passport_number_last4 is distinct from old.passport_number_last4)) then
    if not private.in_trusted_operation('passport_number_write') then
      perform private.refuse('passport_number_rpc_only', 'A passport number is written only through app.set_my_passport_number, which encrypts it.');
    end if;
  end if;
  -- Each need once, in enum order, so a diff shows a real change.
  new.dietary_needs := coalesce((select array_agg(distinct d order by d) from unnest(new.dietary_needs) d), '{}');
  new.accessibility_needs := coalesce((select array_agg(distinct a order by a) from unnest(new.accessibility_needs) a), '{}');
  -- ADR 0164: a new value needs the person's standing consent. Clearing one never does.
  if not private.sensitive_write_is_system() then
    if ((cardinality(new.dietary_needs) > 0 and (tg_op = 'INSERT' or new.dietary_needs is distinct from old.dietary_needs))
        or (new.allergies is not null and (tg_op = 'INSERT' or new.allergies is distinct from old.allergies))
        or (new.dietary_notes is not null and (tg_op = 'INSERT' or new.dietary_notes is distinct from old.dietary_notes)))
       and not private.sensitive_consent_stands(new.person_id, 'Dietary and Allergies') then
      perform private.refuse_without_sensitive_consent('Dietary and Allergies');
    end if;
    if ((cardinality(new.accessibility_needs) > 0 and (tg_op = 'INSERT' or new.accessibility_needs is distinct from old.accessibility_needs))
        or (new.accessibility_notes is not null and (tg_op = 'INSERT' or new.accessibility_notes is distinct from old.accessibility_notes)))
       and not private.sensitive_consent_stands(new.person_id, 'Accessibility') then
      perform private.refuse_without_sensitive_consent('Accessibility');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_person_work_details() is 'Person work details: the passport number and its last four change only inside the encrypting RPC; dietary and accessibility needs are kept once each, in enum order; a new dietary, allergy or accessibility value needs the person''s standing consent (sensitive_consent_required, ADR 0164), and clearing one never does. The retired uniform size and travel preference columns are gone (R6b).';
revoke all on function private.guard_person_work_details() from public, anon, authenticated;

-- 4. The change log, without R6a's move clause.
create or replace function private.log_work_detail_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_skip text[] := array['id', 'person_id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'passport_number', 'passport_number_last4'];
  v_old jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  v_new jsonb := to_jsonb(new);
  v_changed text[];
  v_verb text := lower(tg_op);
begin
  -- The erasure logs its own entry.
  if private.in_trusted_operation('work_details_erase') then
    return null;
  end if;
  select coalesce(array_agg(k order by k), '{}') into v_changed
  from jsonb_object_keys(v_new) k
  where k <> all (v_skip) and (v_new -> k) is distinct from (v_old -> k)
    and (tg_op = 'UPDATE' or (v_new -> k) not in ('null'::jsonb, '[]'::jsonb));
  if tg_op = 'UPDATE' and new.deleted_at is not null and old.deleted_at is null then
    v_verb := 'delete';
    v_changed := '{}';
  elsif tg_op = 'UPDATE' and cardinality(v_changed) = 0 then
    return null;
  end if;
  perform private.log_work_detail_event(new.person_id, tg_table_name || '.' || v_verb, null, null, '{}', v_changed, null);
  return null;
end;
$$;

comment on function private.log_work_detail_change() is 'After insert or update on the person-owned work detail tables: logs the change to app.work_detail_events with the names of the changed columns, never their values. A soft delete is logged as delete; the passport number is logged by its own RPC, and the erasure by its own.';
revoke all on function private.log_work_detail_change() from public, anon, authenticated;

-- 5. R6a's one-time move ran in 4664 and has nothing left to move.
drop function private.move_profile_work_details();

-- 6. The columns, with their checks and their column grants.
alter table app.person_work_details
  drop column shirt_size,
  drop column jacket_size,
  drop column pants_size,
  drop column shoe_size,
  drop column glove_size,
  drop column hat_size,
  drop column uniform_notes,
  drop column seat_preference,
  drop column meal_preference,
  drop column home_airport;

-- 7. Comments.
comment on table app.person_work_details is 'A person''s work details (Section 4.5.6 item 10): dietary needs and allergies, accessibility needs and the passport; loyalty programs and emergency contacts sit beside them. Uniform sizes and travel preferences are entered per roster entry (R6a); R6b dropped the profile columns that held them. Owned and read only by the person; an engaging org sees a category only while the person shares it with that engagement (app.work_detail_shares, app.shared_work_details). The passport number and allergies are Restricted; the passport number is encrypted.';
comment on type app.work_detail_category is 'Categories of a person''s work details that are shared with an engaging org one by one (Section 4.5.6 item 10). Contact is the person''s verified sign-in email and phone (R6a). Uniform Sizes is retired (R6a): sizes are entered per roster entry, no live share names it, and it stays for the access log rows that do (R6b dropped the profile columns). Travel Profile means loyalty programs; Passport is the passport details, kept separate so loyalty programs can be shared without them.';

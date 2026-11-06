-- 6162_guest_needs_and_attestation.sql
-- RRR-248 issue 5, ADR 0164. When someone else enters sensitive data for a person.
--
--   * app.guest_care_needs: a guest's dietary needs, allergies, accessibility needs and notes, one row per guest list entry,
--     beside the entry and never on it, all optional. It takes an attestation (private.sensitive_notice_versions,
--     app.sensitive_data_consents, basis Attested Authority) from the person entering it: they confirm they have the
--     guest's authority and that the guest has had notice. Written only through app.set_guest_care_needs by whoever keeps
--     the guest list: advancing.rider.write on the project, or the engagement's party for its own guests. Read only through
--     app.read_guest_care_needs, by holders of data.restricted.read.medical on the project, every read logged. The columns
--     are Restricted, so no export names them (export_medical_excluded, 0530); app.read_guest_care_needs serves the list a
--     holder downloads.
--   * The guest's email is optional. When it matches a verified sign-in, the attestation names that person: they get a
--     notice, see it under their Work Details and remove it. An account opened later with that email is linked and told by
--     the daily job, or sooner when the person acts. Changing the email, or another keeper entering values, closes the
--     attestation and opens a new one with who gave it.
--   * A person who withdrew a category cannot be attested back into it, and whoever types their email cannot tell: that
--     category is simply not saved, and the call answers the same. Only their access log shows it. The company that rosters a
--     person knows them already, and is told only that the person enters this themselves (sensitive_person_only).
--   * The company that rosters a person attests the same way before it enters that person's meal preference
--     (app.attest_roster_meal_preference). The person's own meal preference needs their own consent. A meal preference is
--     masked everywhere but for the person and for holders of data.restricted.read.medical on the project, and it reads as
--     absent while neither the person's consent nor the company's attestation stands. The company cannot read it back.
--   * private.looks_sensitive refuses free text that names these needs where no consent step exists: a guest's door note
--     (guest_note_sensitive), a roster entry's travel notes (travel_note_sensitive), a mapped import column
--     (import_sensitive_column) and a custom field label (custom_field_sensitive). private.question_looks_sensitive does the
--     same for a question to fill in (question_sensitive): application questions and their templates, surveys and no-code
--     forms. These are backstops for the common words in English and Spanish; they do not read minds.
--   * A guest's needs are deleted when the entry is removed or declined, and 90 days after the project ends (6163). A legal
--     hold over the org's guest needs, or over the matched person, keeps the values, hidden, until it ends.
-- Functions start from their latest definitions: 6160_sensitive_data_consent.sql for private.erase_sensitive_category,
-- 4655_roster_project_fact_rpcs.sql for app.save_roster_travel_request, private.roster_travel_value and
-- private.roster_project_facts_object, 5942_transfer_views.sql for app.roster_travel_party.

-- The backstop for free text ------------------------------------------------------------------------------------------

create or replace function private.looks_sensitive(p_text text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_text, '') ~* '(allerg|alerg|dietary|diet\M|dieta\M|dietétic|dietetic|vegan|vegetarian|pescatarian|kosher|halal|gluten|celiac|celíac|nut[- ]free|intoleran|anaphyla|anafila|epipen|wheelchair|silla de ruedas|disabilit|disabled|discapacid|accesibilidad|accessibility|service animal|animal de servicio|sign language|lengua de señas|interpreter|intérprete|medical condition|condición médica|supplier diversity|minority[- ]owned|women[- ]owned|veteran[- ]owned|lgbt)';
$$;

comment on function private.looks_sensitive(text) is 'True when free text names a dietary, allergy, accessibility or protected-group need in common English or Spanish words (ADR 0164): a backstop that sends a person to the consent step, not a classifier.';
revoke all on function private.looks_sensitive(text) from public, anon, authenticated;

create or replace function private.question_looks_sensitive(p_text text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_text, '') ~* '(allerg(?!en)|alerg(?!en)|dietary|diet\M|dieta\M|dietétic|dietetic|vegan|vegetarian|pescatarian|kosher|halal|celiac|celíac|intoleran|anaphyla|anafila|epipen|disabilit|disabled|discapacid|medical condition|condición médica|supplier diversity|minority[- ]owned|women[- ]owned|veteran[- ]owned|lgbt)'
    or (coalesce(p_text, '') ~* '(accessib|accesib|wheelchair|silla de ruedas|service animal|animal de servicio|sign language|lengua de señas|interpreter|intérprete|gluten)'
        and coalesce(p_text, '') ~* '\m(need|needs|needed|require|required|requires|requirement|requirements|accommodation|accommodations|necesit\w*|requier\w*|ajuste|ajustes)\M');
$$;

comment on function private.question_looks_sensitive(text) is 'True when the label of a question to fill in asks for a dietary, allergy, accessibility or protected-group need (ADR 0164). Narrower than private.looks_sensitive: a venue checklist''s "Accessible routes clear?" and a certificate''s "Allergen awareness" are about the work and pass; "Do you need wheelchair access?" and "Any allergies?" ask about a person and do not.';
revoke all on function private.question_looks_sensitive(text) from public, anon, authenticated;

-- Guest needs ---------------------------------------------------------------------------------------------------------

insert into private.read_only_exempt_tables (table_name, rationale) values
  ('app.guest_care_needs', 'A guest''s needs are removed at any time, also while the org is read-only; app.set_guest_care_needs refuses new values with a read-only org.');

insert into private.trash_excluded_tables (table_name, rationale) values
  ('guest_care_needs', 'A guest''s needs are deleted when removed, never restored by someone else.'),
  ('sensitive_data_consents', 'Consent is withdrawn, never restored by someone else.'),
  ('sensitive_field_records', 'Written only by the database, as evidence.');

create table app.guest_care_needs (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  guest_list_entry_id uuid not null references app.guest_list_entries (id) on delete cascade,
  dietary_needs app.dietary_need[] not null default '{}',
  allergies text,
  dietary_notes text,
  accessibility_needs app.accessibility_need[] not null default '{}',
  accessibility_notes text,
  guest_email text,
  guest_person_id uuid references app.people (id),
  deleted_at timestamptz,
  constraint guest_care_needs_allergies check (allergies is null or char_length(btrim(allergies)) between 1 and 500),
  constraint guest_care_needs_dietary_notes check (dietary_notes is null or char_length(btrim(dietary_notes)) between 1 and 500),
  constraint guest_care_needs_accessibility_notes check (accessibility_notes is null or char_length(btrim(accessibility_notes)) between 1 and 1000),
  constraint guest_care_needs_guest_email check (guest_email is null or (guest_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(guest_email) <= 320))
);

create unique index guest_care_needs_entry_key on app.guest_care_needs (guest_list_entry_id);
create index guest_care_needs_project_id_idx on app.guest_care_needs (project_id);
create index guest_care_needs_guest_person_id_idx on app.guest_care_needs (guest_person_id);

call private.install_project_table('app.guest_care_needs', 'data.restricted.read.medical', 'data.restricted.read.medical',
  array['app.guest_list_entries', 'guest_list_entry_id']);
call private.describe('app.guest_care_needs', 'A guest''s dietary and accessibility needs, entered by whoever keeps the guest list under an attestation that they have the guest''s authority and that the guest has had notice (app.sensitive_data_consents). All optional. Restricted: written only through app.set_guest_care_needs and read only through app.read_guest_care_needs, every read logged. Deleted when the entry is removed or declined and 90 days after the project ends.', array[
  'project_id', 'Project of the guest list entry.',
  'guest_list_entry_id', 'Guest the needs are for.',
  'dietary_needs', 'Dietary needs, each once, in enum order. Restricted (data.restricted.read.medical).',
  'allergies', 'Allergies, with how severe. Restricted (data.restricted.read.medical).',
  'dietary_notes', 'Other dietary notes. Restricted (data.restricted.read.medical).',
  'accessibility_needs', 'Accessibility needs, each once, in enum order. Restricted (data.restricted.read.medical).',
  'accessibility_notes', 'Accessibility needs in words. Restricted (data.restricted.read.medical).',
  'guest_email', 'The guest''s email, when given, so they can see this and remove it. Restricted (data.restricted.read.medical).',
  'guest_person_id', 'Person whose verified sign-in matches the email when it was entered; NULL otherwise.'
]);

revoke all on app.guest_care_needs from authenticated;
grant select (id, org_id, project_id, guest_list_entry_id, created_at, created_by, updated_at, updated_by, deleted_at)
  on app.guest_care_needs to authenticated;
grant all on app.guest_care_needs to service_role;

insert into private.column_classifications (table_name, column_name, classification, read_capability) values
  ('app.guest_care_needs', 'dietary_needs', 'Restricted', 'data.restricted.read.medical'),
  ('app.guest_care_needs', 'allergies', 'Restricted', 'data.restricted.read.medical'),
  ('app.guest_care_needs', 'dietary_notes', 'Restricted', 'data.restricted.read.medical'),
  ('app.guest_care_needs', 'accessibility_needs', 'Restricted', 'data.restricted.read.medical'),
  ('app.guest_care_needs', 'accessibility_notes', 'Restricted', 'data.restricted.read.medical'),
  ('app.guest_care_needs', 'guest_email', 'Restricted', 'data.restricted.read.medical');

insert into private.ai_excluded_tables (table_name, reason) values
  ('app.guest_care_needs', 'A guest''s dietary and accessibility needs are health data (Section 14.3, ADR 0164).');

call private.install_default_retention('app.guest_care_needs', interval '90 days');

insert into private.sensitive_fields (code, category, table_name, column_name, sort_order) values
  ('meal_preference', 'Dietary and Allergies', 'app.roster_travel_requests', 'meal_preference', 40),
  ('guest_dietary_needs', 'Dietary and Allergies', 'app.guest_care_needs', 'dietary_needs', 90),
  ('guest_allergies', 'Dietary and Allergies', 'app.guest_care_needs', 'allergies', 100),
  ('guest_dietary_notes', 'Dietary and Allergies', 'app.guest_care_needs', 'dietary_notes', 110),
  ('guest_accessibility_needs', 'Accessibility', 'app.guest_care_needs', 'accessibility_needs', 120),
  ('guest_accessibility_notes', 'Accessibility', 'app.guest_care_needs', 'accessibility_notes', 130);

create or replace function private.person_with_verified_email(p_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id from app.people p
  join auth.users u on u.id = p.user_id
  where p_email is not null and lower(u.email) = lower(btrim(p_email)) and u.email_confirmed_at is not null and p.deleted_at is null
  order by p.created_at
  limit 1;
$$;

comment on function private.person_with_verified_email(text) is 'The person whose confirmed sign-in email is this address, or NULL. It never leaves the database, and nothing a caller sees depends on it: a caller learns nothing about whether an address has an account.';
revoke all on function private.person_with_verified_email(text) from public, anon, authenticated;

create or replace function private.verified_email_of(p_person_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select lower(u.email) from auth.users u
  join app.people p on p.user_id = u.id
  where p.id = p_person_id and u.email_confirmed_at is not null;
$$;

comment on function private.verified_email_of(uuid) is 'The person''s confirmed sign-in email, lower case, or NULL.';
revoke all on function private.verified_email_of(uuid) from public, anon, authenticated;

create or replace function private.link_guest_needs_to_person(p_person_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_email text := private.verified_email_of(p_person_id);
  v_count integer;
begin
  if v_email is null then
    return 0;
  end if;
  perform private.begin_trusted_operation('sensitive_guest_link');
  update app.sensitive_data_consents c set person_id = p_person_id
  from app.guest_care_needs n
  where n.guest_list_entry_id = c.guest_list_entry_id and n.guest_person_id is null and n.guest_email = v_email
    and c.person_id is null and c.withdrawn_at is null;
  perform private.end_trusted_operation('sensitive_guest_link');
  update app.sensitive_field_records r set person_id = p_person_id
  from app.guest_care_needs n
  where n.guest_list_entry_id = r.guest_list_entry_id and n.guest_person_id is null and n.guest_email = v_email and r.person_id is null;
  update app.guest_care_needs n set guest_person_id = p_person_id
  where n.guest_person_id is null and n.guest_email = v_email;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function private.link_guest_needs_to_person(uuid) is 'Names the person on guest needs that hold their verified email and no person yet: an account opened, or an address confirmed, after the entry. Withdrawing, removing an entry, deleting the account and the daily job all start here. Returns how many entries it linked.';
revoke all on function private.link_guest_needs_to_person(uuid) from public, anon, authenticated;

create or replace function private.person_withdrew_sensitive(p_person_id uuid, p_category app.sensitive_data_category)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_person_id is not null and not private.sensitive_consent_stands(p_person_id, p_category)
    and exists (select 1 from app.sensitive_data_consents c
                where c.person_id = p_person_id and c.category = p_category and c.withdrawn_at is not null
                  and c.withdrawn_by = p_person_id);
$$;

comment on function private.person_withdrew_sensitive(uuid, app.sensitive_data_category) is 'True when the person themselves withdrew a category and has not consented again, so nobody else can attest them back into it.';
revoke all on function private.person_withdrew_sensitive(uuid, app.sensitive_data_category) from public, anon, authenticated;

create or replace function private.can_keep_guest_needs(p_entry app.guest_list_entries)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.can_on_project(p_entry.project_id, 'advancing.rider.write')
    or (p_entry.engagement_id is not null and exists (
      select 1 from app.engagements e
      where e.id = p_entry.engagement_id and e.deleted_at is null
        and private.guest_party_open(e.project_id, e.person_id, e.counterparty_id)));
$$;

comment on function private.can_keep_guest_needs(app.guest_list_entries) is 'True when the signed-in person keeps this guest''s entry: advancing.rider.write on the project, or the party of the engagement the guest was requested under.';
revoke all on function private.can_keep_guest_needs(app.guest_list_entries) from public, anon, authenticated;

create or replace function private.guest_needs_on_hold(p_needs app.guest_care_needs)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_needs.id is not null and (p_needs.org_id in (select private.held_org_ids('app.guest_care_needs'))
    or (p_needs.guest_person_id is not null and private.person_on_legal_hold(p_needs.guest_person_id)));
$$;

comment on function private.guest_needs_on_hold(app.guest_care_needs) is 'True while a legal hold over the org''s guest needs, or over the person they name, keeps this row''s values.';
revoke all on function private.guest_needs_on_hold(app.guest_care_needs) from public, anon, authenticated;

create or replace function private.close_guest_needs(p_entry_id uuid, p_category app.sensitive_data_category default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_needs app.guest_care_needs;
begin
  update app.sensitive_data_consents c set withdrawn_at = now(), withdrawn_by = private.current_person_id()
  where c.guest_list_entry_id = p_entry_id and c.withdrawn_at is null and (p_category is null or c.category = p_category);
  select * into v_needs from app.guest_care_needs n where n.guest_list_entry_id = p_entry_id for update;
  -- Use stopped above: with no standing attestation nothing reads the values. A hold keeps them until the daily job (6163).
  if v_needs.id is null or private.guest_needs_on_hold(v_needs) then
    return;
  end if;
  if p_category is null or p_category = 'Dietary and Allergies' then
    perform private.record_sensitive_field('guest_dietary_needs', false, null, null, null, p_entry_id);
    perform private.record_sensitive_field('guest_allergies', false, null, null, null, p_entry_id);
    perform private.record_sensitive_field('guest_dietary_notes', false, null, null, null, p_entry_id);
  end if;
  if p_category is null or p_category = 'Accessibility' then
    perform private.record_sensitive_field('guest_accessibility_needs', false, null, null, null, p_entry_id);
    perform private.record_sensitive_field('guest_accessibility_notes', false, null, null, null, p_entry_id);
  end if;
  if p_category is null then
    delete from app.guest_care_needs n where n.id = v_needs.id;
  elsif p_category = 'Dietary and Allergies' then
    update app.guest_care_needs n set dietary_needs = '{}', allergies = null, dietary_notes = null where n.id = v_needs.id;
  else
    update app.guest_care_needs n set accessibility_needs = '{}', accessibility_notes = null where n.id = v_needs.id;
  end if;
  delete from app.guest_care_needs n
  where n.id = v_needs.id and cardinality(n.dietary_needs) = 0 and n.allergies is null and n.dietary_notes is null
    and cardinality(n.accessibility_needs) = 0 and n.accessibility_notes is null;
end;
$$;

comment on function private.close_guest_needs(uuid, app.sensitive_data_category) is 'Withdraws the attestations of a guest entry, for one category or all, and deletes those values, deleting the row once nothing is left. The attestations stay as evidence. Under a legal hold the attestations close and the values stay, read by nobody, until the daily job (6163) deletes them after the hold ends.';
revoke all on function private.close_guest_needs(uuid, app.sensitive_data_category) from public, anon, authenticated;

create or replace function app.set_guest_care_needs(
  p_guest_list_entry_id uuid,
  p_dietary_needs app.dietary_need[] default '{}',
  p_allergies text default null,
  p_dietary_notes text default null,
  p_accessibility_needs app.accessibility_need[] default '{}',
  p_accessibility_notes text default null,
  p_guest_email text default null,
  p_authority_confirmed boolean default false,
  p_notice_confirmed boolean default false,
  p_dietary_notice_version text default null,
  p_accessibility_notice_version text default null,
  p_locale text default null,
  p_surface app.sensitive_consent_surface default 'Atlas',
  p_client_ip inet default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_entry app.guest_list_entries;
  v_existing app.guest_care_needs;
  v_diet app.dietary_need[] := coalesce((select array_agg(distinct d order by d) from unnest(p_dietary_needs) d where d is not null), '{}');
  v_access app.accessibility_need[] := coalesce((select array_agg(distinct a order by a) from unnest(p_accessibility_needs) a where a is not null), '{}');
  v_allergies text := nullif(btrim(p_allergies), '');
  v_diet_notes text := nullif(btrim(p_dietary_notes), '');
  v_access_notes text := nullif(btrim(p_accessibility_notes), '');
  v_email text := nullif(lower(btrim(p_guest_email)), '');
  v_asked_diet boolean;
  v_asked_access boolean;
  v_keep_diet boolean;
  v_keep_access boolean;
  v_held boolean;
  v_person uuid;
  v_named uuid;
  v_category app.sensitive_data_category;
  v_asked boolean;
  v_keep boolean;
  v_version text;
  v_standing app.sensitive_data_consents;
  v_consent uuid;
  v_user uuid;
begin
  select * into v_entry from app.guest_list_entries g where g.id = p_guest_list_entry_id and g.deleted_at is null;
  if v_entry.id is null or not private.can_keep_guest_needs(v_entry) then
    raise exception using errcode = '42501', message = 'the guest list entry is not writable';
  end if;
  if private.org_read_only(v_entry.org_id) then
    perform private.refuse('org_read_only', 'This organization is canceled and read-only, so nothing more is entered for it.');
  end if;
  v_asked_diet := cardinality(v_diet) > 0 or v_allergies is not null or v_diet_notes is not null;
  v_asked_access := cardinality(v_access) > 0 or v_access_notes is not null;
  if not v_asked_diet and not v_asked_access then
    perform private.close_guest_needs(v_entry.id);
    return null;
  end if;
  if not (coalesce(p_authority_confirmed, false) and coalesce(p_notice_confirmed, false)) then
    perform private.refuse('sensitive_attestation_required', 'Confirm you have the guest''s authority to enter this and that they have had notice.');
  end if;
  if v_asked_diet then
    perform private.assert_sensitive_notice('Dietary and Allergies', p_dietary_notice_version, p_locale);
  end if;
  if v_asked_access then
    perform private.assert_sensitive_notice('Accessibility', p_accessibility_notice_version, p_locale);
  end if;

  -- A person who withdrew is not attested back in, and the caller cannot tell: a refusal here would answer whether an address
  -- has an account, and whether its owner withdrew. Their category is not saved; the answer, the attestation and the audit
  -- entry are the same; only the person's own access log shows it.
  v_person := private.person_with_verified_email(v_email);
  v_keep_diet := v_asked_diet and not private.person_withdrew_sensitive(v_person, 'Dietary and Allergies');
  v_keep_access := v_asked_access and not private.person_withdrew_sensitive(v_person, 'Accessibility');
  if not v_keep_diet then
    v_diet := '{}';
    v_allergies := null;
    v_diet_notes := null;
  end if;
  if not v_keep_access then
    v_access := '{}';
    v_access_notes := null;
  end if;

  select * into v_existing from app.guest_care_needs n where n.guest_list_entry_id = v_entry.id for update;
  v_held := private.guest_needs_on_hold(v_existing);
  if v_keep_diet or v_keep_access then
    insert into app.guest_care_needs as n (project_id, guest_list_entry_id, dietary_needs, allergies, dietary_notes, accessibility_needs,
      accessibility_notes, guest_email, guest_person_id)
    values (v_entry.project_id, v_entry.id, v_diet, v_allergies, v_diet_notes, v_access, v_access_notes, v_email, v_person)
    on conflict (guest_list_entry_id) do update set
      dietary_needs = case when v_keep_diet or not v_held then excluded.dietary_needs else n.dietary_needs end,
      allergies = case when v_keep_diet or not v_held then excluded.allergies else n.allergies end,
      dietary_notes = case when v_keep_diet or not v_held then excluded.dietary_notes else n.dietary_notes end,
      accessibility_needs = case when v_keep_access or not v_held then excluded.accessibility_needs else n.accessibility_needs end,
      accessibility_notes = case when v_keep_access or not v_held then excluded.accessibility_notes else n.accessibility_notes end,
      guest_email = excluded.guest_email,
      guest_person_id = excluded.guest_person_id;
  end if;

  foreach v_category in array array['Dietary and Allergies', 'Accessibility']::app.sensitive_data_category[] loop
    v_asked := case when v_category = 'Dietary and Allergies' then v_asked_diet else v_asked_access end;
    v_keep := case when v_category = 'Dietary and Allergies' then v_keep_diet else v_keep_access end;
    v_version := case when v_category = 'Dietary and Allergies' then p_dietary_notice_version else p_accessibility_notice_version end;
    if not v_keep then
      perform private.close_guest_needs(v_entry.id, v_category);
    end if;
    continue when not v_asked;

    -- The record says who attested, about whom. Another keeper, or another person matched, is a new attestation.
    v_named := case when v_keep then v_person end;
    select * into v_standing from app.sensitive_data_consents c
    where c.guest_list_entry_id = v_entry.id and c.category = v_category and c.withdrawn_at is null;
    if v_standing.id is not null and (v_standing.given_by is distinct from v_me or v_standing.person_id is distinct from v_named) then
      update app.sensitive_data_consents c set withdrawn_at = now(), withdrawn_by = null where c.id = v_standing.id;
      v_standing := null;
    end if;
    v_consent := v_standing.id;
    if v_consent is null then
      insert into app.sensitive_data_consents (category, basis, person_id, guest_list_entry_id, org_id, notice_version, locale, surface,
        authority_confirmed, notice_confirmed, given_by, captured_ip)
      values (v_category, 'Attested Authority', v_named, v_entry.id, v_entry.org_id, v_version, p_locale, p_surface, true, true, v_me, p_client_ip)
      returning id into v_consent;
      perform private.write_audit_event(v_entry.org_id, 'guest_needs.attested', 'app.guest_list_entries', v_entry.id,
        jsonb_build_object('category', v_category, 'notice_version', v_version));
      if v_named is not null then
        select p.user_id into v_user from app.people p where p.id = v_named;
        perform private.log_work_detail_event(v_named, 'sensitive_consent.attested', v_entry.org_id, null, '{}', '{}', null);
        if v_user is not null then
          begin
            perform private.notify_account(v_user, 'account.sensitive_data_attested', jsonb_build_object('category', v_category));
          exception when others then
            raise warning 'account.sensitive_data_attested was not sent to sign-in %: %', v_user, sqlerrm;
          end;
        end if;
      end if;
    end if;
    if not v_keep then
      perform private.log_work_detail_event(v_person, 'sensitive_consent.attestation_not_saved', v_entry.org_id, null, '{}', '{}', null);
    elsif v_category = 'Dietary and Allergies' then
      perform private.record_sensitive_field('guest_dietary_needs', cardinality(v_diet) > 0, v_consent, v_person, null, v_entry.id);
      perform private.record_sensitive_field('guest_allergies', v_allergies is not null, v_consent, v_person, null, v_entry.id);
      perform private.record_sensitive_field('guest_dietary_notes', v_diet_notes is not null, v_consent, v_person, null, v_entry.id);
    else
      perform private.record_sensitive_field('guest_accessibility_needs', cardinality(v_access) > 0, v_consent, v_person, null, v_entry.id);
      perform private.record_sensitive_field('guest_accessibility_notes', v_access_notes is not null, v_consent, v_person, null, v_entry.id);
    end if;
  end loop;
  return v_entry.id;
end;
$$;

comment on function app.set_guest_care_needs(uuid, app.dietary_need[], text, text, app.accessibility_need[], text, text, boolean, boolean, text, text, text, app.sensitive_consent_surface, inet) is 'Whoever keeps a guest''s entry sets the guest''s dietary and accessibility needs, each optional, as a full replacement, confirming they have the guest''s authority and that the guest has had notice (sensitive_attestation_required), with the version of the wording shown for each category and the language (sensitive_notice_version, sensitive_notice_locale). Attested per category and audited, never with values; another keeper or another matched person is a new attestation. Nothing given clears the row. An email matching a verified sign-in names that person, who is told and can remove it. A person who withdrew that category is not attested back in: the category is not saved, the answer is the same, and only their access log shows it. Returns the guest list entry id, or NULL when cleared.';
revoke all on function app.set_guest_care_needs(uuid, app.dietary_need[], text, text, app.accessibility_need[], text, text, boolean, boolean, text, text, text, app.sensitive_consent_surface, inet) from public, anon;
grant execute on function app.set_guest_care_needs(uuid, app.dietary_need[], text, text, app.accessibility_need[], text, text, boolean, boolean, text, text, text, app.sensitive_consent_surface, inet) to authenticated, service_role;

create or replace function app.clear_guest_care_needs(p_guest_list_entry_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_entry app.guest_list_entries;
begin
  perform private.require_person();
  select * into v_entry from app.guest_list_entries g where g.id = p_guest_list_entry_id;
  if v_entry.id is null or not private.can_keep_guest_needs(v_entry) then
    raise exception using errcode = '42501', message = 'the guest list entry is not writable';
  end if;
  perform private.close_guest_needs(v_entry.id);
  perform private.write_audit_event(v_entry.org_id, 'guest_needs.cleared', 'app.guest_list_entries', v_entry.id, '{}'::jsonb);
end;
$$;

comment on function app.clear_guest_care_needs(uuid) is 'Whoever keeps a guest''s entry deletes the guest''s needs and withdraws the attestation, in one call, also while the org is read-only.';
revoke all on function app.clear_guest_care_needs(uuid) from public, anon;
grant execute on function app.clear_guest_care_needs(uuid) to authenticated, service_role;

create or replace function app.guest_care_needs_states(p_project_id uuid)
returns table (
  guest_list_entry_id uuid,
  categories app.sensitive_data_category[],
  given_by_name text,
  given_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.guest_list_entry_id, array_agg(c.category order by c.category), max(p.full_name), max(c.given_at)
  from app.sensitive_data_consents c
  join app.guest_list_entries g on g.id = c.guest_list_entry_id
  left join app.people p on p.id = c.given_by
  where c.withdrawn_at is null and g.project_id = p_project_id and g.deleted_at is null and private.can_keep_guest_needs(g)
  group by c.guest_list_entry_id;
$$;

comment on function app.guest_care_needs_states(uuid) is 'Which guests of a project have attested needs, in which categories, who attested and when, never the values: for whoever keeps the guest list, who does not read them back without data.restricted.read.medical.';
revoke all on function app.guest_care_needs_states(uuid) from public, anon;
grant execute on function app.guest_care_needs_states(uuid) to authenticated, service_role;

create or replace function app.can_read_guest_care_needs(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.can_on_project(p_project_id, 'data.restricted.read.medical');
$$;

comment on function app.can_read_guest_care_needs(uuid) is 'True when the signed-in person holds data.restricted.read.medical on the project, so a page offers the read of guests'' needs.';
revoke all on function app.can_read_guest_care_needs(uuid) from public, anon;
grant execute on function app.can_read_guest_care_needs(uuid) to authenticated, service_role;

create or replace function app.read_guest_care_needs(p_project_id uuid, p_for_export boolean default false)
returns table (
  guest_list_entry_id uuid,
  guest_name text,
  dietary_needs app.dietary_need[],
  allergies text,
  dietary_notes text,
  accessibility_needs app.accessibility_need[],
  accessibility_notes text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_org uuid;
  v_count integer := 0;
begin
  perform private.require_person();
  if not private.can_on_project(p_project_id, 'data.restricted.read.medical') then
    raise exception using errcode = '42501', message = 'data.restricted.read.medical is required';
  end if;
  for v_row in
    select x.* from (
      select n.org_id, n.guest_list_entry_id, g.guest_name, n.dietary_needs, n.allergies, n.dietary_notes, n.accessibility_needs,
        n.accessibility_notes, n.guest_person_id,
        exists (select 1 from app.sensitive_data_consents c where c.guest_list_entry_id = n.guest_list_entry_id
                and c.category = 'Dietary and Allergies' and c.withdrawn_at is null) as dietary_stands,
        exists (select 1 from app.sensitive_data_consents c where c.guest_list_entry_id = n.guest_list_entry_id
                and c.category = 'Accessibility' and c.withdrawn_at is null) as accessibility_stands
      from app.guest_care_needs n
      join app.guest_list_entries g on g.id = n.guest_list_entry_id and g.deleted_at is null
      where n.project_id = p_project_id) x
    where x.dietary_stands or x.accessibility_stands
    order by x.guest_name
  loop
    guest_list_entry_id := v_row.guest_list_entry_id;
    guest_name := v_row.guest_name;
    -- Each category stands alone: a withdrawn one a legal hold keeps reads as absent.
    dietary_needs := case when v_row.dietary_stands then v_row.dietary_needs else '{}' end;
    allergies := case when v_row.dietary_stands then v_row.allergies end;
    dietary_notes := case when v_row.dietary_stands then v_row.dietary_notes end;
    accessibility_needs := case when v_row.accessibility_stands then v_row.accessibility_needs else '{}' end;
    accessibility_notes := case when v_row.accessibility_stands then v_row.accessibility_notes end;
    v_org := v_row.org_id;
    v_count := v_count + 1;
    if v_row.guest_person_id is not null then
      perform private.log_work_detail_event(v_row.guest_person_id, 'guest_needs.viewed', v_row.org_id, null, '{}', '{}', null);
    end if;
    return next;
  end loop;
  if v_count > 0 then
    perform private.write_audit_event(v_org, case when p_for_export then 'guest_needs.exported' else 'guest_needs.viewed' end,
      'app.projects', p_project_id, jsonb_build_object('guests', v_count));
  end if;
end;
$$;

comment on function app.read_guest_care_needs(uuid, boolean) is 'The guests'' needs on a project, for holders of data.restricted.read.medical on it, else 42501. Every call is written to the org''s audit ledger (guest_needs.viewed, or guest_needs.exported when it serves a download) and to the access log of each guest with an account. A category with no standing attestation reads as absent.';
revoke all on function app.read_guest_care_needs(uuid, boolean) from public, anon;
grant execute on function app.read_guest_care_needs(uuid, boolean) to authenticated, service_role;

-- A guest's needs go with the guest -----------------------------------------------------------------------------------

create or replace function private.close_guest_needs_on_exit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (new.deleted_at is not null and old.deleted_at is null) or (new.entry_state = 'Declined' and old.entry_state <> 'Declined') then
    perform private.close_guest_needs(new.id);
  end if;
  return null;
end;
$$;

comment on function private.close_guest_needs_on_exit() is 'After a guest list entry is removed or declined: deletes the guest''s needs and withdraws the attestation.';
revoke all on function private.close_guest_needs_on_exit() from public, anon, authenticated;

create trigger t86_close_guest_needs_on_exit after update of deleted_at, entry_state on app.guest_list_entries
  for each row execute function private.close_guest_needs_on_exit();

-- Free text has no consent step ---------------------------------------------------------------------------------------

create or replace function private.refuse_sensitive_guest_note()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.looks_sensitive(new.note) and not private.sensitive_write_is_system() then
    perform private.refuse('guest_note_sensitive', 'Leave dietary and accessibility needs out of the door note. Use the guest''s needs step, which records consent.');
  end if;
  return new;
end;
$$;

comment on function private.refuse_sensitive_guest_note() is 'Before a guest''s door note is written: refuses words that name a dietary or accessibility need (guest_note_sensitive, ADR 0164), because the note has no consent step and every guest list reader sees it.';
revoke all on function private.refuse_sensitive_guest_note() from public, anon, authenticated;

create trigger t42_refuse_sensitive_guest_note before insert or update of note on app.guest_list_entries
  for each row execute function private.refuse_sensitive_guest_note();

create or replace function private.refuse_sensitive_import_column()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.field_name is not null and new.field_name is distinct from old.field_name and private.looks_sensitive(new.header) then
    perform private.refuse('import_sensitive_column', 'This column looks like dietary, accessibility or diversity data. An import cannot record consent for it, so leave it unmapped and enter it on each record.');
  end if;
  return new;
end;
$$;

comment on function private.refuse_sensitive_import_column() is 'Before an import column is mapped: refuses a source header that names sensitive data (import_sensitive_column, ADR 0164). The rest of the sheet still imports.';
revoke all on function private.refuse_sensitive_import_column() from public, anon, authenticated;

create trigger t42_refuse_sensitive_import_column before update of field_name on app.import_job_columns
  for each row execute function private.refuse_sensitive_import_column();

create or replace function private.refuse_sensitive_custom_field()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.looks_sensitive(new.label) and not private.sensitive_write_is_system() then
    perform private.refuse('custom_field_sensitive', 'A custom field cannot hold dietary, accessibility or diversity data, because it has no consent step. Use Work Details or the guest''s needs step.');
  end if;
  return new;
end;
$$;

comment on function private.refuse_sensitive_custom_field() is 'Before a custom field is defined or renamed: refuses a label that names sensitive data (custom_field_sensitive, ADR 0164).';
revoke all on function private.refuse_sensitive_custom_field() from public, anon, authenticated;

create trigger t42_refuse_sensitive_custom_field before insert or update of label on app.custom_field_definitions
  for each row execute function private.refuse_sensitive_custom_field();

create or replace function private.refuse_sensitive_question()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new text := to_jsonb(new) ->> tg_argv[0];
begin
  if private.question_looks_sensitive(v_new) and not private.sensitive_write_is_system()
     and (tg_op = 'INSERT' or v_new is distinct from to_jsonb(old) ->> tg_argv[0]) then
    perform private.refuse('question_sensitive', 'A question cannot ask for dietary, accessibility or protected-group details, because answering it records no consent. Use Work Details or the guest''s needs step.');
  end if;
  return new;
end;
$$;

comment on function private.refuse_sensitive_question() is 'Before a question to fill in is written or reworded: refuses a label in the column named by the trigger argument that asks for sensitive data (question_sensitive, ADR 0164).';
revoke all on function private.refuse_sensitive_question() from public, anon, authenticated;

create trigger t42_refuse_sensitive_question before insert or update of prompt on app.opportunity_questions
  for each row execute function private.refuse_sensitive_question('prompt');
create trigger t42_refuse_sensitive_question before insert or update of prompt on app.application_template_questions
  for each row execute function private.refuse_sensitive_question('prompt');
create trigger t42_refuse_sensitive_question before insert or update of prompt on app.survey_questions
  for each row execute function private.refuse_sensitive_question('prompt');

create or replace function private.refuse_sensitive_form_fields()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.sensitive_write_is_system() and (tg_op = 'INSERT' or new.fields is distinct from old.fields)
     and jsonb_typeof(new.fields) = 'array'
     and exists (select 1 from jsonb_array_elements(new.fields) f where private.question_looks_sensitive(f ->> 'label')) then
    perform private.refuse('question_sensitive', 'A question cannot ask for dietary, accessibility or protected-group details, because answering it records no consent. Use Work Details or the guest''s needs step.');
  end if;
  return new;
end;
$$;

comment on function private.refuse_sensitive_form_fields() is 'Before a no-code form''s fields are written: refuses a field label that asks for sensitive data (question_sensitive, ADR 0164). Published forms keep their fields, so a label already published is not reread.';
revoke all on function private.refuse_sensitive_form_fields() from public, anon, authenticated;

create trigger t42_refuse_sensitive_form_fields before insert or update of fields on app.form_templates
  for each row execute function private.refuse_sensitive_form_fields();

create or replace function private.refuse_sensitive_travel_note()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.looks_sensitive(new.travel_notes) and not private.sensitive_write_is_system()
     and (tg_op = 'INSERT' or new.travel_notes is distinct from old.travel_notes) then
    perform private.refuse('travel_note_sensitive', 'Leave dietary and accessibility needs out of the travel notes. Add a meal preference, or use Work Details, which record consent.');
  end if;
  return new;
end;
$$;

comment on function private.refuse_sensitive_travel_note() is 'Before a travel note is written: refuses words that name a dietary or accessibility need (travel_note_sensitive, ADR 0164), because the note has no consent step and every travel reader sees it. A note already held is left as it is until it changes.';
revoke all on function private.refuse_sensitive_travel_note() from public, anon, authenticated;

create trigger t42_refuse_sensitive_travel_note before insert or update of travel_notes on app.roster_travel_requests
  for each row execute function private.refuse_sensitive_travel_note();

-- A meal preference on a roster entry ---------------------------------------------------------------------------------

create or replace function app.attest_roster_meal_preference(
  p_roster_entry_id uuid,
  p_notice_version text,
  p_locale text,
  p_surface app.sensitive_consent_surface,
  p_authority_confirmed boolean default false,
  p_notice_confirmed boolean default false,
  p_client_ip inet default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_person uuid;
  v_account uuid;
  v_id uuid;
  v_user uuid;
begin
  if private.project_fact_standing(p_roster_entry_id) is distinct from 'Company' then
    perform private.refuse('project_fact_not_yours', 'Only the company that rosters this person attests for them.');
  end if;
  perform private.assert_sensitive_notice('Dietary and Allergies', p_notice_version, p_locale);
  if not (coalesce(p_authority_confirmed, false) and coalesce(p_notice_confirmed, false)) then
    perform private.refuse('sensitive_attestation_required', 'Confirm you have this person''s authority to enter this and that they have had notice.');
  end if;
  v_person := private.roster_entry_person(p_roster_entry_id);
  select c.organization_id into v_account
  from app.engagement_roster_entries r
  join app.engagements e on e.id = r.engagement_id
  join app.counterparties c on c.id = e.counterparty_id
  where r.id = p_roster_entry_id;
  if private.person_withdrew_sensitive(v_person, 'Dietary and Allergies') then
    -- The company knows this person, so there is no account to reveal. It need not know they withdrew.
    perform private.refuse('sensitive_person_only', 'Only this person can enter this.');
  end if;
  select c.id into v_id from app.sensitive_data_consents c
  where c.person_id = v_person and c.category = 'Dietary and Allergies' and c.basis = 'Attested Authority'
    and c.org_id = v_account and c.guest_list_entry_id is null and c.withdrawn_at is null;
  if v_id is null then
    insert into app.sensitive_data_consents (category, basis, person_id, org_id, notice_version, locale, surface,
      authority_confirmed, notice_confirmed, given_by, captured_ip)
    values ('Dietary and Allergies', 'Attested Authority', v_person, v_account, p_notice_version, p_locale, p_surface, true, true, v_me, p_client_ip)
    returning id into v_id;
    perform private.write_audit_event(v_account, 'sensitive_consent.attested', 'app.engagement_roster_entries', p_roster_entry_id,
      jsonb_build_object('category', 'Dietary and Allergies', 'notice_version', p_notice_version));
    perform private.log_work_detail_event(v_person, 'sensitive_consent.attested', v_account, null, '{}', '{}', null, p_roster_entry_id);
    select p.user_id into v_user from app.people p where p.id = v_person;
    if v_user is not null then
      begin
        perform private.notify_account(v_user, 'account.sensitive_data_attested', jsonb_build_object('category', 'Dietary and Allergies'));
      exception when others then
        raise warning 'account.sensitive_data_attested was not sent to sign-in %: %', v_user, sqlerrm;
      end;
    end if;
    perform private.sync_meal_preference_record(v_person);
  end if;
  return v_id;
end;
$$;

comment on function app.attest_roster_meal_preference(uuid, text, text, app.sensitive_consent_surface, boolean, boolean, inet) is 'The company that rosters a person attests it has their authority to enter their meal preference and that they have had notice, per person and company. The person is told and can remove it. Refuses project_fact_not_yours, sensitive_attestation_required, sensitive_notice_version and sensitive_person_only. Returns the attestation id.';
revoke all on function app.attest_roster_meal_preference(uuid, text, text, app.sensitive_consent_surface, boolean, boolean, inet) from public, anon;
grant execute on function app.attest_roster_meal_preference(uuid, text, text, app.sensitive_consent_surface, boolean, boolean, inet) to authenticated, service_role;

create or replace function private.roster_meal_consent_id(p_roster_entry_id uuid, p_standing text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case when p_standing = 'Person' then private.sensitive_consent_id(private.roster_entry_person(p_roster_entry_id), 'Dietary and Allergies')
    else (select c.id from app.sensitive_data_consents c
          join app.engagement_roster_entries r on r.id = p_roster_entry_id
          join app.engagements e on e.id = r.engagement_id
          join app.counterparties k on k.id = e.counterparty_id
          where c.person_id = private.roster_entry_person(p_roster_entry_id) and c.category = 'Dietary and Allergies'
            and c.basis = 'Attested Authority' and c.org_id = k.organization_id and c.guest_list_entry_id is null and c.withdrawn_at is null)
    end;
$$;

comment on function private.roster_meal_consent_id(uuid, text) is 'The grant a meal preference on this roster entry stands on: the person''s own consent, or the company''s attestation.';
revoke all on function private.roster_meal_consent_id(uuid, text) from public, anon, authenticated;

create or replace function app.roster_meal_consent_stands(p_roster_entry_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.project_fact_standing(p_roster_entry_id) in ('Person', 'Company')
    and private.roster_meal_consent_id(p_roster_entry_id, private.project_fact_standing(p_roster_entry_id)) is not null;
$$;

comment on function app.roster_meal_consent_stands(uuid) is 'True when the signed-in person may enter a meal preference on this roster entry now: their own consent stands, or their company''s attestation does. The form shows the field only then.';
revoke all on function app.roster_meal_consent_stands(uuid) from public, anon;
grant execute on function app.roster_meal_consent_stands(uuid) to authenticated, service_role;

create or replace function private.roster_meal_grant_id(p_roster_entry_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(private.roster_meal_consent_id(p_roster_entry_id, 'Person'), private.roster_meal_consent_id(p_roster_entry_id, 'Company'));
$$;

comment on function private.roster_meal_grant_id(uuid) is 'The grant a value already on this roster entry stands on, for reading it: the person''s own consent, or the attestation of the company that rosters them. NULL means it reads as absent.';
revoke all on function private.roster_meal_grant_id(uuid) from public, anon, authenticated;

-- The meal preference's field record ------------------------------------------------------------------------------------

create or replace function private.sync_meal_preference_record(p_person_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_held boolean;
  v_without boolean;
  v_grant uuid;
begin
  select coalesce(bool_or(true), false), coalesce(bool_or(private.roster_meal_grant_id(t.roster_entry_id) is null), false),
    (array_agg(private.roster_meal_grant_id(t.roster_entry_id)))[1]
  into v_held, v_without, v_grant
  from app.roster_travel_requests t
  join private.roster_people r on r.roster_entry_id = t.roster_entry_id
  where r.person_id = p_person_id and t.meal_preference is not null and t.deleted_at is null;
  perform private.record_sensitive_field('meal_preference', v_held, case when v_without then null else v_grant end, p_person_id);
end;
$$;

comment on function private.sync_meal_preference_record(uuid) is 'Keeps the one field record of a person''s meal preference across their roster entries: held while any entry holds one, standing on a grant only when every value does, and still waiting when one does not.';
revoke all on function private.sync_meal_preference_record(uuid) from public, anon, authenticated;

create or replace function private.record_meal_preference_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.roster_entry_person(coalesce(new.roster_entry_id, old.roster_entry_id));
begin
  if v_person is not null then
    perform private.sync_meal_preference_record(v_person);
  end if;
  return null;
end;
$$;

comment on function private.record_meal_preference_change() is 'After a meal preference changes by any path (save, clear, erasure, expiry): keeps its field record.';
revoke all on function private.record_meal_preference_change() from public, anon, authenticated;

create trigger t86_record_meal_preference after insert or update of meal_preference, deleted_at or delete on app.roster_travel_requests
  for each row execute function private.record_meal_preference_change();

-- Who reads a meal preference ------------------------------------------------------------------------------------------

create or replace function private.roster_travel_value_for(p_row app.roster_travel_requests, p_project_id uuid, p_standing text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when p_row.id is null then null else
    private.roster_travel_value(p_row) || (
      select jsonb_build_object(
        'meal_preference', case when v.readable then p_row.meal_preference end,
        'meal_preference_masked', p_row.meal_preference is not null and not v.readable and v.stands)
      from (select g.stands, p_standing = 'Person' or (p_standing = 'Producer' and g.stands
              and private.can_on_project(p_project_id, 'data.restricted.read.medical')) as readable
            from (select private.roster_meal_grant_id(p_row.roster_entry_id) is not null as stands) g) v)
  end;
$$;

comment on function private.roster_travel_value_for(app.roster_travel_requests, uuid, text) is 'The value object of a travel request for a reader of the given standing (ADR 0164). The person reads their meal preference; a producer holding data.restricted.read.medical on the project reads it while a grant stands; everyone else, the company always, sees meal_preference_masked. With no standing grant it reads as absent.';
revoke all on function private.roster_travel_value_for(app.roster_travel_requests, uuid, text) from public, anon, authenticated;

create or replace function private.log_meal_preference_read(p_travel jsonb, p_person_id uuid, p_org_id uuid, p_engagement_id uuid, p_roster_entry_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_travel ->> 'meal_preference' is not null then
    perform private.log_project_fact_event(p_person_id, 'meal_preference.viewed', p_org_id, p_engagement_id, p_roster_entry_id,
      array['Travel']::app.project_fact_kind[]);
    perform private.write_audit_event(p_org_id, 'meal_preference.viewed', 'app.engagement_roster_entries', p_roster_entry_id, '{}'::jsonb);
  end if;
end;
$$;

comment on function private.log_meal_preference_read(jsonb, uuid, uuid, uuid, uuid) is 'After a producer read a travel request: logs the Restricted read of its meal preference in the person''s access log and the org''s audit ledger, when one came back.';
revoke all on function private.log_meal_preference_read(jsonb, uuid, uuid, uuid, uuid) from public, anon, authenticated;

create or replace function private.roster_project_facts_object(p_roster_entry_id uuid, p_standing text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_entry app.engagement_roster_entries;
  v_engagement app.engagements;
  v_person uuid := private.roster_entry_person(p_roster_entry_id);
  v_travel app.roster_travel_requests;
  v_uniform app.roster_uniform_sizes;
  v_vehicle app.roster_vehicles;
  v_readable app.project_fact_kind[];
  v_logged app.project_fact_kind[];
  v_travel_value jsonb;
begin
  select * into v_entry from app.engagement_roster_entries r where r.id = p_roster_entry_id;
  select * into v_engagement from app.engagements e where e.id = v_entry.engagement_id;
  select * into v_travel from app.roster_travel_requests t where t.roster_entry_id = v_entry.id and t.deleted_at is null;
  select * into v_uniform from app.roster_uniform_sizes u where u.roster_entry_id = v_entry.id and u.deleted_at is null;
  select * into v_vehicle from app.roster_vehicles v where v.roster_entry_id = v_entry.id and v.deleted_at is null;

  if p_standing in ('Person', 'Company') then
    v_readable := enum_range(null::app.project_fact_kind);
  else
    select coalesce(array_agg(k order by k), '{}') into v_readable from unnest(enum_range(null::app.project_fact_kind)) k
    where private.can_read_project_fact_kind(v_engagement.project_id, k);
  end if;
  v_travel_value := case when 'Travel' = any (v_readable) then private.roster_travel_value_for(v_travel, v_engagement.project_id, p_standing) end;

  if p_standing in ('Company', 'Producer') then
    select coalesce(array_agg(k order by k), '{}') into v_logged from unnest(v_readable) k
    where (k = 'Travel' and v_travel.id is not null) or (k = 'Uniform' and v_uniform.id is not null)
       or (k = 'Vehicle' and v_vehicle.id is not null);
    if cardinality(v_logged) > 0 then
      perform private.log_project_fact_event(v_person, 'project_facts.viewed',
        case when p_standing = 'Company' then private.roster_entry_account(v_entry.id) else v_engagement.org_id end,
        v_engagement.id, v_entry.id, v_logged);
      if p_standing = 'Producer' then
        perform private.write_audit_event(v_engagement.org_id, 'project_facts.viewed', 'app.engagement_roster_entries', v_entry.id,
          jsonb_build_object('fact_kinds', to_jsonb(v_logged)));
      end if;
    end if;
    if p_standing = 'Producer' then
      perform private.log_meal_preference_read(v_travel_value, v_person, v_engagement.org_id, v_engagement.id, v_entry.id);
    end if;
  end if;

  return jsonb_build_object(
    'roster_entry_id', v_entry.id,
    'engagement_id', v_engagement.id,
    'org_id', v_engagement.org_id,
    'person_id', v_person,
    'standing', p_standing,
    'offered', jsonb_build_object(
      'travel', private.project_fact_offered(v_engagement.id, 'Travel'),
      'lodging', private.project_fact_offered(v_engagement.id, 'Lodging'),
      'uniforms', private.project_fact_offered(v_engagement.id, 'Uniforms'),
      'parking', private.project_fact_offered(v_engagement.id, 'Parking')),
    'present', jsonb_build_object('travel', v_travel.id is not null, 'uniform', v_uniform.id is not null,
      'vehicle', v_vehicle.id is not null),
    'entered_by_person', jsonb_build_object(
      'travel', private.project_fact_entered_by_person(v_travel.updated_by, v_entry.id),
      'uniform', private.project_fact_entered_by_person(v_uniform.updated_by, v_entry.id),
      'vehicle', private.project_fact_entered_by_person(v_vehicle.updated_by, v_entry.id)),
    'readable', to_jsonb(v_readable),
    'travel', v_travel_value,
    'uniform', case when 'Uniform' = any (v_readable) then private.roster_uniform_value(v_uniform) end,
    'vehicle', case when 'Vehicle' = any (v_readable) then private.roster_vehicle_value(v_vehicle) end);
end;
$$;

comment on function private.roster_project_facts_object(uuid, text) is 'The project facts of a roster entry for a reader of the given standing, logging the read: for Company and Producer, when a readable kind has a row, one project_facts.viewed row in the person''s access log (org_id the supplying account or the producing org), and for Producer an audit event in the producing org. A meal preference is Restricted (ADR 0164): see private.roster_travel_value_for; a producer''s read of one is logged as meal_preference.viewed. Callers check the standing first.';
revoke all on function private.roster_project_facts_object(uuid, text) from public, anon, authenticated;


create or replace function app.save_roster_travel_request(
  p_roster_entry_id uuid,
  p_inbound_airport_code text,
  p_outbound_airport_code text,
  p_inbound_on date,
  p_outbound_on date,
  p_seat_preference app.seat_preference default null,
  p_meal_preference text default null,
  p_needs_ground_transport boolean default false,
  p_needs_lodging boolean default false,
  p_travel_notes text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_standing text;
  v_engagement uuid;
  v_in char(3) := nullif(upper(btrim(coalesce(p_inbound_airport_code, ''))), '');
  v_out char(3) := nullif(upper(btrim(coalesce(p_outbound_airport_code, ''))), '');
  v_meal text;
  v_notes text;
  v_id uuid;
  v_existing app.roster_travel_requests;
begin
  perform private.require_person();
  v_standing := private.assert_project_fact_writer(p_roster_entry_id, 'Travel');
  select r.engagement_id into v_engagement from app.engagement_roster_entries r where r.id = p_roster_entry_id;
  if (v_in is not null and not exists (select 1 from app.airports a where a.iata_code = v_in and a.is_active))
     or (v_out is not null and not exists (select 1 from app.airports a where a.iata_code = v_out and a.is_active)) then
    perform private.refuse('airport_unknown', 'Choose an airport from the list.');
  end if;
  if p_inbound_on is not null and p_outbound_on is not null and p_outbound_on < p_inbound_on then
    perform private.refuse('travel_dates_order', 'The day you travel home comes on or after the day you arrive.');
  end if;
  if v_in is null and v_out is null and p_inbound_on is null and p_outbound_on is null then
    perform private.refuse('project_fact_empty', 'Give at least an airport or a date.');
  end if;
  if coalesce(p_needs_lodging, false) and not private.project_fact_offered(v_engagement, 'Lodging') then
    perform private.refuse('offering_not_offered', 'Lodging is not offered on this engagement''s project.');
  end if;
  v_meal := private.project_fact_text(p_meal_preference, 100);
  v_notes := private.project_fact_text(p_travel_notes, 500);
  select * into v_existing from app.roster_travel_requests t where t.roster_entry_id = p_roster_entry_id and t.deleted_at is null for update;
  -- ADR 0164: a meal preference is dietary data. It stands on the person's consent or the company's attestation. The company
  -- never reads it back, so its form sends nothing for "leave it as it is", and it cannot test a value it does not know.
  if v_standing = 'Company' and v_meal is null then
    v_meal := v_existing.meal_preference;
  elsif v_meal is not null and private.roster_meal_consent_id(p_roster_entry_id, v_standing) is null
        and not (v_standing = 'Person' and v_existing.meal_preference is not distinct from v_meal) then
    perform private.refuse_without_sensitive_consent('Dietary and Allergies');
  end if;

  v_id := v_existing.id;
  if v_id is null then
    insert into app.roster_travel_requests (roster_entry_id, inbound_airport_code, outbound_airport_code, inbound_on, outbound_on,
      seat_preference, meal_preference, needs_ground_transport, needs_lodging, travel_notes)
    values (p_roster_entry_id, v_in, v_out, p_inbound_on, p_outbound_on, p_seat_preference, v_meal,
      coalesce(p_needs_ground_transport, false), coalesce(p_needs_lodging, false), v_notes)
    returning id into v_id;
  else
    update app.roster_travel_requests set inbound_airport_code = v_in, outbound_airport_code = v_out, inbound_on = p_inbound_on,
      outbound_on = p_outbound_on, seat_preference = p_seat_preference, meal_preference = v_meal,
      needs_ground_transport = coalesce(p_needs_ground_transport, false), needs_lodging = coalesce(p_needs_lodging, false),
      travel_notes = v_notes
    where id = v_id;
  end if;
  if v_standing = 'Company' then
    perform private.notify_project_facts_entered(p_roster_entry_id, 'Travel');
  end if;
  return v_id;
end;
$$;

comment on function app.save_roster_travel_request(uuid, text, text, date, date, app.seat_preference, text, boolean, boolean, text) is 'The person, or their company when the project allows it, saves the travel request of a roster entry as a full replacement of its live row (R5). Airport codes are uppercased. Refuses the writer rules of private.assert_project_fact_writer, airport_unknown, travel_dates_order, project_fact_empty, offering_not_offered (lodging asked while not offered), project_fact_text_length, sensitive_consent_required for a new meal preference with no standing consent or attestation, and travel_note_sensitive (ADR 0164). A person may leave their own meal preference unchanged without consent, which ends no wait; the company sends none to leave one as it is. A company write notifies the person. Returns the row id.';
revoke all on function app.save_roster_travel_request(uuid, text, text, date, date, app.seat_preference, text, boolean, boolean, text) from public, anon;
grant execute on function app.save_roster_travel_request(uuid, text, text, date, date, app.seat_preference, text, boolean, boolean, text) to authenticated, service_role;

-- The travel party counts transfers as pickups (5942); a meal preference is masked (ADR 0164) --------------------------------

create or replace function app.roster_travel_party(p_project_id uuid)
returns setof jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_zone text;
  v_passes boolean;
  v_row record;
  v_travel app.roster_travel_requests;
  v_travel_value jsonb;
  v_room record;
begin
  perform private.require_person();
  perform private.assert_travel_party_reader(p_project_id);
  select p.time_zone into v_zone from app.projects p where p.id = p_project_id;
  v_passes := private.can_on_project(p_project_id, 'credentials.credential.read');
  for v_row in
    select x.roster_entry_id, x.engagement_id, x.org_id, x.person_id, coalesce(a.name, ep.full_name) as party_name,
      pp.full_name as person_name, r.role_code, lower(r.arrival_window) as arrival_starts_at,
      upper(r.arrival_window) as arrival_ends_at, r.arrival_time_zone
    from private.travel_party_entries(p_project_id) x
    join app.engagement_roster_entries r on r.id = x.roster_entry_id
    join app.engagements e on e.id = x.engagement_id
    left join app.counterparties c on c.id = e.counterparty_id
    left join app.organizations a on a.id = c.organization_id
    left join app.people ep on ep.id = e.person_id
    left join app.people pp on pp.id = x.person_id
    order by pp.full_name, x.roster_entry_id
  loop
    select * into v_travel from app.roster_travel_requests t where t.roster_entry_id = v_row.roster_entry_id and t.deleted_at is null;
    select aa.check_in_on, aa.check_out_on, b.title into v_room
    from app.accommodation_assignments aa
    join app.accommodation_blocks b on b.id = aa.accommodation_block_id and b.deleted_at is null and b.project_id = p_project_id
    where aa.person_id = v_row.person_id and aa.deleted_at is null
    order by aa.check_in_on, aa.id limit 1;
    if v_travel.id is not null then
      perform private.log_project_fact_event(v_row.person_id, 'project_facts.viewed', v_row.org_id, v_row.engagement_id,
        v_row.roster_entry_id, array['Travel']::app.project_fact_kind[]);
      perform private.write_audit_event(v_row.org_id, 'project_facts.viewed', 'app.engagement_roster_entries', v_row.roster_entry_id,
        jsonb_build_object('fact_kinds', jsonb_build_array('Travel')));
    end if;
    v_travel_value := private.roster_travel_value_for(v_travel, p_project_id, 'Producer');
    perform private.log_meal_preference_read(v_travel_value, v_row.person_id, v_row.org_id, v_row.engagement_id, v_row.roster_entry_id);
    return next jsonb_build_object(
      'roster_entry_id', v_row.roster_entry_id,
      'engagement_id', v_row.engagement_id,
      'party_name', v_row.party_name,
      'person_id', v_row.person_id,
      'person_name', v_row.person_name,
      'role_code', v_row.role_code,
      'arrival_starts_at', v_row.arrival_starts_at,
      'arrival_ends_at', v_row.arrival_ends_at,
      'arrival_time_zone', v_row.arrival_time_zone,
      'travel', v_travel_value,
      'room', jsonb_build_object('assigned', v_room.check_in_on is not null, 'check_in_on', v_room.check_in_on,
        'check_out_on', v_room.check_out_on, 'block_name', v_room.title),
      'pickup', jsonb_build_object('booked', v_travel.inbound_on is not null and (exists (
        select 1 from app.travel_segments s
        where s.person_id = v_row.person_id and s.project_id = p_project_id and s.deleted_at is null and s.travel_mode = 'Ground'
          and (s.departs_at at time zone v_zone)::date = v_travel.inbound_on) or exists (
        select 1 from app.transfer_passengers q
        join app.transfers tr on tr.id = q.transfer_id and tr.deleted_at is null and tr.project_id = p_project_id
        where q.person_id = v_row.person_id and q.deleted_at is null
          and (tr.pickup_at at time zone v_zone)::date = v_travel.inbound_on))),
      'pass', case when v_passes then jsonb_build_object('issued', exists (
        select 1 from app.credentials k
        where k.holder_person_id = v_row.person_id and k.engagement_id = v_row.engagement_id
          and k.revoked_at is null and k.deleted_at is null)) end);
  end loop;
end;
$$;

comment on function app.roster_travel_party(uuid) is 'The travel party of a project (R5, G-175), for hospitality.fulfillment.read holders (else 42501): one object per entry of private.travel_party_entries with the party, person, role and arrival, the travel request (airport names included) or NULL, room {assigned, check_in_on, check_out_on, block_name} from live accommodation assignments of the person on the project''s blocks, pickup {booked} from a live Ground travel segment of the person on the project departing on the inbound date in the project zone, or a live transfer of the project carrying the person as a live passenger with its pickup on that date (B5; false while there is no inbound date), and pass {issued} from a live unrevoked credential of the engagement, NULL without credentials.credential.read. Each entry returned with a travel request writes project_facts.viewed (Travel) in the person''s access log and the producing org''s audit ledger. A meal preference is Restricted (ADR 0164): it comes back only to holders of data.restricted.read.medical on the project, while a grant stands, each read logged as meal_preference.viewed; others see meal_preference_masked.';
revoke all on function app.roster_travel_party(uuid) from public, anon;
grant execute on function app.roster_travel_party(uuid) to authenticated, service_role;

-- Stopping use, now with guest and roster values ------------------------------------------------------------------------

create or replace function private.erase_sensitive_category(p_person_id uuid, p_account_id uuid, p_category app.sensitive_data_category)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_entry uuid;
begin
  if private.sensitive_subject_on_hold(p_person_id, p_account_id) then
    return false;
  end if;
  if p_category = 'Supplier Diversity' then
    perform private.erase_supplier_diversity_values(p_person_id, p_account_id);
    return true;
  end if;
  for v_entry in select n.guest_list_entry_id from app.guest_care_needs n where p_person_id is not null and n.guest_person_id = p_person_id loop
    perform private.close_guest_needs(v_entry, p_category);
  end loop;
  if p_category = 'Dietary and Allergies' then
    update app.person_work_details w set dietary_needs = '{}', allergies = null, dietary_notes = null
    where w.person_id = p_person_id and (cardinality(w.dietary_needs) > 0 or w.allergies is not null or w.dietary_notes is not null);
    update app.roster_travel_requests t set meal_preference = null
    from private.roster_people r
    where r.roster_entry_id = t.roster_entry_id and r.person_id = p_person_id and t.meal_preference is not null;
    perform private.remove_work_detail_share_category(p_person_id, 'Dietary Needs');
  elsif p_category = 'Accessibility' then
    update app.person_work_details w set accessibility_needs = '{}', accessibility_notes = null
    where w.person_id = p_person_id and (cardinality(w.accessibility_needs) > 0 or w.accessibility_notes is not null);
    perform private.remove_work_detail_share_category(p_person_id, 'Accessibility Needs');
  end if;
  return true;
end;
$$;

comment on function private.erase_sensitive_category(uuid, uuid, app.sensitive_data_category) is 'Clears the values of one category for a person or company: their work details, their meal preference on every roster entry, what was attested about them on a guest list, and the category on their shares. Supplier diversity certifications are de-identified. Returns false, clearing nothing, while a legal hold reaches the person or the company''s certifications: the values stay masked and the daily job clears them when the hold ends.';
revoke all on function private.erase_sensitive_category(uuid, uuid, app.sensitive_data_category) from public, anon, authenticated;

create or replace function private.clear_ungranted_sensitive_values(p_person_id uuid, p_account_id uuid, p_category app.sensitive_data_category)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if private.sensitive_subject_on_hold(p_person_id, p_account_id) then
    return false;
  end if;
  if p_category = 'Supplier Diversity' then
    perform private.erase_supplier_diversity_values(p_person_id, p_account_id);
  elsif p_category = 'Dietary and Allergies' then
    update app.person_work_details w set dietary_needs = '{}', allergies = null, dietary_notes = null
    where w.person_id = p_person_id and (cardinality(w.dietary_needs) > 0 or w.allergies is not null or w.dietary_notes is not null);
    update app.roster_travel_requests t set meal_preference = null
    from private.roster_people r
    where r.roster_entry_id = t.roster_entry_id and r.person_id = p_person_id and t.meal_preference is not null
      and private.roster_meal_grant_id(t.roster_entry_id) is null;
    perform private.remove_work_detail_share_category(p_person_id, 'Dietary Needs');
  else
    update app.person_work_details w set accessibility_needs = '{}', accessibility_notes = null
    where w.person_id = p_person_id and (cardinality(w.accessibility_needs) > 0 or w.accessibility_notes is not null);
    perform private.remove_work_detail_share_category(p_person_id, 'Accessibility Needs');
  end if;
  return true;
end;
$$;

comment on function private.clear_ungranted_sensitive_values(uuid, uuid, app.sensitive_data_category) is 'For the daily job, when the owner''s own grant does not stand: clears the owner''s own values of a category, and meal preferences no grant covers. A value someone else attested stands on its own attestation and stays. Returns false while a legal hold reaches the owner.';
revoke all on function private.clear_ungranted_sensitive_values(uuid, uuid, app.sensitive_data_category) from public, anon, authenticated;

-- What was entered about the person -----------------------------------------------------------------------------------

create or replace function app.sensitive_entries_about_me()
returns table (
  consent_id uuid,
  category app.sensitive_data_category,
  given_by_name text,
  org_name text,
  guest_name text,
  given_at timestamptz,
  details jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.category, p.full_name, o.name, g.guest_name, c.given_at,
    case when n.id is null then null
         when c.category = 'Dietary and Allergies' then jsonb_build_object('dietary_needs', to_jsonb(n.dietary_needs),
           'allergies', n.allergies, 'dietary_notes', n.dietary_notes)
         else jsonb_build_object('accessibility_needs', to_jsonb(n.accessibility_needs), 'accessibility_notes', n.accessibility_notes) end
  from app.sensitive_data_consents c
  left join app.people p on p.id = c.given_by
  left join app.organizations o on o.id = c.org_id
  left join app.guest_list_entries g on g.id = c.guest_list_entry_id
  left join app.guest_care_needs n on n.guest_list_entry_id = c.guest_list_entry_id
  where c.basis = 'Attested Authority' and c.withdrawn_at is null and c.account_id is null
    and (c.person_id = private.current_person_id()
      or (n.guest_email is not null and n.guest_email = private.verified_email_of(private.current_person_id())))
  order by c.given_at desc;
$$;

comment on function app.sensitive_entries_about_me() is 'What others attested and entered about the signed-in person: on a roster entry, or on a guest list under their person or their verified sign-in email, with who, when and, for a guest list entry, the values.';
revoke all on function app.sensitive_entries_about_me() from public, anon;
grant execute on function app.sensitive_entries_about_me() to authenticated, service_role;

create or replace function app.remove_sensitive_entry(p_consent_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_consent app.sensitive_data_consents;
begin
  -- An entry that only names the person's verified email so far is theirs now.
  perform private.link_guest_needs_to_person(v_me);
  select * into v_consent from app.sensitive_data_consents c
  where c.id = p_consent_id and c.basis = 'Attested Authority' and c.withdrawn_at is null and c.account_id is null;
  if v_consent.id is null or not (v_consent.person_id = v_me or v_consent.given_by = v_me) then
    perform private.refuse('sensitive_entry_not_yours', 'Only the person this is about, or whoever entered it, removes it.');
  end if;
  if v_consent.guest_list_entry_id is not null then
    perform private.close_guest_needs(v_consent.guest_list_entry_id, v_consent.category);
    perform private.write_audit_event(v_consent.org_id, 'guest_needs.cleared', 'app.guest_list_entries', v_consent.guest_list_entry_id, '{}'::jsonb);
  else
    update app.sensitive_data_consents c set withdrawn_at = now(), withdrawn_by = v_me where c.id = v_consent.id;
    -- What the company entered goes; what the person entered stays with them. A legal hold keeps the value, masked: the
    -- daily job clears it once no grant covers it.
    if not private.person_on_legal_hold(v_consent.person_id) then
      update app.roster_travel_requests t set meal_preference = null
      from private.roster_people r, app.engagement_roster_entries e, app.engagements g, app.counterparties k
      where r.roster_entry_id = t.roster_entry_id and r.person_id = v_consent.person_id and t.meal_preference is not null
        and e.id = t.roster_entry_id and g.id = e.engagement_id and k.id = g.counterparty_id and k.organization_id = v_consent.org_id
        and not private.project_fact_entered_by_person(t.updated_by, t.roster_entry_id);
    end if;
    perform private.sync_meal_preference_record(v_consent.person_id);
  end if;
  if v_consent.person_id is not null then
    perform private.log_work_detail_event(v_consent.person_id, 'sensitive_consent.entry_removed', v_consent.org_id, null, '{}', '{}', null);
  end if;
end;
$$;

comment on function app.remove_sensitive_entry(uuid) is 'The person an attestation is about, or whoever gave it, removes it in one call: the attestation is withdrawn and the values it covers are deleted. Refuses sensitive_entry_not_yours.';
revoke all on function app.remove_sensitive_entry(uuid) from public, anon;
grant execute on function app.remove_sensitive_entry(uuid) to authenticated, service_role;

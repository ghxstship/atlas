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
--     notice, see it under their Work Details and remove it. An account opened later with that email sees it too.
--   * The company that rosters a person attests the same way before it enters that person's meal preference
--     (app.attest_roster_meal_preference). The person's own meal preference needs their own consent. A person who withdrew
--     a category cannot be attested back into it (sensitive_person_withdrew): they consent again themselves.
--   * private.looks_sensitive refuses free text that names these needs where no consent step exists: a guest's door note
--     (guest_note_sensitive), a mapped import column (import_sensitive_column) and a custom field label
--     (custom_field_sensitive). This is a backstop for the common words in English and Spanish; it does not read minds.
--   * A guest's needs are deleted when the entry is removed or declined, and 90 days after the project ends (6163).
-- Functions start from their latest definitions: 6160_sensitive_data_consent.sql for private.erase_sensitive_category,
-- 4655_roster_project_fact_rpcs.sql for app.save_roster_travel_request.

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

comment on function private.person_with_verified_email(text) is 'The person whose confirmed sign-in email is this address, or NULL. It never leaves the database: a caller learns nothing about whether an address has an account.';
revoke all on function private.person_with_verified_email(text) from public, anon, authenticated;

create or replace function private.my_verified_email()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select lower(u.email) from auth.users u
  join app.people p on p.user_id = u.id
  where p.id = private.current_person_id() and u.email_confirmed_at is not null;
$$;

comment on function private.my_verified_email() is 'The signed-in person''s confirmed sign-in email, lower case, or NULL.';
revoke all on function private.my_verified_email() from public, anon, authenticated;

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
  if v_needs.id is null then
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

comment on function private.close_guest_needs(uuid, app.sensitive_data_category) is 'Withdraws the attestations of a guest entry, for one category or all, and deletes those values, deleting the row once nothing is left. The attestations stay as evidence.';
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
  p_notice_version text default null,
  p_locale text default null,
  p_surface app.sensitive_consent_surface default 'Atlas'
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
  v_diet app.dietary_need[] := coalesce((select array_agg(distinct d order by d) from unnest(p_dietary_needs) d where d is not null), '{}');
  v_access app.accessibility_need[] := coalesce((select array_agg(distinct a order by a) from unnest(p_accessibility_needs) a where a is not null), '{}');
  v_allergies text := nullif(btrim(p_allergies), '');
  v_diet_notes text := nullif(btrim(p_dietary_notes), '');
  v_access_notes text := nullif(btrim(p_accessibility_notes), '');
  v_email text := nullif(lower(btrim(p_guest_email)), '');
  v_has_diet boolean;
  v_has_access boolean;
  v_person uuid;
  v_category app.sensitive_data_category;
  v_consent uuid;
  v_id uuid;
  v_user uuid;
begin
  select * into v_entry from app.guest_list_entries g where g.id = p_guest_list_entry_id and g.deleted_at is null;
  if v_entry.id is null or not private.can_keep_guest_needs(v_entry) then
    raise exception using errcode = '42501', message = 'the guest list entry is not writable';
  end if;
  if private.org_read_only(v_entry.org_id) then
    perform private.refuse('org_read_only', 'This organization is canceled and read-only, so nothing more is entered for it.');
  end if;
  v_has_diet := cardinality(v_diet) > 0 or v_allergies is not null or v_diet_notes is not null;
  v_has_access := cardinality(v_access) > 0 or v_access_notes is not null;
  if not v_has_diet and not v_has_access then
    perform private.close_guest_needs(v_entry.id);
    return null;
  end if;
  if not (coalesce(p_authority_confirmed, false) and coalesce(p_notice_confirmed, false)) then
    perform private.refuse('sensitive_attestation_required', 'Confirm you have the guest''s authority to enter this and that they have had notice.');
  end if;
  v_person := private.person_with_verified_email(v_email);

  foreach v_category in array array['Dietary and Allergies', 'Accessibility']::app.sensitive_data_category[] loop
    if (v_category = 'Dietary and Allergies' and v_has_diet) or (v_category = 'Accessibility' and v_has_access) then
      perform private.assert_sensitive_notice(v_category, p_notice_version, p_locale);
      if private.person_withdrew_sensitive(v_person, v_category) then
        perform private.refuse('sensitive_person_withdrew', 'This person withdrew their consent to this data, so only they can give it again.');
      end if;
    end if;
  end loop;

  insert into app.guest_care_needs (project_id, guest_list_entry_id, dietary_needs, allergies, dietary_notes, accessibility_needs,
    accessibility_notes, guest_email, guest_person_id)
  values (v_entry.project_id, v_entry.id, v_diet, v_allergies, v_diet_notes, v_access, v_access_notes, v_email, v_person)
  on conflict (guest_list_entry_id) do update set dietary_needs = excluded.dietary_needs, allergies = excluded.allergies,
    dietary_notes = excluded.dietary_notes, accessibility_needs = excluded.accessibility_needs,
    accessibility_notes = excluded.accessibility_notes, guest_email = excluded.guest_email, guest_person_id = excluded.guest_person_id
  returning id into v_id;

  foreach v_category in array array['Dietary and Allergies', 'Accessibility']::app.sensitive_data_category[] loop
    if (v_category = 'Dietary and Allergies' and v_has_diet) or (v_category = 'Accessibility' and v_has_access) then
      select c.id into v_consent from app.sensitive_data_consents c
      where c.guest_list_entry_id = v_entry.id and c.category = v_category and c.withdrawn_at is null;
      if v_consent is null then
        insert into app.sensitive_data_consents (category, basis, person_id, guest_list_entry_id, org_id, notice_version, locale, surface,
          authority_confirmed, notice_confirmed, given_by)
        values (v_category, 'Attested Authority', v_person, v_entry.id, v_entry.org_id, p_notice_version, p_locale, p_surface, true, true, v_me)
        returning id into v_consent;
        perform private.write_audit_event(v_entry.org_id, 'guest_needs.attested', 'app.guest_list_entries', v_entry.id,
          jsonb_build_object('category', v_category, 'notice_version', p_notice_version));
        if v_person is not null then
          select p.user_id into v_user from app.people p where p.id = v_person;
          perform private.log_work_detail_event(v_person, 'sensitive_consent.attested', v_entry.org_id, null, '{}', '{}', null);
          if v_user is not null then
            begin
              perform private.notify_account(v_user, 'account.sensitive_data_attested', jsonb_build_object('category', v_category));
            exception when others then
              raise warning 'account.sensitive_data_attested was not sent to sign-in %: %', v_user, sqlerrm;
            end;
          end if;
        end if;
      end if;
    else
      perform private.close_guest_needs(v_entry.id, v_category);
      v_consent := null;
    end if;
    if v_category = 'Dietary and Allergies' and v_has_diet then
      perform private.record_sensitive_field('guest_dietary_needs', cardinality(v_diet) > 0, v_consent, v_person, null, v_entry.id);
      perform private.record_sensitive_field('guest_allergies', v_allergies is not null, v_consent, v_person, null, v_entry.id);
      perform private.record_sensitive_field('guest_dietary_notes', v_diet_notes is not null, v_consent, v_person, null, v_entry.id);
    elsif v_category = 'Accessibility' and v_has_access then
      perform private.record_sensitive_field('guest_accessibility_needs', cardinality(v_access) > 0, v_consent, v_person, null, v_entry.id);
      perform private.record_sensitive_field('guest_accessibility_notes', v_access_notes is not null, v_consent, v_person, null, v_entry.id);
    end if;
  end loop;
  return v_id;
end;
$$;

comment on function app.set_guest_care_needs(uuid, app.dietary_need[], text, text, app.accessibility_need[], text, text, boolean, boolean, text, text, app.sensitive_consent_surface) is 'Whoever keeps a guest''s entry sets the guest''s dietary and accessibility needs, each optional, as a full replacement, confirming they have the guest''s authority and that the guest has had notice (sensitive_attestation_required), with the version and language of the wording shown (sensitive_notice_version, sensitive_notice_locale). Attested per category and audited, never with values. Nothing given clears the row. An email matching a verified sign-in names that person, who is told and can remove it; a person who withdrew that category refuses it (sensitive_person_withdrew). Returns the row id, or NULL when cleared.';
revoke all on function app.set_guest_care_needs(uuid, app.dietary_need[], text, text, app.accessibility_need[], text, text, boolean, boolean, text, text, app.sensitive_consent_surface) from public, anon;
grant execute on function app.set_guest_care_needs(uuid, app.dietary_need[], text, text, app.accessibility_need[], text, text, boolean, boolean, text, text, app.sensitive_consent_surface) to authenticated, service_role;

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
    select n.org_id, n.guest_list_entry_id, g.guest_name, n.dietary_needs, n.allergies, n.dietary_notes, n.accessibility_needs,
      n.accessibility_notes, n.guest_person_id
    from app.guest_care_needs n
    join app.guest_list_entries g on g.id = n.guest_list_entry_id and g.deleted_at is null
    where n.project_id = p_project_id
      and exists (select 1 from app.sensitive_data_consents c where c.guest_list_entry_id = n.guest_list_entry_id and c.withdrawn_at is null)
    order by g.guest_name
  loop
    guest_list_entry_id := v_row.guest_list_entry_id;
    guest_name := v_row.guest_name;
    dietary_needs := v_row.dietary_needs;
    allergies := v_row.allergies;
    dietary_notes := v_row.dietary_notes;
    accessibility_needs := v_row.accessibility_needs;
    accessibility_notes := v_row.accessibility_notes;
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

comment on function app.read_guest_care_needs(uuid, boolean) is 'The guests'' needs on a project, for holders of data.restricted.read.medical on it, else 42501. Every call is written to the org''s audit ledger (guest_needs.viewed, or guest_needs.exported when it serves a download) and to the access log of each guest with an account.';
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

-- A meal preference on a roster entry ---------------------------------------------------------------------------------

create or replace function app.attest_roster_meal_preference(
  p_roster_entry_id uuid,
  p_notice_version text,
  p_locale text,
  p_surface app.sensitive_consent_surface,
  p_authority_confirmed boolean default false,
  p_notice_confirmed boolean default false
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
    perform private.refuse('sensitive_person_withdrew', 'This person withdrew their consent to this data, so only they can give it again.');
  end if;
  select c.id into v_id from app.sensitive_data_consents c
  where c.person_id = v_person and c.category = 'Dietary and Allergies' and c.basis = 'Attested Authority'
    and c.org_id = v_account and c.guest_list_entry_id is null and c.withdrawn_at is null;
  if v_id is null then
    insert into app.sensitive_data_consents (category, basis, person_id, org_id, notice_version, locale, surface,
      authority_confirmed, notice_confirmed, given_by)
    values ('Dietary and Allergies', 'Attested Authority', v_person, v_account, p_notice_version, p_locale, p_surface, true, true, v_me)
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
  end if;
  return v_id;
end;
$$;

comment on function app.attest_roster_meal_preference(uuid, text, text, app.sensitive_consent_surface, boolean, boolean) is 'The company that rosters a person attests it has their authority to enter their meal preference and that they have had notice, per person and company. The person is told and can remove it. Refuses project_fact_not_yours, sensitive_attestation_required, sensitive_notice_version and sensitive_person_withdrew. Returns the attestation id.';
revoke all on function app.attest_roster_meal_preference(uuid, text, text, app.sensitive_consent_surface, boolean, boolean) from public, anon;
grant execute on function app.attest_roster_meal_preference(uuid, text, text, app.sensitive_consent_surface, boolean, boolean) to authenticated, service_role;

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
  v_consent uuid;
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
  -- ADR 0164: a meal preference is dietary data. It stands on the person's consent or the company's attestation.
  v_consent := private.roster_meal_consent_id(p_roster_entry_id, v_standing);
  if v_meal is not null and v_consent is null then
    if not exists (select 1 from app.roster_travel_requests t where t.roster_entry_id = p_roster_entry_id and t.deleted_at is null
                   and t.meal_preference is not distinct from v_meal) then
      perform private.refuse_without_sensitive_consent('Dietary and Allergies');
    end if;
  end if;

  select t.id into v_id from app.roster_travel_requests t where t.roster_entry_id = p_roster_entry_id and t.deleted_at is null for update;
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
  perform private.record_sensitive_field('meal_preference', v_meal is not null, v_consent, private.roster_entry_person(p_roster_entry_id));
  if v_standing = 'Company' then
    perform private.notify_project_facts_entered(p_roster_entry_id, 'Travel');
  end if;
  return v_id;
end;
$$;

comment on function app.save_roster_travel_request(uuid, text, text, date, date, app.seat_preference, text, boolean, boolean, text) is 'The person, or their company when the project allows it, saves the travel request of a roster entry as a full replacement of its live row (R5). Airport codes are uppercased. Refuses the writer rules of private.assert_project_fact_writer, airport_unknown, travel_dates_order, project_fact_empty, offering_not_offered (lodging asked while not offered), project_fact_text_length, and sensitive_consent_required for a new meal preference with no standing consent or attestation (ADR 0164). A company write notifies the person. Returns the row id.';

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
  if p_person_id is not null and private.person_on_legal_hold(p_person_id) then
    return false;
  end if;
  if p_category = 'Supplier Diversity' then
    perform private.erase_supplier_diversity_values(p_person_id, p_account_id);
    return true;
  end if;
  for v_entry in select n.guest_list_entry_id from app.guest_care_needs n where n.guest_person_id = p_person_id loop
    perform private.close_guest_needs(v_entry, p_category);
  end loop;
  if p_category = 'Dietary and Allergies' then
    update app.person_work_details w set dietary_needs = '{}', allergies = null, dietary_notes = null
    where w.person_id = p_person_id and (cardinality(w.dietary_needs) > 0 or w.allergies is not null or w.dietary_notes is not null);
    update app.roster_travel_requests t set meal_preference = null
    from private.roster_people r
    where r.roster_entry_id = t.roster_entry_id and r.person_id = p_person_id and t.meal_preference is not null;
    perform private.record_sensitive_field('meal_preference', false, null, p_person_id);
    perform private.remove_work_detail_share_category(p_person_id, 'Dietary Needs');
  elsif p_category = 'Accessibility' then
    update app.person_work_details w set accessibility_needs = '{}', accessibility_notes = null
    where w.person_id = p_person_id and (cardinality(w.accessibility_needs) > 0 or w.accessibility_notes is not null);
    perform private.remove_work_detail_share_category(p_person_id, 'Accessibility Needs');
  end if;
  return true;
end;
$$;

comment on function private.erase_sensitive_category(uuid, uuid, app.sensitive_data_category) is 'Clears the values of one category for a person or company: their work details, their meal preference on every roster entry, what was attested about them on a guest list, and the category on their shares. Supplier diversity certifications are de-identified. Returns false, clearing nothing, while a legal hold reaches the person: the values stay masked and the daily job clears them when the hold ends.';
revoke all on function private.erase_sensitive_category(uuid, uuid, app.sensitive_data_category) from public, anon, authenticated;

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
      or (n.guest_email is not null and n.guest_email = private.my_verified_email()))
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
  v_needs app.guest_care_needs;
begin
  select * into v_consent from app.sensitive_data_consents c
  where c.id = p_consent_id and c.basis = 'Attested Authority' and c.withdrawn_at is null and c.account_id is null;
  select * into v_needs from app.guest_care_needs n where n.guest_list_entry_id = v_consent.guest_list_entry_id;
  if v_consent.id is null or not (v_consent.person_id = v_me or v_consent.given_by = v_me
      or (v_needs.guest_email is not null and v_needs.guest_email = private.my_verified_email())) then
    perform private.refuse('sensitive_entry_not_yours', 'Only the person this is about, or whoever entered it, removes it.');
  end if;
  if v_consent.guest_list_entry_id is not null then
    perform private.close_guest_needs(v_consent.guest_list_entry_id, v_consent.category);
    perform private.write_audit_event(v_consent.org_id, 'guest_needs.cleared', 'app.guest_list_entries', v_consent.guest_list_entry_id, '{}'::jsonb);
  else
    update app.sensitive_data_consents c set withdrawn_at = now(), withdrawn_by = v_me where c.id = v_consent.id;
    update app.roster_travel_requests t set meal_preference = null
    from private.roster_people r, app.engagement_roster_entries e, app.engagements g, app.counterparties k
    where r.roster_entry_id = t.roster_entry_id and r.person_id = v_consent.person_id and t.meal_preference is not null
      and e.id = t.roster_entry_id and g.id = e.engagement_id and k.id = g.counterparty_id and k.organization_id = v_consent.org_id;
    perform private.record_sensitive_field('meal_preference', exists (
      select 1 from app.roster_travel_requests t join private.roster_people r on r.roster_entry_id = t.roster_entry_id
      where r.person_id = v_consent.person_id and t.meal_preference is not null and t.deleted_at is null),
      private.sensitive_consent_id(v_consent.person_id, 'Dietary and Allergies'), v_consent.person_id);
  end if;
  if v_consent.person_id is not null then
    perform private.log_work_detail_event(v_consent.person_id, 'sensitive_consent.entry_removed', v_consent.org_id, null, '{}', '{}', null);
  end if;
end;
$$;

comment on function app.remove_sensitive_entry(uuid) is 'The person an attestation is about, or whoever gave it, removes it in one call: the attestation is withdrawn and the values it covers are deleted. Refuses sensitive_entry_not_yours.';
revoke all on function app.remove_sensitive_entry(uuid) from public, anon;
grant execute on function app.remove_sensitive_entry(uuid) to authenticated, service_role;

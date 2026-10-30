-- 2663_allergies_restricted.sql
-- R6a (RRR-185, ADR 0105; owner decisions 4 and 5 of 2026-10-28, ADR 0102 decisions 1, 3 and 4). Allergies become
-- Restricted, and Contact becomes a category a person can share.
--
--   * app.person_work_details.allergies is Restricted under data.restricted.read.medical (0203_capability_seed.sql:296).
--     Dietary needs and dietary notes stay Confidential.
--   * private.read_allergies is the one place an allergy value leaves for someone other than its owner: a holder of
--     the capability on the project reads it, and every such read is written to the person's access log
--     (allergies.viewed) and the producing org's audit ledger (work_details.allergies_viewed), never deduplicated;
--     anyone else gets it masked. The holders are the org-wide holders (the Owner) and, by default, the catering lead
--     and on-site medical roles worked on the project (2662).
--   * app.roster_shared_work_details (2638), and app.shared_work_details through it:
--       dietary   gains allergies_masked; its allergies come from private.read_allergies.
--       medical   new, {allergies}: present when the share names Dietary Needs and the reader holds the capability on
--                 the project, also without hospitality.fulfillment.read. A medical-only reader's readable list stays
--                 without Dietary Needs and their dietary key is NULL.
--       contact   new, {email, phone}: the verified sign-in email and phone (private.recipient_address), for org
--                 readers whose capabilities cover Contact (engagement readers and safety readers) and for the company.
--       uniform and travel keep their keys; their retired values read NULL (2664).
--     The company (an external account) never holds the capability, so it always reads allergies masked (decision 4),
--     and it no longer reads the retired Uniform Sizes category. Every read with something readable logs
--     work_details.viewed and its audit event; 2638 already dropped 1340's ten-minute merge, and its helper goes here.
--   * Contact: private.work_detail_category_capabilities maps it to opportunities.engagement.read and
--     safety.incident.read, and a share may now name seven categories.
--   * private.work_detail_share_visible lets a medical holder on the project see that a share exists.
-- Each function starts from its latest definition: 1340_work_details.sql for the category map and share visibility,
-- 2638_roster_work_detail_shares.sql for the reads.

-- Classification --------------------------------------------------------------------------------------------------------

update private.column_classifications
set classification = 'Restricted', read_capability = 'data.restricted.read.medical'
where table_name = 'app.person_work_details' and column_name = 'allergies';

comment on column app.person_work_details.allergies is 'Food and other allergies in the person''s words, with how severe they are. Restricted (data.restricted.read.medical, R6a): an engaging org reads them only through private.read_allergies, which logs every unmasked read; the catering lead and on-site medical roles hold the capability on their project (2662).';

-- Contact ------------------------------------------------------------------------------------------------------------------

create or replace function private.work_detail_category_capabilities(p_category app.work_detail_category)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case p_category
    when 'Emergency Contacts' then array['safety.incident.read', 'opportunities.engagement.write']
    when 'Contact' then array['opportunities.engagement.read', 'safety.incident.read']
    when 'Uniform Sizes' then array['opportunities.engagement.read', 'crew.shift.write']
    else array['hospitality.fulfillment.read']
  end;
$$;

comment on function private.work_detail_category_capabilities(app.work_detail_category) is 'Project capabilities that let a member of the engaging org read a shared category, any one of them: safety readers and engagement editors for emergency contacts; engagement readers and safety readers for the person''s own contact (R6a); engagement readers and shift editors for the retired uniform sizes; hospitality readers for dietary and accessibility needs, loyalty programs and the passport details. Unmasked allergies need data.restricted.read.medical besides (private.read_allergies).';
revoke all on function private.work_detail_category_capabilities(app.work_detail_category) from public, anon;
grant execute on function private.work_detail_category_capabilities(app.work_detail_category) to authenticated, service_role;

alter table app.work_detail_shares drop constraint work_detail_shares_categories;
alter table app.work_detail_shares add constraint work_detail_shares_categories check (cardinality(categories) between 1 and 7);

create or replace function private.work_detail_share_visible(p_engagement_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.engagements e
    where e.id = p_engagement_id
      and (private.can_on_project(e.project_id, 'opportunities.engagement.read')
        or exists (select 1 from unnest(enum_range(null::app.work_detail_category)) c
                   where private.can_read_work_detail_category(e.project_id, c))
        or private.can_on_project(e.project_id, 'data.restricted.read.medical')));
$$;

comment on function private.work_detail_share_visible(uuid) is 'True when a member of the engaging org may see that a share exists and which categories it names: engagement readers, anyone who reads one of the categories on the engagement''s project, and holders of data.restricted.read.medical there (R6a: the catering lead and on-site medical). Reads app.engagements, never the share table its caller protects.';
revoke all on function private.work_detail_share_visible(uuid) from public, anon;
grant execute on function private.work_detail_share_visible(uuid) to authenticated, service_role;

-- The one Restricted read of allergies --------------------------------------------------------------------------------------

create or replace function private.read_allergies(
  p_project_id uuid,
  p_person_id uuid,
  p_org_id uuid,
  p_engagement_id uuid,
  p_subject_table text,
  p_subject_id uuid,
  p_allergies text,
  p_roster_entry_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_allergies is null then
    return jsonb_build_object('allergies', null, 'allergies_masked', false);
  end if;
  if private.can_on_project(p_project_id, 'data.restricted.read.medical') then
    perform private.log_work_detail_event(p_person_id, 'allergies.viewed', p_org_id, p_engagement_id,
      array['Dietary Needs']::app.work_detail_category[], '{}', null, p_roster_entry_id);
    perform private.write_audit_event(p_org_id, 'work_details.allergies_viewed', p_subject_table, p_subject_id, '{}'::jsonb);
    return jsonb_build_object('allergies', p_allergies, 'allergies_masked', false);
  end if;
  return jsonb_build_object('allergies', null, 'allergies_masked', true);
end;
$$;

comment on function private.read_allergies(uuid, uuid, uuid, uuid, text, uuid, text, uuid) is 'The Restricted read of a person''s allergies for someone other than the person (R6a): the value for a holder of data.restricted.read.medical on the project, logged every time as allergies.viewed in the person''s access log (with the roster entry) and work_details.allergies_viewed on the subject in the org''s audit ledger; masked (allergies_masked) for anyone else; nothing to mask when none are recorded.';
revoke all on function private.read_allergies(uuid, uuid, uuid, uuid, text, uuid, text, uuid) from public, anon, authenticated;

-- Reads -------------------------------------------------------------------------------------------------------------------------

drop function private.work_details_view_logged_recently(uuid, uuid);

create or replace function private.empty_work_details(p_engagement app.engagements, p_person_id uuid, p_roster_entry_id uuid, p_reader text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object('engagement_id', p_engagement.id, 'person_id', p_person_id, 'org_id', p_engagement.org_id,
    'roster_entry_id', p_roster_entry_id, 'reader', p_reader, 'work_detail_share_id', null, 'shared_at', null,
    'categories', '[]'::jsonb, 'readable', '[]'::jsonb,
    'sharing_open', private.engagement_shares_work_details(p_engagement.engagement_state),
    'emergency_contacts', null, 'contact', null, 'uniform', null, 'dietary', null, 'medical', null, 'accessibility', null,
    'travel', null, 'passport', null);
$$;

comment on function private.empty_work_details(app.engagements, uuid, uuid, text) is 'The shape of a work details read with nothing readable.';
revoke all on function private.empty_work_details(app.engagements, uuid, uuid, text) from public, anon, authenticated;

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
  v_medical boolean := false;
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
    -- The medical read: the share names Dietary Needs and the reader holds the capability on the project.
    v_medical := 'Dietary Needs' = any (v_share.categories)
      and private.can_on_project(v_engagement.project_id, 'data.restricted.read.medical');
    v_log_org := v_engagement.org_id;
  else
    -- Owner decision 4: the company reads every category of a person who accepted its roster entry, except the
    -- retired Uniform Sizes (R6a), whose values are now entered per roster entry.
    v_readable := array_remove(enum_range(null::app.work_detail_category), 'Uniform Sizes');
    v_log_org := v_account;
  end if;
  select * into v_details from app.person_work_details w where w.person_id = v_person and w.deleted_at is null;

  if cardinality(v_readable) > 0 or v_medical then
    v_logged := (select array_agg(distinct c order by c) from unnest(v_readable || case when v_medical
      then array['Dietary Needs']::app.work_detail_category[] else '{}'::app.work_detail_category[] end) c);
    -- Allergies leave only through the Restricted read, which logs each unmasked read; the company never holds it.
    if v_reader = 'org' and ('Dietary Needs' = any (v_readable) or v_medical) then
      v_allergies := private.read_allergies(v_engagement.project_id, v_person, v_engagement.org_id, v_engagement.id,
        'app.engagement_roster_entries', v_entry.id, v_details.allergies, v_entry.id);
    else
      v_allergies := jsonb_build_object('allergies', null, 'allergies_masked', v_details.allergies is not null);
    end if;
    perform private.log_work_detail_event(v_person, 'work_details.viewed', v_log_org, v_engagement.id, v_logged, '{}', null, v_entry.id);
    perform private.write_audit_event(v_engagement.org_id, 'work_details.viewed', 'app.engagement_roster_entries', v_entry.id,
      jsonb_build_object('categories', to_jsonb(v_logged), 'reader', v_reader,
        'allergies_unmasked', v_allergies ->> 'allergies' is not null));
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
    'uniform', case when 'Uniform Sizes' = any (v_readable) then jsonb_build_object(
      'shirt_size', v_details.shirt_size, 'jacket_size', v_details.jacket_size, 'pants_size', v_details.pants_size,
      'shoe_size', v_details.shoe_size, 'glove_size', v_details.glove_size, 'hat_size', v_details.hat_size,
      'uniform_notes', v_details.uniform_notes) end,
    'dietary', case when 'Dietary Needs' = any (v_readable) then jsonb_build_object(
      'dietary_needs', to_jsonb(coalesce(v_details.dietary_needs, '{}')),
      'allergies', v_allergies -> 'allergies',
      'allergies_masked', coalesce((v_allergies ->> 'allergies_masked')::boolean, false),
      'allergies_on_file', v_details.allergies is not null,
      'dietary_notes', v_details.dietary_notes) end,
    'medical', case when v_medical then jsonb_build_object('allergies', v_allergies -> 'allergies') end,
    'accessibility', case when 'Accessibility Needs' = any (v_readable) then jsonb_build_object(
      'accessibility_needs', to_jsonb(coalesce(v_details.accessibility_needs, '{}')),
      'accessibility_notes', v_details.accessibility_notes) end,
    'travel', case when 'Travel Profile' = any (v_readable) then jsonb_build_object(
      'seat_preference', v_details.seat_preference, 'meal_preference', v_details.meal_preference,
      'home_airport', v_details.home_airport,
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

comment on function app.roster_shared_work_details(uuid) is 'The work details of the person on a roster entry (R4, owner decision 4; R6a). Org readers (private.work_detail_share_visible) read the categories shared on the entry that their project capabilities cover; company readers (a roster manager who is not the person, while the person''s account_roster_sharing consent for the supplying account stands) read every category but the retired Uniform Sizes; anyone else gets 42501. Allergies are Restricted: they come back only through private.read_allergies, to holders of data.restricted.read.medical on the project, in dietary when the reader also reads Dietary Needs and in medical whenever the share names Dietary Needs; everyone else, the company always, reads them masked (allergies_masked, allergies_on_file). contact is the verified sign-in email and phone. The passport number is always masked. Every read with something readable writes the person''s access log and the producing org''s audit ledger, without dedupe, and every unmasked allergy read also logs allergies.viewed.';

comment on function app.shared_work_details(uuid) is 'What the engaged person shared of their work details, through their self roster entry (app.roster_shared_work_details, R4 and R6a): the same rules, masks and logging, allergies Restricted to medical readers; the empty shape when the engagement has no self entry.';

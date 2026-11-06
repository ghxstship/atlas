-- 6161_sensitive_data_restricted_reads.sql
-- RRR-248 issue 5, ADR 0164 (extends ADR 0105). Who reads sensitive data, once a person has consented.
--
--   * Dietary needs, dietary notes, accessibility needs, accessibility notes and a roster entry's meal preference join
--     allergies as Restricted under data.restricted.read.medical: never directly selectable. 6162 masks the meal preference
--     in every read of a roster entry's travel. The person reads their own through app.my_work_detail_needs;
--     the Owner and, on their project, the catering lead and on-site medical roles (4662) read a person's through
--     app.roster_shared_work_details, on a live share, every read logged. A hospitality reader sees them locked, and the
--     company that rosters the person sees them locked too: it has no need of them (ADR 0164 supersedes the part of owner
--     decision 4 that let it read them). Because the read capability is data.restricted.read.medical, app.request_export
--     refuses these columns in any export for anyone (export_medical_excluded, 0530).
--   * app.catering_counts still gives hospitality readers counts, suppressed below five, of people whose consent stands.
--   * Nothing leaves while the person's consent does not stand: the values read as if absent.
--   * A supplier diversity kind becomes Restricted under data.restricted.read.government_id, as its certificate number is.
--     An org reads shared certifications only with that capability on top of vendors.vendor.read; a reader with the
--     vendor capability alone sees none. Nothing is shared or read while the owner's consent does not stand.
-- Functions start from their latest definitions: 4663_allergies_restricted.sql for app.roster_shared_work_details,
-- 4695_allocation_status.sql for private.catering_people, 2011_supplier_certificate_number_encryption.sql for
-- app.shared_supplier_diversity and app.reveal_shared_supplier_diversity_number, 1464_supplier_diversity.sql for
-- app.share_supplier_diversity.

-- Classification ------------------------------------------------------------------------------------------------------

update private.column_classifications
set classification = 'Restricted', read_capability = 'data.restricted.read.medical'
where table_name = 'app.person_work_details' and column_name in ('dietary_needs', 'dietary_notes', 'accessibility_needs', 'accessibility_notes');

update private.column_classifications
set classification = 'Restricted', read_capability = 'data.restricted.read.medical'
where table_name = 'app.roster_travel_requests' and column_name = 'meal_preference';

update private.column_classifications
set classification = 'Restricted', read_capability = 'data.restricted.read.government_id'
where table_name = 'app.supplier_diversity_certifications' and column_name = 'diversity_kind';

revoke select (dietary_needs, dietary_notes, accessibility_needs, accessibility_notes) on app.person_work_details from authenticated;
revoke select (diversity_kind) on app.supplier_diversity_certifications from authenticated;

-- The person keeps selecting their own travel requests, every column but this one.
revoke select on app.roster_travel_requests from authenticated;
grant select (id, org_id, roster_entry_id, inbound_airport_code, outbound_airport_code, inbound_on, outbound_on, seat_preference,
  needs_ground_transport, needs_lodging, travel_notes, created_at, created_by, updated_at, updated_by, deleted_at)
  on app.roster_travel_requests to authenticated;

comment on column app.person_work_details.dietary_needs is 'Dietary needs hospitality caters for, each once, in enum order. Restricted (data.restricted.read.medical, ADR 0164): never directly selectable; a new value needs the person''s standing consent. The person reads their own through app.my_work_detail_needs.';
comment on column app.person_work_details.dietary_notes is 'Other dietary notes. Restricted (data.restricted.read.medical, ADR 0164): never directly selectable; a new value needs the person''s standing consent. The person reads their own through app.my_work_detail_needs.';
comment on column app.person_work_details.accessibility_needs is 'Accessibility needs, each once, in enum order. Restricted (data.restricted.read.medical, ADR 0164): never directly selectable; a new value needs the person''s standing consent. The person reads their own through app.my_work_detail_needs.';
comment on column app.person_work_details.accessibility_notes is 'Accessibility needs in the person''s words. Restricted (data.restricted.read.medical, ADR 0164): never directly selectable; a new value needs the person''s standing consent. The person reads their own through app.my_work_detail_needs.';
comment on column app.roster_travel_requests.meal_preference is 'Meal preference for the flight, as the person writes it. Dietary data: Restricted (data.restricted.read.medical, ADR 0164), never directly selectable. It stands on the person''s consent or the company''s attestation. The person reads their own through app.roster_project_facts, a holder on the project reads it there or in the travel party, each read logged, and everyone else sees it locked. The company that rosters the person never reads it, even what it entered.';
comment on column app.supplier_diversity_certifications.diversity_kind is 'Kind of certification, which can reveal ownership by a protected group. Restricted (data.restricted.read.government_id, ADR 0164): never directly selectable; the owner reads it through app.my_supplier_diversity and an org holding the capability through app.shared_supplier_diversity. A new value needs the owner''s standing consent.';

create or replace function app.my_work_detail_needs()
returns table (
  dietary_needs app.dietary_need[],
  dietary_notes text,
  accessibility_needs app.accessibility_need[],
  accessibility_notes text
)
language sql
stable
security definer
set search_path = ''
as $$
  select w.dietary_needs, w.dietary_notes, w.accessibility_needs, w.accessibility_notes
  from app.person_work_details w
  where w.person_id = private.require_person() and w.deleted_at is null;
$$;

comment on function app.my_work_detail_needs() is 'The signed-in person''s own dietary and accessibility needs (ADR 0164): the one read of these Restricted columns for their owner, unlogged like the rest of their own work details.';
revoke all on function app.my_work_detail_needs() from public, anon;
grant execute on function app.my_work_detail_needs() to authenticated, service_role;

-- The roster read -----------------------------------------------------------------------------------------------------

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
    'uniform', case when 'Uniform Sizes' = any (v_readable) then jsonb_build_object(
      'shirt_size', v_details.shirt_size, 'jacket_size', v_details.jacket_size, 'pants_size', v_details.pants_size,
      'shoe_size', v_details.shoe_size, 'glove_size', v_details.glove_size, 'hat_size', v_details.hat_size,
      'uniform_notes', v_details.uniform_notes) end,
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

comment on function app.roster_shared_work_details(uuid) is 'The work details of the person on a roster entry (R4, owner decision 4; R6a; ADR 0164). Org readers (private.work_detail_share_visible) read the categories shared on the entry that their project capabilities cover; company readers (a roster manager who is not the person, while the person''s account_roster_sharing consent for the supplying account stands) read every category but the retired Uniform Sizes; anyone else gets 42501. Dietary needs and notes, allergies and accessibility needs and notes are Restricted and read as absent while the person''s sensitive data consent does not stand: they come back only to holders of data.restricted.read.medical on the project, in dietary or accessibility when the reader also reads the category and in medical whenever the share names it, each unmasked read logged; everyone else, the company always, reads them masked (dietary_masked, allergies_masked, accessibility_masked). contact is the verified sign-in email and phone. The passport number is always masked. Every read with something readable writes the person''s access log and the producing org''s audit ledger, without dedupe.';
revoke all on function app.roster_shared_work_details(uuid) from public, anon;
grant execute on function app.roster_shared_work_details(uuid) to authenticated, service_role;

-- Catering counts -----------------------------------------------------------------------------------------------------

create or replace function private.catering_people(p_fulfillment_id uuid)
returns table (person_id uuid, roster_entry_id uuid, engagement_id uuid, dietary_needs app.dietary_need[], has_allergies boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct on (l.person_id) l.person_id, a.roster_entry_id, r.engagement_id,
    case when s.id is not null and private.sensitive_consent_stands(l.person_id, 'Dietary and Allergies') then coalesce(w.dietary_needs, '{}') end,
    case when s.id is not null and private.sensitive_consent_stands(l.person_id, 'Dietary and Allergies') then w.allergies is not null else false end
  from app.fulfillment_lines l
  join app.advance_allocations a on a.id = l.allocation_id
  join app.engagement_roster_entries r on r.id = a.roster_entry_id
  left join app.work_detail_shares s on s.roster_entry_id = a.roster_entry_id and s.revoked_at is null and s.deleted_at is null
    and 'Dietary Needs' = any (s.categories)
  left join app.person_work_details w on w.person_id = l.person_id and w.deleted_at is null
  where l.fulfillment_id = p_fulfillment_id and l.deleted_at is null and l.person_id is not null
  order by l.person_id, s.shared_at desc nulls last;
$$;
comment on function private.catering_people(uuid) is 'The distinct people with live allocated lines on a catering fulfillment, with their roster entry and, only when their live share on that entry includes Dietary Needs and their sensitive data consent stands, their dietary needs and whether they recorded allergies. Callers authorize and log.';
revoke all on function private.catering_people(uuid) from public, anon, authenticated;

-- Supplier diversity --------------------------------------------------------------------------------------------------

create or replace function private.supplier_diversity_consent_stands(p_person_id uuid, p_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case when p_account_id is not null then private.sensitive_account_consent_id(p_account_id, 'Supplier Diversity') is not null
              else private.sensitive_consent_stands(p_person_id, 'Supplier Diversity') end;
$$;

comment on function private.supplier_diversity_consent_stands(uuid, uuid) is 'True while the owner''s consent, or a company''s attestation, for its supplier diversity status stands.';
revoke all on function private.supplier_diversity_consent_stands(uuid, uuid) from public, anon, authenticated;

create or replace function app.share_supplier_diversity(p_certification_id uuid, p_org_id uuid, p_notice_version text default '1.0.0')
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_cert app.supplier_diversity_certifications;
  v_consent uuid;
  v_id uuid;
begin
  select * into v_cert from app.supplier_diversity_certifications c where c.id = p_certification_id and c.deleted_at is null;
  if v_cert.id is null or not private.owns_supplier_diversity(v_cert.person_id, v_cert.account_id) then
    perform private.refuse('supplier_diversity_not_yours', 'Only the owner shares a supplier diversity certification.');
  end if;
  if not private.supplier_diversity_consent_stands(v_cert.person_id, v_cert.account_id) then
    perform private.refuse_without_sensitive_consent('Supplier Diversity');
  end if;
  if not exists (select 1 from app.organizations o where o.id = p_org_id and o.deleted_at is null) then
    perform private.refuse('org_unknown', 'The organization does not exist.');
  end if;
  if not private.supplier_diversity_program_on(p_org_id) then
    perform private.refuse('supplier_diversity_no_program', 'This organization does not run a supplier diversity program, so it takes no diversity certifications.');
  end if;
  if private.org_read_only(p_org_id) then
    perform private.refuse('org_read_only', 'This organization is canceled and read-only, so it takes no new shares.');
  end if;
  select s.id into v_id from app.supplier_diversity_shares s
  where s.org_id = p_org_id and s.supplier_diversity_certification_id = p_certification_id and s.revoked_at is null and s.deleted_at is null;
  if v_id is not null then
    return v_id;
  end if;
  select r.id into v_consent from app.consent_records r
  where r.org_id = p_org_id and r.person_id = v_me and r.purpose_code = 'supplier_diversity'
    and r.withdrawn_at is null and r.deleted_at is null;
  if v_consent is null then
    insert into app.consent_records (org_id, person_id, purpose_code, notice_version, source)
    values (p_org_id, v_me, 'supplier_diversity', coalesce(nullif(btrim(p_notice_version), ''), '1.0.0'), 'Web')
    returning id into v_consent;
  end if;
  insert into app.supplier_diversity_shares (org_id, supplier_diversity_certification_id, consent_record_id)
  values (p_org_id, p_certification_id, v_consent)
  returning id into v_id;
  perform private.log_supplier_diversity_event(p_certification_id, 'supplier_diversity.shared', p_org_id);
  perform private.write_audit_event(p_org_id, 'supplier_diversity.shared', 'app.supplier_diversity_shares', v_id, '{}'::jsonb);
  return v_id;
end;
$$;

comment on function app.share_supplier_diversity(uuid, uuid, text) is 'The owner shares one supplier diversity certification with an org that runs a supplier diversity program, recording supplier_diversity consent for that org when none stands (separate from profile sharing). Needs the owner''s standing sensitive data consent (sensitive_consent_required, ADR 0164). Idempotent while the share stands. Logged in the owner''s access log and the org''s audit ledger. Returns the share id.';
revoke all on function app.share_supplier_diversity(uuid, uuid, text) from public, anon;
grant execute on function app.share_supplier_diversity(uuid, uuid, text) to authenticated, service_role;

create or replace function app.shared_supplier_diversity(p_org_id uuid)
returns table (
  share_id uuid,
  certification_id uuid,
  person_id uuid,
  person_name text,
  account_id uuid,
  account_name text,
  diversity_kind app.supplier_diversity_kind,
  certifying_body text,
  certificate_number_last4 text,
  issued_on date,
  expires_on date,
  shared_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_count integer := 0;
begin
  perform private.require_person();
  if not private.has_capability(p_org_id, 'vendors.vendor.read') then
    raise exception using errcode = '42501', message = 'vendors.vendor.read is required';
  end if;
  -- ADR 0164: the kind is Restricted, so a reader with the vendor capability alone sees none.
  if not private.supplier_diversity_program_on(p_org_id) or not private.has_capability(p_org_id, 'data.restricted.read.government_id') then
    return;
  end if;
  for v_row in
    select s.id as share_id, c.id as certification_id, c.person_id, p.full_name as person_name, c.account_id, a.name as account_name,
      c.diversity_kind, c.certifying_body, c.certificate_number_last4, c.issued_on, c.expires_on, s.shared_at
    from app.supplier_diversity_shares s
    join app.supplier_diversity_certifications c on c.id = s.supplier_diversity_certification_id and c.deleted_at is null
    left join app.people p on p.id = c.person_id
    left join app.organizations a on a.id = c.account_id
    where s.org_id = p_org_id and s.revoked_at is null and s.deleted_at is null
      and private.supplier_diversity_consent_stands(c.person_id, c.account_id)
    order by coalesce(a.name, p.full_name), c.diversity_kind
  loop
    share_id := v_row.share_id;
    certification_id := v_row.certification_id;
    person_id := v_row.person_id;
    person_name := v_row.person_name;
    account_id := v_row.account_id;
    account_name := v_row.account_name;
    diversity_kind := v_row.diversity_kind;
    certifying_body := v_row.certifying_body;
    certificate_number_last4 := v_row.certificate_number_last4;
    issued_on := v_row.issued_on;
    expires_on := v_row.expires_on;
    shared_at := v_row.shared_at;
    perform private.log_supplier_diversity_event(v_row.certification_id, 'supplier_diversity.viewed', p_org_id);
    v_count := v_count + 1;
    return next;
  end loop;
  if v_count > 0 then
    perform private.write_audit_event(p_org_id, 'supplier_diversity.viewed', 'app.supplier_diversity_shares', null,
      jsonb_build_object('certifications', v_count));
  end if;
end;
$$;

comment on function app.shared_supplier_diversity(uuid) is 'Supplier diversity certifications shared with an org, for its members holding both vendors.vendor.read and data.restricted.read.government_id (ADR 0164), only while each share stands, the owner''s consent stands and the org runs a supplier diversity program (Section 4.4.1). The certificate number shows its last four characters; the whole number leaves only through app.reveal_shared_supplier_diversity_number. Every read is logged in each owner''s access log and once in the org''s audit ledger.';
revoke all on function app.shared_supplier_diversity(uuid) from public, anon;
grant execute on function app.shared_supplier_diversity(uuid) to authenticated, service_role;

create or replace function app.reveal_shared_supplier_diversity_number(p_share_id uuid, p_reason text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_share app.supplier_diversity_shares;
  v_cert app.supplier_diversity_certifications;
begin
  perform private.require_person();
  select * into v_share from app.supplier_diversity_shares s
  where s.id = p_share_id and s.revoked_at is null and s.deleted_at is null;
  if v_share.id is null or not private.has_capability(v_share.org_id, 'vendors.vendor.read') then
    raise exception using errcode = '42501', message = 'vendors.vendor.read is required';
  end if;
  if not private.has_capability(v_share.org_id, 'data.restricted.read.government_id') then
    raise exception using errcode = '42501', message = 'data.restricted.read.government_id is required';
  end if;
  select * into v_cert from app.supplier_diversity_certifications c
  where c.id = v_share.supplier_diversity_certification_id and c.deleted_at is null;
  if v_cert.id is null or not private.supplier_diversity_program_on(v_share.org_id)
     or not private.supplier_diversity_consent_stands(v_cert.person_id, v_cert.account_id) then
    perform private.refuse('supplier_diversity_not_shared', 'This certification is not shared with the organization.');
  end if;
  perform private.require_second_factor('reveal a certificate number', false);
  if char_length(btrim(coalesce(p_reason, ''))) < 10 then
    perform private.refuse('certificate_reveal_reason', 'Write why you need the certificate number, in at least 10 characters.');
  end if;
  if v_cert.certificate_number is null then
    perform private.refuse('certificate_number_missing', 'No certificate number is recorded.');
  end if;
  perform private.log_supplier_diversity_event(v_cert.id, 'supplier_diversity.revealed', v_share.org_id, left(btrim(p_reason), 500));
  perform private.write_audit_event(v_share.org_id, 'supplier_diversity.number_revealed', 'app.supplier_diversity_shares', v_share.id,
    jsonb_build_object('reason', left(btrim(p_reason), 500)));
  return extensions.pgp_sym_decrypt(v_cert.certificate_number, private.supplier_certificate_number_key());
end;
$$;

comment on function app.reveal_shared_supplier_diversity_number(uuid, text) is 'The explicit reveal of a shared supplier diversity certificate number to a member of the org: needs a live share, the owner''s standing consent (ADR 0164), a running program, vendors.vendor.read and data.restricted.read.government_id, step-up and a reason of at least 10 characters. Logged with the reason, never the value, in the owner''s access log and the org''s audit ledger.';
revoke all on function app.reveal_shared_supplier_diversity_number(uuid, text) from public, anon;
grant execute on function app.reveal_shared_supplier_diversity_number(uuid, text) to authenticated, service_role;

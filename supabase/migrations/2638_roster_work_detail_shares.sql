-- 2638_roster_work_detail_shares.sql
-- R4 Crew roster core (RRR-182, ADR 0102; owner decisions 0/1 and 4 of 2026-10-28). Work details shares key on the
-- roster entry, so every person on a roster shares with the engagement, not only the engaged person, and the company
-- reads the profile facts of the people on its roster. Each function is recreated from its only definition, in
-- 1340_work_details.sql.
--
--   * app.work_detail_shares.roster_entry_id (added in 2637) is backfilled from the engagement's self entry; one live
--     share per entry replaces one per engagement. private.guard_work_detail_share_entry refuses a new share without an
--     entry and any row whose engagement or person differs from the entry's. engagement_id and person_id stay, as
--     registered derived values written from the entry by app.share_work_details (the frozen WorkDetailShare resource
--     keeps them; ADR 0103, contract in R6b).
--   * app.work_detail_events.roster_entry_id names the entry of share, read and reveal events;
--     private.log_work_detail_event takes it as its last parameter.
--   * app.share_work_details: the caller's own live entry on the engagement (the self entry for the engaged person,
--     else their entry, which they must have accepted). The share serves the producing org and the company alike.
--   * app.my_work_detail_sharing keeps its columns and lists the caller's roster entries instead of the engagements
--     naming them, so Gateway and Compass Work Details work unchanged.
--   * app.roster_shared_work_details(entry): org readers (private.work_detail_share_visible) read the shared categories
--     their project capabilities cover; company readers (a roster manager who is not the person, while the person's
--     account_roster_sharing consent for the supplying account stands, 2635) read every category (owner decision 4).
--     The passport number is always masked. Allergies keep today's rule for org readers until R6a and are always NULL
--     for company readers, with allergies_on_file. Every read with readable categories is logged in the person's access
--     log and the producing org's audit ledger, without the ten-minute dedupe of 1340; an unmasked allergy read is
--     logged as allergies.viewed too.
--   * app.shared_work_details(engagement) answers for the self entry; app.reveal_shared_passport_number finds the share
--     by the self entry; app.reveal_roster_passport_number reveals on any entry, to producing-org readers only.

-- Shares key on the entry ---------------------------------------------------------------------------------------------------

update app.work_detail_shares s set roster_entry_id = r.id
from app.engagement_roster_entries r
where r.engagement_id = s.engagement_id and r.is_self and r.deleted_at is null and s.roster_entry_id is null;

drop index app.work_detail_shares_live_key;
create unique index work_detail_shares_live_entry_key on app.work_detail_shares (roster_entry_id)
  where revoked_at is null and deleted_at is null;

call private.install_tenant_guards('app.work_detail_shares', 'app.engagements', 'engagement_id',
  array['app.consent_records', 'consent_record_id', 'app.engagement_roster_entries', 'roster_entry_id']);

comment on table app.work_detail_shares is 'A person''s consent to share chosen categories of their work details for one roster entry (Section 4.5.6 item 10, Section 14.3, R4): with the org that engages them and with the company that rosters them. Written only by app.share_work_details and app.revoke_work_detail_share; one live share per roster entry. engagement_id and person_id are written from the entry.';
comment on column app.work_detail_shares.engagement_id is 'Engagement of the roster entry the share serves; written from the entry (registered derived value, kept for the WorkDetailShare resource).';
comment on column app.work_detail_shares.person_id is 'Person sharing, the entry''s resolved person; written from the entry (registered derived value, kept for the WorkDetailShare resource).';

create or replace function private.guard_work_detail_share_entry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and new.roster_entry_id is null then
    perform private.refuse('work_detail_share_roster_entry', 'A work details share serves a roster entry.');
  end if;
  if new.roster_entry_id is not null and not exists (
    select 1 from private.roster_people p
    where p.roster_entry_id = new.roster_entry_id and p.engagement_id = new.engagement_id and p.person_id = new.person_id) then
    perform private.refuse('work_detail_share_entry_mismatch', 'A share''s engagement and person are its roster entry''s.');
  end if;
  return new;
end;
$$;

comment on function private.guard_work_detail_share_entry() is 'Work details shares: a new share names its roster entry, and every share''s engagement and person are the entry''s engagement and resolved person.';
revoke all on function private.guard_work_detail_share_entry() from public, anon, authenticated;

create trigger t41_guard_work_detail_share_entry before insert or update of roster_entry_id, engagement_id, person_id on app.work_detail_shares
  for each row execute function private.guard_work_detail_share_entry();

-- The access log names the entry --------------------------------------------------------------------------------------------

alter table app.work_detail_events add column roster_entry_id uuid references app.engagement_roster_entries (id) on delete set null;
create index work_detail_events_roster_entry_id_idx on app.work_detail_events (roster_entry_id);
comment on column app.work_detail_events.roster_entry_id is 'Roster entry the share serves, for share, read and reveal events (R4).';

drop function private.log_work_detail_event(uuid, text, uuid, uuid, app.work_detail_category[], text[], text);

create or replace function private.log_work_detail_event(
  p_person_id uuid,
  p_action text,
  p_org_id uuid default null,
  p_engagement_id uuid default null,
  p_categories app.work_detail_category[] default '{}',
  p_changed_columns text[] default '{}',
  p_reason text default null,
  p_roster_entry_id uuid default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  insert into app.work_detail_events (person_id, actor_person_id, org_id, engagement_id, action, categories, changed_columns,
    reason, request_id, roster_entry_id)
  values (p_person_id, private.current_person_id(), p_org_id, p_engagement_id, p_action, coalesce(p_categories, '{}'),
    coalesce(p_changed_columns, '{}'), nullif(btrim(p_reason), ''), left(private.request_header('x-request-id'), 200),
    p_roster_entry_id);
end;
$$;

comment on function private.log_work_detail_event(uuid, text, uuid, uuid, app.work_detail_category[], text[], text, uuid) is 'Writes one row to the person''s work details access log, with the acting person and request id from the session and, for share, read and reveal events, the roster entry.';
revoke all on function private.log_work_detail_event(uuid, text, uuid, uuid, app.work_detail_category[], text[], text, uuid) from public, anon, authenticated;

-- Sharing -------------------------------------------------------------------------------------------------------------------

create or replace function app.share_work_details(
  p_engagement_id uuid,
  p_categories app.work_detail_category[],
  p_notice_version text default '1.0.0'
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_engagement app.engagements;
  v_entry app.engagement_roster_entries;
  v_categories app.work_detail_category[] := (select array_agg(distinct c order by c) from unnest(p_categories) c where c is not null);
  v_share app.work_detail_shares;
  v_consent uuid;
begin
  select * into v_engagement from app.engagements e where e.id = p_engagement_id and e.deleted_at is null;
  if v_engagement.id is not null then
    select r.* into v_entry from app.engagement_roster_entries r
    where r.engagement_id = v_engagement.id and r.deleted_at is null and r.entry_state <> 'Withdrawn'
      and ((r.is_self and v_engagement.person_id = v_me) or (not r.is_self and r.person_id = v_me));
  end if;
  if v_entry.id is null then
    perform private.refuse('work_detail_share_not_yours', 'Only a person on an engagement''s roster shares their work details with it.');
  end if;
  if not v_entry.is_self and v_entry.person_response <> 'Accepted' then
    perform private.refuse('roster_entry_not_accepted', 'Accept the roster entry before sharing your work details with it.');
  end if;
  if not private.engagement_shares_work_details(v_engagement.engagement_state) then
    perform private.refuse('work_detail_share_closed', 'This engagement is complete or canceled, so nothing more is shared with it.');
  end if;
  if private.org_read_only(v_engagement.org_id) then
    perform private.refuse('org_read_only', 'This organization is canceled and read-only, so nothing more is shared with it.');
  end if;
  if coalesce(cardinality(v_categories), 0) = 0 then
    perform private.refuse('work_detail_share_categories', 'Choose at least one category to share, or revoke the share.');
  end if;

  select * into v_share from app.work_detail_shares s
  where s.roster_entry_id = v_entry.id and s.revoked_at is null and s.deleted_at is null;

  if v_share.id is not null then
    if v_share.categories = v_categories then
      return v_share.id;
    end if;
    update app.work_detail_shares s set categories = v_categories where s.id = v_share.id;
    perform private.log_work_detail_event(v_me, 'work_details.share_changed', v_engagement.org_id, v_engagement.id, v_categories, '{}', null, v_entry.id);
    return v_share.id;
  end if;

  select r.id into v_consent from app.consent_records r
  where r.org_id = v_engagement.org_id and r.person_id = v_me and r.purpose_code = 'work_details_sharing'
    and r.withdrawn_at is null and r.deleted_at is null;
  if v_consent is null then
    insert into app.consent_records (org_id, person_id, purpose_code, notice_version, source)
    values (v_engagement.org_id, v_me, 'work_details_sharing', coalesce(nullif(btrim(p_notice_version), ''), '1.0.0'), 'Web')
    returning id into v_consent;
  end if;
  insert into app.work_detail_shares (engagement_id, person_id, consent_record_id, categories, roster_entry_id)
  values (v_engagement.id, v_me, v_consent, v_categories, v_entry.id)
  returning * into v_share;
  perform private.log_work_detail_event(v_me, 'work_details.shared', v_engagement.org_id, v_engagement.id, v_categories, '{}', null, v_entry.id);
  return v_share.id;
end;
$$;

comment on function app.share_work_details(uuid, app.work_detail_category[], text) is 'A person on an engagement''s roster shares chosen categories of their work details on their own entry (the self entry for the engaged person; any other entry once they accepted it, else roster_entry_not_accepted), recording work_details_sharing consent for the producing org when none stands. The share serves the producing org and the company that rosters them. A second call replaces the categories (fewer is a partial revocation). Refused once the engagement is Complete or Canceled. Returns the share id.';

create or replace function private.close_work_detail_share(p_share app.work_detail_shares, p_action text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update app.work_detail_shares s set revoked_at = now() where s.id = p_share.id and s.revoked_at is null;
  -- The consent ends with the org's last live share.
  if not exists (select 1 from app.work_detail_shares s
                 where s.consent_record_id = p_share.consent_record_id and s.revoked_at is null and s.deleted_at is null) then
    update app.consent_records r set withdrawn_at = now() where r.id = p_share.consent_record_id and r.withdrawn_at is null;
  end if;
  perform private.log_work_detail_event(p_share.person_id, p_action, p_share.org_id, p_share.engagement_id, p_share.categories, '{}', null,
    p_share.roster_entry_id);
end;
$$;

comment on function private.close_work_detail_share(app.work_detail_shares, text) is 'Revokes a live share, withdraws the org''s work_details_sharing consent when no other live share uses it, and logs the act with its roster entry.';
revoke all on function private.close_work_detail_share(app.work_detail_shares, text) from public, anon, authenticated;

create or replace function app.my_work_detail_sharing()
returns table (
  engagement_id uuid,
  org_id uuid,
  org_name text,
  project_name text,
  role_type app.external_role_type,
  engagement_state app.engagement_state,
  start_date date,
  end_date date,
  sharing_open boolean,
  work_detail_share_id uuid,
  categories app.work_detail_category[],
  shared_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select e.id, e.org_id, o.name, p.name, e.role_type, e.engagement_state, e.start_date, e.end_date,
    private.engagement_shares_work_details(e.engagement_state) and (r.is_self or r.person_response = 'Accepted'),
    s.id, coalesce(s.categories, '{}'), s.shared_at
  from app.engagement_roster_entries r
  join app.engagements e on e.id = r.engagement_id and e.deleted_at is null
  join app.organizations o on o.id = e.org_id
  join app.projects p on p.id = e.project_id
  left join app.work_detail_shares s on s.roster_entry_id = r.id and s.revoked_at is null and s.deleted_at is null
  where r.deleted_at is null and r.entry_state <> 'Withdrawn'
    and private.roster_entry_person_id(r.is_self, r.person_id, e.person_id) = private.current_person_id()
  order by private.engagement_shares_work_details(e.engagement_state) desc, e.start_date desc, e.id;
$$;

comment on function app.my_work_detail_sharing() is 'The signed-in person''s roster entries (their own engagements'' self entries and the entries other parties put them on, R4) with what each shares of their work details: the org, project, state, whether sharing is open (Onboarding to Closing, and the entry accepted by them) and the live share''s categories. Open engagements first, newest first.';

-- Reads ---------------------------------------------------------------------------------------------------------------------

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
    'emergency_contacts', null, 'uniform', null, 'dietary', null, 'accessibility', null, 'travel', null, 'passport', null);
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
  v_allergies_unmasked boolean;
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
    v_log_org := v_engagement.org_id;
  else
    -- Owner decision 4: the company reads every category of a person who accepted its roster entry.
    v_readable := enum_range(null::app.work_detail_category);
    v_log_org := v_account;
  end if;
  select * into v_details from app.person_work_details w where w.person_id = v_person and w.deleted_at is null;
  -- Allergies keep today's category rule for org readers until R6a; a company reader never reads them.
  v_allergies_unmasked := v_reader = 'org' and 'Dietary Needs' = any (v_readable) and v_details.allergies is not null;

  if cardinality(v_readable) > 0 then
    perform private.log_work_detail_event(v_person, 'work_details.viewed', v_log_org, v_engagement.id, v_readable, '{}', null, v_entry.id);
    perform private.write_audit_event(v_engagement.org_id, 'work_details.viewed', 'app.engagement_roster_entries', v_entry.id,
      jsonb_build_object('categories', to_jsonb(v_readable), 'reader', v_reader, 'allergies_unmasked', v_allergies_unmasked));
    if v_allergies_unmasked then
      perform private.log_work_detail_event(v_person, 'allergies.viewed', v_log_org, v_engagement.id,
        array['Dietary Needs']::app.work_detail_category[], '{}', null, v_entry.id);
    end if;
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
    'uniform', case when 'Uniform Sizes' = any (v_readable) then jsonb_build_object(
      'shirt_size', v_details.shirt_size, 'jacket_size', v_details.jacket_size, 'pants_size', v_details.pants_size,
      'shoe_size', v_details.shoe_size, 'glove_size', v_details.glove_size, 'hat_size', v_details.hat_size,
      'uniform_notes', v_details.uniform_notes) end,
    'dietary', case when 'Dietary Needs' = any (v_readable) then jsonb_build_object(
      'dietary_needs', to_jsonb(coalesce(v_details.dietary_needs, '{}')),
      'allergies', case when v_allergies_unmasked then v_details.allergies end,
      'allergies_on_file', v_details.allergies is not null,
      'dietary_notes', v_details.dietary_notes) end,
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

comment on function app.roster_shared_work_details(uuid) is 'The work details of the person on a roster entry (R4, owner decision 4). Org readers (private.work_detail_share_visible) read the categories shared on the entry that their project capabilities cover; company readers (a roster manager who is not the person, while the person''s account_roster_sharing consent for the supplying account stands) read every category; anyone else gets 42501. The passport number is always masked. Allergies come back to org readers by today''s category rule until R6a and never to company readers; dietary.allergies_on_file says whether any are recorded. Every read with readable categories writes the person''s access log and the producing org''s audit ledger, without dedupe, and an unmasked allergy read also logs allergies.viewed.';

create or replace function app.shared_work_details(p_engagement_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
  v_entry uuid;
begin
  perform private.require_person();
  select * into v_engagement from app.engagements e where e.id = p_engagement_id and e.deleted_at is null;
  if v_engagement.id is null then
    raise exception using errcode = '42501', message = 'the engagement is not readable';
  end if;
  select r.id into v_entry from app.engagement_roster_entries r where r.engagement_id = v_engagement.id and r.is_self and r.deleted_at is null;
  if v_entry is null then
    if not private.work_detail_share_visible(v_engagement.id) then
      raise exception using errcode = '42501', message = 'the engagement is not readable';
    end if;
    return private.empty_work_details(v_engagement, v_engagement.person_id, null, 'org');
  end if;
  return app.roster_shared_work_details(v_entry);
end;
$$;

comment on function app.shared_work_details(uuid) is 'What the engaged person shared of their work details, through their self roster entry (app.roster_shared_work_details, R4): the same rules, masks and logging; the empty shape when the engagement has no self entry.';

create or replace function private.reveal_entry_passport_number(p_engagement app.engagements, p_roster_entry_id uuid, p_reason text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_share app.work_detail_shares;
  v_cipher bytea;
begin
  if p_engagement.id is null or not private.can_read_work_detail_category(p_engagement.project_id, 'Passport') then
    raise exception using errcode = '42501', message = 'hospitality.fulfillment.read is required on the engagement''s project';
  end if;
  if not private.has_capability(p_engagement.org_id, 'data.restricted.read.government_id') then
    raise exception using errcode = '42501', message = 'data.restricted.read.government_id is required';
  end if;
  select * into v_share from app.work_detail_shares s
  where p_roster_entry_id is not null and s.roster_entry_id = p_roster_entry_id and s.engagement_id = p_engagement.id
    and s.revoked_at is null and s.deleted_at is null;
  if v_share.id is null or not ('Passport' = any (v_share.categories))
     or not private.engagement_shares_work_details(p_engagement.engagement_state) then
    perform private.refuse('work_detail_not_shared', 'The person has not shared their passport details with this engagement.');
  end if;
  if private.session_aal() <> 'aal2' then
    perform private.refuse('step_up_required', 'Verify with your second factor before revealing a passport number.');
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 10 then
    perform private.refuse('passport_reveal_reason', 'Write why you need the passport number, in at least 10 characters.');
  end if;
  select w.passport_number into v_cipher from app.person_work_details w where w.person_id = v_share.person_id and w.deleted_at is null;
  if v_cipher is null then
    perform private.refuse('passport_number_missing', 'No passport number is recorded.');
  end if;
  perform private.log_work_detail_event(v_share.person_id, 'passport.revealed', v_share.org_id, v_share.engagement_id,
    array['Passport']::app.work_detail_category[], '{}', left(btrim(p_reason), 500), v_share.roster_entry_id);
  perform private.write_audit_event(v_share.org_id, 'work_details.passport_revealed', 'app.work_detail_shares', v_share.id,
    jsonb_build_object('reason', left(btrim(p_reason), 500)));
  return extensions.pgp_sym_decrypt(v_cipher, private.passport_number_key());
end;
$$;

comment on function private.reveal_entry_passport_number(app.engagements, uuid, text) is 'The reveal of the passport number shared on a roster entry to a member of the producing org: hospitality.fulfillment.read on the project, data.restricted.read.government_id in the org, a live share naming Passport on an open engagement, step-up (aal2) and a reason of at least 10 characters. Logged with the reason and the entry, never the value.';
revoke all on function private.reveal_entry_passport_number(app.engagements, uuid, text) from public, anon, authenticated;

create or replace function app.reveal_shared_passport_number(p_engagement_id uuid, p_reason text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
begin
  perform private.require_person();
  select * into v_engagement from app.engagements e where e.id = p_engagement_id and e.deleted_at is null;
  return private.reveal_entry_passport_number(v_engagement,
    (select r.id from app.engagement_roster_entries r where r.engagement_id = v_engagement.id and r.is_self and r.deleted_at is null),
    p_reason);
end;
$$;

comment on function app.reveal_shared_passport_number(uuid, text) is 'The explicit reveal of the engaged person''s shared passport number, found by their self roster entry (R4), to a member of the engaging org: needs a live share naming Passport on an open engagement, hospitality.fulfillment.read on the project, data.restricted.read.government_id in the org, step-up authentication (aal2) and a written reason. Logged with the reason, never the value, in the person''s access log and the org''s audit ledger.';

create or replace function app.reveal_roster_passport_number(p_roster_entry_id uuid, p_reason text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
begin
  perform private.require_person();
  select e.* into v_engagement from app.engagement_roster_entries r join app.engagements e on e.id = r.engagement_id and e.deleted_at is null
  where r.id = p_roster_entry_id and r.deleted_at is null;
  return private.reveal_entry_passport_number(v_engagement, p_roster_entry_id, p_reason);
end;
$$;

comment on function app.reveal_roster_passport_number(uuid, text) is 'The explicit reveal of the passport number a person shared on a roster entry, to producing-org readers only (R4): the rules and logging of app.reveal_shared_passport_number.';

-- Privileges ----------------------------------------------------------------------------------------------------------------

revoke all on function app.share_work_details(uuid, app.work_detail_category[], text) from public, anon;
revoke all on function app.my_work_detail_sharing() from public, anon;
revoke all on function app.roster_shared_work_details(uuid) from public, anon;
revoke all on function app.shared_work_details(uuid) from public, anon;
revoke all on function app.reveal_shared_passport_number(uuid, text) from public, anon;
revoke all on function app.reveal_roster_passport_number(uuid, text) from public, anon;
grant execute on function app.share_work_details(uuid, app.work_detail_category[], text) to authenticated, service_role;
grant execute on function app.my_work_detail_sharing() to authenticated, service_role;
grant execute on function app.roster_shared_work_details(uuid) to authenticated, service_role;
grant execute on function app.shared_work_details(uuid) to authenticated, service_role;
grant execute on function app.reveal_shared_passport_number(uuid, text) to authenticated, service_role;
grant execute on function app.reveal_roster_passport_number(uuid, text) to authenticated, service_role;

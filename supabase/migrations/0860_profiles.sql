-- 0860_profiles.sql
-- A30 Identity, Profiles and Settings. Profiles, handles, verification and certification carry-over
-- (Section 4.8.2, Section 4.8.3, ADR 0019 open item):
--   * person profiles owned by the person: headline, city, skills by category URID, certifications, portfolio
--     and EPK, rates, languages, references and links, with a profile visibility (Public, Network, Private)
--     and per-section visibility that can only be lower
--   * organization profiles: about, logo, cover, capabilities by URID, service regions, case studies with
--     client consent, team members who opt in, and contact options
--   * handles for /u/{handle} and /c/{handle}: unique, changeable once every 30 days, with redirects from the
--     old handle for 90 days
--   * organization verification (business identity through Stripe Identity or a registry check), written
--     only by the platform; the verified flag the Gateway marketplace reads (private.organization_verified)
--   * certification carry-over across orgs with consent: a person keeps certifications on their profile,
--     shares one with an org under a consent record, and that org records its own holder row from it
--   * api_public projections for public profiles: each field appears only at the visibility the owner chose
--
-- Person-owned tables carry no org_id: only the person reads and writes them directly; everyone else reads
-- through the api_public definer functions, which apply visibility. ADR 0016 item 14: policy helpers take
-- column values and never re-read the table their policy protects.

-- Enums -----------------------------------------------------------------------------------------------------

create type app.profile_visibility as enum ('Private', 'Network', 'Public');
comment on type app.profile_visibility is 'Who sees a profile or one of its sections (Section 4.8.3), narrowest first: Private (the owner, and orgs the owner shared it with), Network (people and orgs sharing a membership or engagement), Public (everyone in the marketplace).';

create type app.profile_section as enum (
  'photo', 'pronouns', 'headline', 'bio', 'location', 'skills', 'certifications', 'portfolio', 'rates',
  'availability', 'languages', 'references', 'links', 'organizations'
);
comment on type app.profile_section is 'Sections of a person profile whose visibility the owner sets separately (Section 4.8.3), never above the profile visibility.';

create type app.rate_unit as enum ('Hour', 'Day', 'Week', 'Project');
comment on type app.rate_unit is 'Unit of a person''s published rate.';

create type app.language_proficiency as enum ('Basic', 'Conversational', 'Fluent', 'Native');
comment on type app.language_proficiency is 'How well a person speaks a language.';

create type app.portfolio_kind as enum ('Image', 'Video', 'Audio', 'Document', 'Link');
comment on type app.portfolio_kind is 'Kind of a portfolio or EPK item.';

create type app.handle_kind as enum ('Person', 'Organization');
comment on type app.handle_kind is 'Which profile namespace a handle belongs to: /u/{handle} for people, /c/{handle} for organizations.';

create type app.organization_verification_method as enum ('Stripe Identity', 'Business Registry');
comment on type app.organization_verification_method is 'How the platform verified an organization''s business identity (Section 4.8.3).';

-- Visibility helpers -------------------------------------------------------------------------------------------

create or replace function private.visibility_rank(p_visibility app.profile_visibility)
returns smallint
language sql
immutable
set search_path = ''
as $$
  select case p_visibility when 'Private' then 0 when 'Network' then 1 else 2 end::smallint;
$$;

comment on function private.visibility_rank(app.profile_visibility) is 'Private 0, Network 1, Public 2.';
revoke all on function private.visibility_rank(app.profile_visibility) from public, anon;
grant execute on function private.visibility_rank(app.profile_visibility) to authenticated, service_role;

create or replace function private.in_network(p_viewer_id uuid, p_owner_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with viewer_orgs as (
    select m.org_id from app.memberships m where m.person_id = p_viewer_id and m.deleted_at is null
    union select a.org_id from app.account_memberships a where a.person_id = p_viewer_id and a.deleted_at is null
    union select e.org_id from app.engagements e where e.person_id = p_viewer_id and e.deleted_at is null
  ),
  owner_orgs as (
    select m.org_id from app.memberships m where m.person_id = p_owner_id and m.deleted_at is null
    union select a.org_id from app.account_memberships a where a.person_id = p_owner_id and a.deleted_at is null
    union select e.org_id from app.engagements e where e.person_id = p_owner_id and e.deleted_at is null
  )
  select p_viewer_id is not null and p_owner_id is not null
    and exists (select 1 from viewer_orgs v join owner_orgs o on o.org_id = v.org_id);
$$;

comment on function private.in_network(uuid, uuid) is 'True when two people share an organization through a membership, an account membership or an engagement, now or in the past (Section 4.8.3 Network): past collaborators stay in each other''s network.';
revoke all on function private.in_network(uuid, uuid) from public, anon, authenticated;

create or replace function private.org_in_network(p_viewer_id uuid, p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_viewer_id is not null and (
    exists (select 1 from app.memberships m where m.person_id = p_viewer_id and m.org_id = p_org_id and m.deleted_at is null)
    or exists (select 1 from app.account_memberships a where a.person_id = p_viewer_id and a.org_id = p_org_id and a.deleted_at is null)
    or exists (select 1 from app.engagements e where e.person_id = p_viewer_id and e.org_id = p_org_id and e.deleted_at is null)
    or exists (
      select 1 from app.counterparties c
      where c.deleted_at is null
        and ((c.org_id = p_org_id and c.organization_id in (
              select m.org_id from app.memberships m where m.person_id = p_viewer_id and m.deleted_at is null
              union select a.org_id from app.account_memberships a where a.person_id = p_viewer_id and a.deleted_at is null))
          or (c.organization_id = p_org_id and c.org_id in (
              select m.org_id from app.memberships m where m.person_id = p_viewer_id and m.deleted_at is null))))
  );
$$;

comment on function private.org_in_network(uuid, uuid) is 'True when a person shares a membership, account membership or engagement with an organization, or belongs to an org that holds it as a counterparty or is held by it as one (Section 4.8.3 Network).';
revoke all on function private.org_in_network(uuid, uuid) from public, anon, authenticated;

-- Person-owned table installer ----------------------------------------------------------------------------------

create or replace procedure private.install_person_table(p_table regclass)
language plpgsql
set search_path = ''
as $$
declare
  v_name text := (select c.relname from pg_catalog.pg_class c where c.oid = p_table);
begin
  execute format('alter table %s add column if not exists created_at timestamptz not null default now()', p_table);
  execute format('alter table %s add column if not exists created_by uuid references app.people (id)', p_table);
  execute format('alter table %s add column if not exists updated_at timestamptz not null default now()', p_table);
  execute format('alter table %s add column if not exists updated_by uuid references app.people (id)', p_table);
  execute format('alter table %s add column if not exists deleted_at timestamptz', p_table);
  execute format('comment on column %s.created_at is %L', p_table, 'When the row was created.');
  execute format('comment on column %s.created_by is %L', p_table, 'Person who created the row.');
  execute format('comment on column %s.updated_at is %L', p_table, 'When the row last changed.');
  execute format('comment on column %s.updated_by is %L', p_table, 'Person who last changed the row.');
  execute format('comment on column %s.deleted_at is %L', p_table, 'When the owner removed the row.');
  execute format('create index if not exists %I on %s (person_id)', v_name || '_person_id_idx', p_table);
  call private.install_audit_columns(p_table);
  execute format('alter table %s enable row level security', p_table);
  execute format('revoke all on %s from public, anon, authenticated', p_table);
  execute format('grant select, insert, update on %s to authenticated', p_table);
  execute format('grant all on %s to service_role', p_table);
  execute format('drop policy if exists %I on %s', v_name || '_owner_read', p_table);
  execute format('create policy %I on %s for select to authenticated using (person_id = (select private.current_person_id()))',
    v_name || '_owner_read', p_table);
  execute format('drop policy if exists %I on %s', v_name || '_owner_insert', p_table);
  execute format('create policy %I on %s for insert to authenticated with check (person_id = (select private.current_person_id()))',
    v_name || '_owner_insert', p_table);
  execute format('drop policy if exists %I on %s', v_name || '_owner_update', p_table);
  execute format('create policy %I on %s for update to authenticated using (person_id = (select private.current_person_id())) with check (person_id = (select private.current_person_id()))',
    v_name || '_owner_update', p_table);
  execute format('create or replace trigger t20_person_immutable before update on %s for each row execute function private.refuse_person_change()', p_table);
end;
$$;

create or replace function private.refuse_person_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.person_id <> old.person_id then
    perform private.refuse('owner_immutable', 'A person-owned row never moves to another person.');
  end if;
  return new;
end;
$$;

comment on function private.refuse_person_change() is 'Before update: a person-owned row keeps its owner.';
revoke all on function private.refuse_person_change() from public, anon, authenticated;
comment on procedure private.install_person_table(regclass) is 'Makes a table person-owned: audit and soft delete columns, a person_id index, owner-only read and write policies, privileges (no hard delete for authenticated) and the no-owner-change trigger.';

-- Handles -----------------------------------------------------------------------------------------------------

create table private.handle_redirects (
  id uuid primary key default private.uuid_v7(),
  handle_kind app.handle_kind not null,
  handle text not null,
  subject_id uuid not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create unique index handle_redirects_live_key on private.handle_redirects (handle_kind, handle, expires_at);
create index handle_redirects_lookup_idx on private.handle_redirects (handle_kind, handle);
create index handle_redirects_subject_idx on private.handle_redirects (subject_id);

comment on table private.handle_redirects is 'Old handles kept for 90 days after a change (Section 4.8.3): /u/{old} and /c/{old} redirect to the current handle, and nobody else can take the old handle until the redirect expires. Written only by the handle guard, which removes an expired redirect when its handle is claimed again.';
comment on column private.handle_redirects.id is 'Primary key, UUID v7.';
comment on column private.handle_redirects.handle_kind is 'Person or Organization namespace.';
comment on column private.handle_redirects.handle is 'The old handle.';
comment on column private.handle_redirects.subject_id is 'Person id or organization id the old handle pointed to.';
comment on column private.handle_redirects.expires_at is 'When the redirect ends and the handle becomes free.';
comment on column private.handle_redirects.created_at is 'When the handle changed.';

alter table private.handle_redirects enable row level security;
revoke all on private.handle_redirects from public, anon, authenticated;
grant select on private.handle_redirects to service_role;

create or replace function private.assert_handle_available(p_kind app.handle_kind, p_handle text, p_subject_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_handle !~ '^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])$' or p_handle ~ '--' then
    perform private.refuse('handle_format', 'A handle has 3 to 40 lowercase letters, digits and single hyphens, starting and ending with a letter or digit.');
  end if;
  if exists (select 1 from private.reserved_org_slugs r where r.slug = p_handle) then
    perform private.refuse('handle_reserved', format('%s is reserved by the platform.', p_handle));
  end if;
  if exists (
    select 1 from private.handle_redirects r
    where r.handle_kind = p_kind and r.handle = p_handle and r.expires_at > now() and r.subject_id <> p_subject_id) then
    perform private.refuse('handle_taken', format('%s is held by a recent handle change.', p_handle));
  end if;
end;
$$;

comment on function private.assert_handle_available(app.handle_kind, text, uuid) is 'Refuses a handle with the wrong format, a reserved word, or one another profile gave up less than 90 days ago.';
revoke all on function private.assert_handle_available(app.handle_kind, text, uuid) from public, anon, authenticated;

create or replace function private.guard_handle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind app.handle_kind := tg_argv[0]::app.handle_kind;
  v_subject uuid := case when v_kind = 'Person' then (to_jsonb(new) ->> 'person_id')::uuid else (to_jsonb(new) ->> 'org_id')::uuid end;
begin
  -- Expired redirects free their handle; they are removed as soon as the handle is claimed again.
  delete from private.handle_redirects r where r.handle_kind = v_kind and r.handle = new.handle and r.expires_at <= now();
  if tg_op = 'INSERT' then
    perform private.assert_handle_available(v_kind, new.handle, v_subject);
    new.handle_changed_at := null;
    return new;
  end if;
  if new.handle is distinct from old.handle then
    if old.handle_changed_at is not null and old.handle_changed_at > now() - interval '30 days' then
      perform private.refuse('handle_change_too_soon', 'A handle can change once every 30 days.');
    end if;
    perform private.assert_handle_available(v_kind, new.handle, v_subject);
    delete from private.handle_redirects r where r.handle_kind = v_kind and r.handle = new.handle and r.subject_id = v_subject;
    insert into private.handle_redirects (handle_kind, handle, subject_id, expires_at)
    values (v_kind, old.handle, v_subject, now() + interval '90 days');
    new.handle_changed_at := now();
  elsif new.handle_changed_at is distinct from old.handle_changed_at then
    perform private.refuse('handle_change_too_soon', 'The handle change time is kept by the platform.');
  end if;
  return new;
end;
$$;

comment on function private.guard_handle() is 'Handles (Section 4.8.3): format, reserved words and recent redirects are refused; a change is allowed once every 30 days and leaves a 90-day redirect from the old handle. Argument: Person or Organization.';
revoke all on function private.guard_handle() from public, anon, authenticated;

-- Person profiles ------------------------------------------------------------------------------------------------

create table app.person_profiles (
  id uuid primary key default private.uuid_v7(),
  deleted_at timestamptz,
  person_id uuid not null references app.people (id),
  handle text not null,
  handle_changed_at timestamptz,
  preferred_name text,
  pronouns text,
  headline text,
  bio text,
  city text,
  country_code char(2),
  photo_path text,
  visibility app.profile_visibility not null default 'Private',
  search_indexing boolean not null default false,
  marketplace_discoverable boolean not null default false,
  rate_minor bigint,
  rate_currency char(3) references private.currencies (currency_code),
  rate_unit app.rate_unit,
  constraint person_profiles_preferred_name check (preferred_name is null or char_length(btrim(preferred_name)) between 1 and 100),
  constraint person_profiles_pronouns check (pronouns is null or char_length(btrim(pronouns)) between 1 and 40),
  constraint person_profiles_headline check (headline is null or char_length(btrim(headline)) between 1 and 120),
  constraint person_profiles_bio check (bio is null or char_length(btrim(bio)) between 1 and 2000),
  constraint person_profiles_city check (city is null or char_length(btrim(city)) between 1 and 100),
  constraint person_profiles_country check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  constraint person_profiles_photo check (photo_path is null or photo_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9._-]{1,120}$'),
  constraint person_profiles_rate check (
    (rate_minor is null and rate_currency is null and rate_unit is null)
    or (rate_minor >= 0 and rate_currency is not null and rate_unit is not null)),
  constraint person_profiles_indexing_public check (not search_indexing or visibility = 'Public')
);

create unique index person_profiles_person_key on app.person_profiles (person_id) where deleted_at is null;
create unique index person_profiles_handle_key on app.person_profiles (handle);
create index person_profiles_rate_currency_idx on app.person_profiles (rate_currency);

call private.install_person_table('app.person_profiles');
call private.describe('app.person_profiles', 'A person''s profile (Section 4.8.2), owned by the person and shown in Gateway, linked from Atlas and compact in Compass. New profiles start Private (Section 4.8.3). The name is app.people.full_name and is never restated here.', array[
  'id', 'Primary key, UUID v7.',
  'person_id', 'Owner.',
  'handle', 'Unique handle for /u/{handle}; changes at most once every 30 days and redirects from the old handle for 90 days.',
  'handle_changed_at', 'When the handle last changed; NULL until the first change. Set by the database.',
  'preferred_name', 'Name the person prefers to be called, shown with the full name.',
  'pronouns', 'Optional pronouns.',
  'headline', 'One line about the person''s work.',
  'bio', 'A few paragraphs about the person.',
  'city', 'City, the finest location a profile shows.',
  'country_code', 'ISO 3166-1 alpha-2 country of the city.',
  'photo_path', 'Profile photo: object path in the profile-media bucket, starting with the person id.',
  'visibility', 'Who sees the profile: Private, Network or Public.',
  'search_indexing', 'True lets search engines index a Public profile; otherwise it carries noindex.',
  'marketplace_discoverable', 'True lists the profile in Gateway marketplace search.',
  'rate_minor', 'Optional published rate in minor units of rate_currency; NULL means no rate shown, never zero.',
  'rate_currency', 'Currency of the published rate.',
  'rate_unit', 'Unit the published rate is per.'
]);

create trigger t30_guard_handle before insert or update on app.person_profiles
  for each row execute function private.guard_handle('Person');

create table app.profile_section_visibility (
  id uuid primary key default private.uuid_v7(),
  deleted_at timestamptz,
  person_id uuid not null references app.people (id),
  section app.profile_section not null,
  visibility app.profile_visibility not null
);

create unique index profile_section_visibility_key on app.profile_section_visibility (person_id, section) where deleted_at is null;

call private.install_person_table('app.profile_section_visibility');
call private.describe('app.profile_section_visibility', 'Visibility the owner set for one section of their profile (Section 4.8.3). The effective visibility is the narrower of this and the profile visibility, so a section is never shown more widely than the profile. A section without a row follows the profile.', array[
  'id', 'Primary key, UUID v7.', 'person_id', 'Owner.', 'section', 'Profile section.', 'visibility', 'Visibility chosen for the section.'
]);

create or replace function private.section_visible_to_me(
  p_person_id uuid,
  p_profile_visibility app.profile_visibility,
  p_section app.profile_section
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.current_person_id();
  v_section app.profile_visibility;
  v_rank smallint;
begin
  if v_me is not null and v_me = p_person_id then
    return true;
  end if;
  select s.visibility into v_section from app.profile_section_visibility s
  where s.person_id = p_person_id and s.section = p_section and s.deleted_at is null;
  v_rank := least(private.visibility_rank(p_profile_visibility), private.visibility_rank(coalesce(v_section, p_profile_visibility)));
  return v_rank = 2 or (v_rank = 1 and private.in_network(v_me, p_person_id));
end;
$$;

comment on function private.section_visible_to_me(uuid, app.profile_visibility, app.profile_section) is 'True when the signed-in person (or anon) may see a profile section: the owner always; Public sections everyone; Network sections people in the owner''s network. Takes the profile visibility as an argument (ADR 0016 item 14).';
revoke all on function private.section_visible_to_me(uuid, app.profile_visibility, app.profile_section) from public, anon, authenticated;

create table app.person_skills (
  id uuid primary key default private.uuid_v7(),
  deleted_at timestamptz,
  person_id uuid not null references app.people (id),
  cat_urid text not null references xpms.dim_category (cat_urid),
  sort_order smallint not null default 0
);

create unique index person_skills_key on app.person_skills (person_id, cat_urid) where deleted_at is null;
create index person_skills_cat_urid_idx on app.person_skills (cat_urid);

call private.install_person_table('app.person_skills');
call private.describe('app.person_skills', 'Skills a person lists, each a canon category URID (Section 4.8.2), in the owner''s order.', array[
  'id', 'Primary key, UUID v7.', 'person_id', 'Owner.', 'cat_urid', 'Canon category URID of the skill.', 'sort_order', 'Display order.'
]);

create table app.person_languages (
  id uuid primary key default private.uuid_v7(),
  deleted_at timestamptz,
  person_id uuid not null references app.people (id),
  language_tag text not null,
  proficiency app.language_proficiency not null,
  constraint person_languages_tag check (language_tag ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$')
);

create unique index person_languages_key on app.person_languages (person_id, language_tag) where deleted_at is null;

call private.install_person_table('app.person_languages');
call private.describe('app.person_languages', 'Languages a person speaks and how well.', array[
  'id', 'Primary key, UUID v7.', 'person_id', 'Owner.', 'language_tag', 'BCP 47 language tag, for example es or pt-BR.', 'proficiency', 'Proficiency.'
]);

create table app.person_links (
  id uuid primary key default private.uuid_v7(),
  deleted_at timestamptz,
  person_id uuid not null references app.people (id),
  label text not null,
  url text not null,
  sort_order smallint not null default 0,
  constraint person_links_label check (char_length(btrim(label)) between 1 and 60),
  constraint person_links_url check (url ~ '^https://[^\s]{3,}$' and char_length(url) <= 2000)
);

call private.install_person_table('app.person_links');
call private.describe('app.person_links', 'Links a person shows on their profile, such as a website or social profile.', array[
  'id', 'Primary key, UUID v7.', 'person_id', 'Owner.', 'label', 'Link text.', 'url', 'HTTPS address.', 'sort_order', 'Display order.'
]);

create table app.portfolio_items (
  id uuid primary key default private.uuid_v7(),
  deleted_at timestamptz,
  person_id uuid not null references app.people (id),
  portfolio_kind app.portfolio_kind not null,
  title text not null,
  description text,
  url text,
  media_path text,
  is_epk boolean not null default false,
  sort_order smallint not null default 0,
  constraint portfolio_items_title check (char_length(btrim(title)) between 1 and 120),
  constraint portfolio_items_description check (description is null or char_length(btrim(description)) between 1 and 1000),
  constraint portfolio_items_source check (num_nonnulls(url, media_path) = 1),
  constraint portfolio_items_url check (url is null or (url ~ '^https://[^\s]{3,}$' and char_length(url) <= 2000)),
  constraint portfolio_items_media check (media_path is null or media_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9._-]{1,120}$'),
  constraint portfolio_items_link_is_url check (portfolio_kind <> 'Link' or url is not null)
);

call private.install_person_table('app.portfolio_items');
call private.describe('app.portfolio_items', 'Portfolio and EPK items (Section 4.8.2): media the person uploaded or links to their work. EPK items form an artist''s electronic press kit.', array[
  'id', 'Primary key, UUID v7.', 'person_id', 'Owner.', 'portfolio_kind', 'Image, Video, Audio, Document or Link.',
  'title', 'Item title.', 'description', 'Short description.', 'url', 'HTTPS address of linked work; NULL for uploaded media.',
  'media_path', 'Uploaded media: object path in the profile-media bucket; NULL for a link.',
  'is_epk', 'True when the item belongs to the electronic press kit.', 'sort_order', 'Display order.'
]);

create table app.person_references (
  id uuid primary key default private.uuid_v7(),
  deleted_at timestamptz,
  person_id uuid not null references app.people (id),
  referee_name text not null,
  relationship text not null,
  organization_name text,
  contact_email text,
  statement text,
  constraint person_references_name check (char_length(btrim(referee_name)) between 1 and 120),
  constraint person_references_relationship check (char_length(btrim(relationship)) between 1 and 120),
  constraint person_references_org check (organization_name is null or char_length(btrim(organization_name)) between 1 and 200),
  constraint person_references_email check (contact_email is null or (contact_email = lower(contact_email) and contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  constraint person_references_statement check (statement is null or char_length(btrim(statement)) between 1 and 1000)
);

call private.install_person_table('app.person_references');
call private.describe('app.person_references', 'References a person lists. The referee''s contact email is Confidential: only the owner reads it, and profiles show the name, relationship, organization and statement.', array[
  'id', 'Primary key, UUID v7.', 'person_id', 'Owner.', 'referee_name', 'Referee name.', 'relationship', 'How the referee knows the person.',
  'organization_name', 'Referee''s organization.', 'contact_email', 'Referee contact address; Confidential, never projected.', 'statement', 'What the referee says.'
]);

-- Person certifications and carry-over ------------------------------------------------------------------------------

create table app.person_certifications (
  id uuid primary key default private.uuid_v7(),
  deleted_at timestamptz,
  person_id uuid not null references app.people (id),
  name text not null,
  issuing_body text not null,
  credential_number text,
  issued_on date not null,
  expires_on date,
  evidence_path text,
  source_certification_holder_id uuid references app.certification_holders (id),
  verified_by_org_id uuid references app.organizations (id),
  verified_at timestamptz,
  constraint person_certifications_name check (char_length(btrim(name)) between 1 and 200),
  constraint person_certifications_issuer check (char_length(btrim(issuing_body)) between 1 and 200),
  constraint person_certifications_number check (credential_number is null or char_length(btrim(credential_number)) between 1 and 100),
  constraint person_certifications_validity check (expires_on is null or expires_on >= issued_on),
  constraint person_certifications_evidence check (evidence_path is null or evidence_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9._-]{1,120}$'),
  constraint person_certifications_verified_pair check ((verified_at is null) = (verified_by_org_id is null))
);

create index person_certifications_source_idx on app.person_certifications (source_certification_holder_id);
create index person_certifications_verified_by_org_idx on app.person_certifications (verified_by_org_id);

call private.install_person_table('app.person_certifications');
call private.describe('app.person_certifications', 'Certifications on a person''s profile, kept by the person across orgs (Section 4.8.2, ADR 0019 carry-over). One carried from an org''s verified holder record shows that org''s verification badge; a self-entered one shows unverified until an org verifies it.', array[
  'id', 'Primary key, UUID v7.', 'person_id', 'Owner.', 'name', 'Certification name.', 'issuing_body', 'Body that issued it.',
  'credential_number', 'Credential number on the certificate; Confidential, projected only to orgs it is shared with.',
  'issued_on', 'Day issued.', 'expires_on', 'Day it expires.', 'evidence_path', 'Certificate scan: object path in the profile-media bucket.',
  'source_certification_holder_id', 'The org holder record this certification was carried from; NULL when self-entered.',
  'verified_by_org_id', 'Org whose verified holder record backs the badge. Set by the database.',
  'verified_at', 'When that org verified it. Set by the database.'
]);

create or replace function private.guard_person_certification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_holder app.certification_holders;
begin
  if private.in_trusted_operation('certification_carry') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.source_certification_holder_id := null;
    new.verified_by_org_id := null;
    new.verified_at := null;
  elsif new.source_certification_holder_id is distinct from old.source_certification_holder_id
     or new.verified_by_org_id is distinct from old.verified_by_org_id
     or new.verified_at is distinct from old.verified_at then
    perform private.refuse('certification_verification_platform', 'Verification comes only from an org''s verified record.');
  elsif old.verified_at is not null and (new.name <> old.name or new.issuing_body <> old.issuing_body
     or new.issued_on <> old.issued_on or new.expires_on is distinct from old.expires_on) then
    perform private.refuse('certification_verified_immutable', 'A verified certification keeps the facts the org verified; add a new one instead.');
  end if;
  return new;
end;
$$;

comment on function private.guard_person_certification() is 'Person certifications: the owner never sets verification; a verified certification keeps its verified facts.';
revoke all on function private.guard_person_certification() from public, anon, authenticated;

create trigger t40_guard_person_certification before insert or update on app.person_certifications
  for each row execute function private.guard_person_certification();

create table app.certification_shares (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  person_certification_id uuid not null references app.person_certifications (id),
  consent_record_id uuid not null references app.consent_records (id),
  shared_at timestamptz not null default now(),
  revoked_at timestamptz,
  accepted_holder_id uuid references app.certification_holders (id),
  deleted_at timestamptz,
  constraint certification_shares_revoked_after check (revoked_at is null or revoked_at >= shared_at)
);

create index certification_shares_person_certification_idx on app.certification_shares (person_certification_id);
create index certification_shares_consent_record_idx on app.certification_shares (consent_record_id);
create index certification_shares_accepted_holder_idx on app.certification_shares (accepted_holder_id);
create unique index certification_shares_live_key on app.certification_shares (org_id, person_certification_id)
  where revoked_at is null and deleted_at is null;

call private.install_domain_table('app.certification_shares', null, null, array['app.consent_records', 'consent_record_id']);
call private.describe('app.certification_shares', 'A person sharing one profile certification with an org, under a profile_sharing consent record (ADR 0019 carry-over). The org may record its own holder row from it; revoking stops further use and the org keeps only what it recorded.', array[
  'org_id', 'Org the certification is shared with.',
  'person_certification_id', 'Certification shared.',
  'consent_record_id', 'Consent the person gave for the share.',
  'shared_at', 'When it was shared.',
  'revoked_at', 'When the person revoked the share.',
  'accepted_holder_id', 'Holder record the org created from the share; NULL until the org records it.'
]);

create or replace function private.my_person_certification_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.id from app.person_certifications c where c.person_id = private.current_person_id() and c.deleted_at is null;
$$;

comment on function private.my_person_certification_ids() is 'Profile certifications of the signed-in person. Reads app.person_certifications, never the share table its caller protects.';
revoke all on function private.my_person_certification_ids() from public, anon;
grant execute on function private.my_person_certification_ids() to authenticated, service_role;

call private.install_policies('app.certification_shares',
  $$person_certification_id in (select private.my_person_certification_ids())
    or org_id in (select private.orgs_with_capability('people.certification.read'))$$);
revoke insert, update on app.certification_shares from authenticated;

-- Org readers of a shared certification see it through this definer view while the share stands.
create view app.shared_certifications as
select s.id as certification_share_id, s.org_id, c.person_id, c.name, c.issuing_body, c.credential_number, c.issued_on,
  c.expires_on, c.verified_by_org_id, c.verified_at, s.shared_at, s.accepted_holder_id
from app.certification_shares s
join app.person_certifications c on c.id = s.person_certification_id and c.deleted_at is null
where s.revoked_at is null and s.deleted_at is null
  and (s.org_id in (select private.orgs_with_capability('people.certification.read'))
    or c.person_id = private.current_person_id());

call private.describe('app.shared_certifications', 'Profile certifications people shared with an org, readable by its members holding people.certification.read while the share stands.', array[
  'certification_share_id', 'Share.', 'org_id', 'Org shared with.', 'person_id', 'Holder.', 'name', 'Certification name.',
  'issuing_body', 'Issuer.', 'credential_number', 'Credential number.', 'issued_on', 'Day issued.', 'expires_on', 'Day it expires.',
  'verified_by_org_id', 'Org whose record backs the badge, if any.', 'verified_at', 'When that org verified it.',
  'shared_at', 'When it was shared.', 'accepted_holder_id', 'Holder record the org created from it.'
]);
revoke all on app.shared_certifications from public, anon;
grant select on app.shared_certifications to authenticated, service_role;

create or replace function app.carry_certification_to_profile(p_certification_holder_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_holder app.certification_holders;
  v_cert app.certifications;
  v_id uuid;
begin
  select * into v_holder from app.certification_holders h where h.id = p_certification_holder_id and h.deleted_at is null;
  if v_holder.id is null or v_holder.person_id <> v_me then
    perform private.refuse('certification_not_yours', 'Only the holder carries a certification to their profile.');
  end if;
  select * into v_cert from app.certifications c where c.id = v_holder.certification_id;
  select c.id into v_id from app.person_certifications c
  where c.source_certification_holder_id = v_holder.id and c.deleted_at is null;
  if v_id is not null then
    return v_id;
  end if;
  perform private.begin_trusted_operation('certification_carry');
  insert into app.person_certifications (person_id, name, issuing_body, issued_on, expires_on, source_certification_holder_id,
    verified_by_org_id, verified_at)
  values (v_me, v_cert.name, v_cert.issuing_body, v_holder.issued_on, v_holder.expires_on, v_holder.id,
    case when v_holder.verified_by is not null then v_holder.org_id end,
    case when v_holder.verified_by is not null then v_holder.created_at end)
  returning id into v_id;
  perform private.end_trusted_operation('certification_carry');
  return v_id;
end;
$$;

comment on function app.carry_certification_to_profile(uuid) is 'The holder copies a certification an org recorded for them onto their own profile, keeping that org''s verification badge (ADR 0019 carry-over). Idempotent. Returns the profile certification id.';

create or replace function app.share_certification(p_person_certification_id uuid, p_org_id uuid, p_notice_version text default '1.0.0')
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_consent uuid;
  v_id uuid;
begin
  if not exists (
    select 1 from app.person_certifications c
    where c.id = p_person_certification_id and c.person_id = v_me and c.deleted_at is null) then
    perform private.refuse('certification_not_yours', 'Only the owner shares a profile certification.');
  end if;
  if not exists (select 1 from app.organizations o where o.id = p_org_id and o.deleted_at is null) then
    perform private.refuse('org_unknown', 'The organization does not exist.');
  end if;
  select s.id into v_id from app.certification_shares s
  where s.org_id = p_org_id and s.person_certification_id = p_person_certification_id and s.revoked_at is null and s.deleted_at is null;
  if v_id is not null then
    return v_id;
  end if;
  select r.id into v_consent from app.consent_records r
  where r.org_id = p_org_id and r.person_id = v_me and r.purpose_code = 'profile_sharing'
    and r.withdrawn_at is null and r.deleted_at is null;
  if v_consent is null then
    insert into app.consent_records (org_id, person_id, purpose_code, notice_version, source)
    values (p_org_id, v_me, 'profile_sharing', p_notice_version, 'Web')
    returning id into v_consent;
  end if;
  insert into app.certification_shares (org_id, person_certification_id, consent_record_id)
  values (p_org_id, p_person_certification_id, v_consent)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.share_certification(uuid, uuid, text) is 'The owner shares one profile certification with an org, recording profile_sharing consent for that org when none stands. Idempotent while the share stands. Returns the share id.';

create or replace function app.revoke_certification_share(p_certification_share_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
begin
  update app.certification_shares s set revoked_at = now()
  where s.id = p_certification_share_id and s.revoked_at is null
    and s.person_certification_id in (select c.id from app.person_certifications c where c.person_id = v_me);
  if not found then
    perform private.refuse('certification_not_yours', 'Only the owner revokes a live share.');
  end if;
end;
$$;

comment on function app.revoke_certification_share(uuid) is 'The owner revokes a certification share at once; the org keeps only a holder record it already made.';

create or replace function app.accept_shared_certification(p_certification_share_id uuid, p_certification_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_share app.certification_shares;
  v_cert app.person_certifications;
  v_holder uuid;
begin
  select * into v_share from app.certification_shares s
  where s.id = p_certification_share_id and s.revoked_at is null and s.deleted_at is null;
  if v_share.id is null then
    perform private.refuse('certification_share_closed', 'The share was revoked or does not exist.');
  end if;
  if not private.has_capability(v_share.org_id, 'people.certification.verify') then
    raise exception using errcode = '42501', message = 'people.certification.verify is required';
  end if;
  if not exists (select 1 from app.certifications c where c.id = p_certification_id and c.org_id = v_share.org_id and c.deleted_at is null) then
    perform private.refuse('certification_unknown', 'Choose a certification your org tracks.');
  end if;
  if v_share.accepted_holder_id is not null then
    return v_share.accepted_holder_id;
  end if;
  select * into v_cert from app.person_certifications c where c.id = v_share.person_certification_id;
  insert into app.certification_holders (certification_id, person_id, verified_by, issued_on, expires_on)
  values (p_certification_id, v_cert.person_id, v_me, v_cert.issued_on, v_cert.expires_on)
  returning id into v_holder;
  update app.certification_shares s set accepted_holder_id = v_holder where s.id = v_share.id;
  return v_holder;
end;
$$;

comment on function app.accept_shared_certification(uuid, uuid) is 'An org verifier records its own holder row from a live share (ADR 0019 carry-over): the person''s dates carry over and the verifier is recorded, never the holder. Idempotent. Returns the holder id.';

revoke all on function app.carry_certification_to_profile(uuid) from public, anon;
revoke all on function app.share_certification(uuid, uuid, text) from public, anon;
revoke all on function app.revoke_certification_share(uuid) from public, anon;
revoke all on function app.accept_shared_certification(uuid, uuid) from public, anon;
grant execute on function app.carry_certification_to_profile(uuid) to authenticated, service_role;
grant execute on function app.share_certification(uuid, uuid, text) to authenticated, service_role;
grant execute on function app.revoke_certification_share(uuid) to authenticated, service_role;
grant execute on function app.accept_shared_certification(uuid, uuid) to authenticated, service_role;

-- Organization profiles -------------------------------------------------------------------------------------------

create or replace function private.can_edit_org_profile(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_capability(p_org_id, 'org.profile.write')
    or exists (select 1 from private.account_role(p_org_id) r where r in ('Account Owner', 'Account Admin'));
$$;

comment on function private.can_edit_org_profile(uuid) is 'True when the signed-in person edits the org''s profile: org.profile.write in a tenant org, or Account Owner or Admin of an external account (Section 4.8.3).';
revoke all on function private.can_edit_org_profile(uuid) from public, anon;
grant execute on function private.can_edit_org_profile(uuid) to authenticated, service_role;

create or replace function private.belongs_to_org(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_org_id in (select private.my_org_ids()) or p_org_id in (select private.my_account_ids());
$$;

comment on function private.belongs_to_org(uuid) is 'True when the signed-in person is an active member or account member of the org.';
revoke all on function private.belongs_to_org(uuid) from public, anon;
grant execute on function private.belongs_to_org(uuid) to authenticated, service_role;

create table app.organization_profiles (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  handle text not null,
  handle_changed_at timestamptz,
  about text,
  logo_path text,
  cover_path text,
  website_url text,
  contact_email text,
  visibility app.profile_visibility not null default 'Network',
  search_indexing boolean not null default false,
  deleted_at timestamptz,
  constraint organization_profiles_about check (about is null or char_length(btrim(about)) between 1 and 4000),
  constraint organization_profiles_logo check (logo_path is null or logo_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9._-]{1,120}$'),
  constraint organization_profiles_cover check (cover_path is null or cover_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9._-]{1,120}$'),
  constraint organization_profiles_website check (website_url is null or (website_url ~ '^https://[^\s]{3,}$' and char_length(website_url) <= 2000)),
  constraint organization_profiles_contact check (contact_email is null or (contact_email = lower(contact_email) and contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  constraint organization_profiles_indexing_public check (not search_indexing or visibility = 'Public')
);

create unique index organization_profiles_org_key on app.organization_profiles (org_id) where deleted_at is null;
create unique index organization_profiles_handle_key on app.organization_profiles (handle);

call private.install_domain_table('app.organization_profiles');
call private.describe('app.organization_profiles', 'An organization''s profile (Section 4.8.2), shown in Gateway at /c/{handle}: tenant orgs and external accounts alike, so a vendor that later subscribes keeps it. New org profiles start Network (Section 4.8.3).', array[
  'handle', 'Unique handle for /c/{handle}; changes at most once every 30 days and redirects from the old handle for 90 days.',
  'handle_changed_at', 'When the handle last changed. Set by the database.',
  'about', 'About the organization.',
  'logo_path', 'Profile logo: object path in the profile-media bucket, starting with the org id.',
  'cover_path', 'Cover image: object path in the profile-media bucket.',
  'website_url', 'HTTPS website.',
  'contact_email', 'Contact address shown to viewers who see the profile.',
  'visibility', 'Who sees the profile: Private (members), Network or Public.',
  'search_indexing', 'True lets search engines index a Public profile.'
]);

create trigger t30_guard_handle before insert or update on app.organization_profiles
  for each row execute function private.guard_handle('Organization');

call private.install_policies('app.organization_profiles',
  $$private.belongs_to_org(org_id)$$,
  $$private.can_edit_org_profile(org_id)$$);

create table app.organization_profile_capabilities (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  cat_urid text not null references xpms.dim_category (cat_urid),
  deleted_at timestamptz
);

create unique index organization_profile_capabilities_key on app.organization_profile_capabilities (org_id, cat_urid) where deleted_at is null;
create index organization_profile_capabilities_cat_urid_idx on app.organization_profile_capabilities (cat_urid);

call private.install_domain_table('app.organization_profile_capabilities');
call private.describe('app.organization_profile_capabilities', 'What an organization offers, each a canon category URID (Section 4.8.2).', array['cat_urid', 'Canon category URID.']);
call private.install_policies('app.organization_profile_capabilities',
  $$private.belongs_to_org(org_id)$$, $$private.can_edit_org_profile(org_id)$$);

create table app.organization_service_regions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  jurisdiction_id text not null references xpms.jurisdiction (jurisdiction_id),
  deleted_at timestamptz
);

create unique index organization_service_regions_key on app.organization_service_regions (org_id, jurisdiction_id) where deleted_at is null;
create index organization_service_regions_jurisdiction_idx on app.organization_service_regions (jurisdiction_id);

call private.install_domain_table('app.organization_service_regions');
call private.describe('app.organization_service_regions', 'Regions an organization serves, as canon jurisdictions (Section 4.8.2).', array['jurisdiction_id', 'Canon jurisdiction served.']);
call private.install_policies('app.organization_service_regions',
  $$private.belongs_to_org(org_id)$$, $$private.can_edit_org_profile(org_id)$$);

create table app.organization_case_studies (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  title text not null,
  summary text not null,
  client_organization_id uuid references app.organizations (id),
  client_consented_at timestamptz,
  published boolean not null default false,
  sort_order smallint not null default 0,
  deleted_at timestamptz,
  constraint organization_case_studies_title check (char_length(btrim(title)) between 1 and 120),
  constraint organization_case_studies_summary check (char_length(btrim(summary)) between 1 and 4000),
  constraint organization_case_studies_not_self check (client_organization_id is distinct from org_id),
  constraint organization_case_studies_consent check (client_consented_at is null or client_organization_id is not null),
  constraint organization_case_studies_published_consent check (not published or client_organization_id is null or client_consented_at is not null)
);

create index organization_case_studies_client_idx on app.organization_case_studies (client_organization_id);

call private.install_domain_table('app.organization_case_studies');
call private.describe('app.organization_case_studies', 'Case studies on an organization''s profile (Section 4.8.2). One naming a client publishes only after that client consents, recorded by app.consent_to_case_study.', array[
  'title', 'Title.', 'summary', 'What was done.', 'client_organization_id', 'Client the case study names; NULL when unnamed.',
  'client_consented_at', 'When the client consented. Set only by the client through app.consent_to_case_study.',
  'published', 'True shows it on the profile.', 'sort_order', 'Display order.'
]);

create or replace function private.guard_case_study()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.in_trusted_operation('case_study_consent') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.client_consented_at := null;
  elsif new.client_consented_at is distinct from old.client_consented_at
     or new.client_organization_id is distinct from old.client_organization_id and old.client_consented_at is not null then
    perform private.refuse('case_study_consent_client', 'Only the named client consents, and a consented client cannot be swapped.');
  end if;
  if new.published and new.client_organization_id is not null and new.client_consented_at is null then
    perform private.refuse('case_study_needs_consent', 'A case study naming a client publishes only after the client consents.');
  end if;
  return new;
end;
$$;

comment on function private.guard_case_study() is 'Case studies: client consent is recorded only by the client, and a named case study publishes only after consent.';
revoke all on function private.guard_case_study() from public, anon, authenticated;

create trigger t40_guard_case_study before insert or update on app.organization_case_studies
  for each row execute function private.guard_case_study();

call private.install_policies('app.organization_case_studies',
  $$private.belongs_to_org(org_id) or private.can_edit_org_profile(client_organization_id)$$,
  $$private.can_edit_org_profile(org_id)$$);

create or replace function app.consent_to_case_study(p_case_study_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_client uuid;
begin
  perform private.require_person();
  select c.client_organization_id into v_client from app.organization_case_studies c
  where c.id = p_case_study_id and c.deleted_at is null;
  if v_client is null or not private.can_edit_org_profile(v_client) then
    raise exception using errcode = '42501', message = 'only the named client consents';
  end if;
  perform private.begin_trusted_operation('case_study_consent');
  update app.organization_case_studies set client_consented_at = now() where id = p_case_study_id and client_consented_at is null;
  perform private.end_trusted_operation('case_study_consent');
end;
$$;

comment on function app.consent_to_case_study(uuid) is 'The named client''s profile editor consents to a case study, so its author may publish it.';
revoke all on function app.consent_to_case_study(uuid) from public, anon;
grant execute on function app.consent_to_case_study(uuid) to authenticated, service_role;

create table app.organization_profile_members (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  person_id uuid not null references app.people (id),
  title text,
  sort_order smallint not null default 0,
  deleted_at timestamptz,
  constraint organization_profile_members_title check (title is null or char_length(btrim(title)) between 1 and 100)
);

create unique index organization_profile_members_key on app.organization_profile_members (org_id, person_id) where deleted_at is null;
create index organization_profile_members_person_idx on app.organization_profile_members (person_id);

call private.install_domain_table('app.organization_profile_members');
call private.describe('app.organization_profile_members', 'Team members who opted in to appear on their organization''s profile (Section 4.8.2). Only the person adds themselves; the person or a profile editor removes them.', array[
  'person_id', 'Member who opted in.', 'title', 'Title shown on the profile.', 'sort_order', 'Display order.'
]);

call private.install_policies('app.organization_profile_members',
  $$private.belongs_to_org(org_id) or person_id = (select private.current_person_id())$$,
  $$person_id = (select private.current_person_id()) and private.belongs_to_org(org_id)$$,
  $$person_id = (select private.current_person_id()) or private.can_edit_org_profile(org_id)$$);

-- Organization verification ----------------------------------------------------------------------------------------

create table app.organization_verifications (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  method app.organization_verification_method not null,
  provider_reference text not null,
  verified_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revocation_reason text,
  deleted_at timestamptz,
  constraint organization_verifications_reference check (char_length(btrim(provider_reference)) between 1 and 200),
  constraint organization_verifications_expiry check (expires_at is null or expires_at > verified_at),
  constraint organization_verifications_revocation check ((revoked_at is null) = (revocation_reason is null))
);

create index organization_verifications_org_idx on app.organization_verifications (org_id, verified_at);

call private.install_domain_table('app.organization_verifications');
call private.describe('app.organization_verifications', 'Business identity verifications of an organization (Section 4.8.3), recorded only by the platform after Stripe Identity or a business registry check. The verified badge shows while one is neither expired nor revoked.', array[
  'method', 'Stripe Identity or Business Registry.',
  'provider_reference', 'The provider''s verification or registry record reference.',
  'verified_at', 'When the check passed.',
  'expires_at', 'When the verification lapses; NULL for none.',
  'revoked_at', 'When the platform revoked it.',
  'revocation_reason', 'Why it was revoked.'
]);

call private.install_policies('app.organization_verifications', $$private.belongs_to_org(org_id)$$);
revoke insert, update on app.organization_verifications from authenticated;

create or replace function private.organization_verified(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.organization_verifications v
    where v.org_id = p_org_id and v.deleted_at is null and v.revoked_at is null
      and (v.expires_at is null or v.expires_at > now())
  );
$$;

comment on function private.organization_verified(uuid) is 'The verified flag (Section 4.8.3): true while the org holds a business identity verification that is neither expired nor revoked. The Gateway marketplace reads it.';
revoke all on function private.organization_verified(uuid) from public, anon;
grant execute on function private.organization_verified(uuid) to authenticated, service_role;

create or replace function app.organization_verified(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.organization_verified(p_org_id);
$$;

comment on function app.organization_verified(uuid) is 'Whether an organization''s business identity is verified now. Public information, shown as the verified badge.';
revoke all on function app.organization_verified(uuid) from public, anon;
grant execute on function app.organization_verified(uuid) to authenticated, service_role;

create or replace function app.record_organization_verification(
  p_org_id uuid,
  p_method app.organization_verification_method,
  p_provider_reference text,
  p_expires_at timestamptz default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into app.organization_verifications (org_id, method, provider_reference, expires_at)
  values (p_org_id, p_method, p_provider_reference, p_expires_at)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.record_organization_verification(uuid, app.organization_verification_method, text, timestamptz) is 'Verification service API (service role only): records a passed business identity check. Returns the verification id.';

create or replace function app.revoke_organization_verification(p_verification_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update app.organization_verifications set revoked_at = now(), revocation_reason = btrim(p_reason)
  where id = p_verification_id and revoked_at is null;
  if not found then
    perform private.refuse('verification_unknown', 'The verification does not exist or is already revoked.');
  end if;
end;
$$;

comment on function app.revoke_organization_verification(uuid, text) is 'Verification service API (service role only): revokes a verification with a reason.';
revoke all on function app.record_organization_verification(uuid, app.organization_verification_method, text, timestamptz) from public, anon, authenticated;
revoke all on function app.revoke_organization_verification(uuid, text) from public, anon, authenticated;
grant execute on function app.record_organization_verification(uuid, app.organization_verification_method, text, timestamptz) to service_role;
grant execute on function app.revoke_organization_verification(uuid, text) to service_role;

-- Profile RPCs ---------------------------------------------------------------------------------------------------

create or replace function private.suggest_handle(p_kind app.handle_kind, p_base text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_base text := left(trim(both '-' from regexp_replace(regexp_replace(lower(coalesce(p_base, '')), '[^a-z0-9]+', '-', 'g'), '-{2,}', '-', 'g')), 30);
  v_try text;
  i integer := 0;
begin
  if char_length(v_base) < 3 then
    v_base := case when p_kind = 'Person' then 'member' else 'company' end;
  end if;
  loop
    v_try := case when i = 0 then v_base else v_base || '-' || (1000 + floor(random() * 9000))::integer end;
    exit when not exists (select 1 from private.reserved_org_slugs r where r.slug = v_try)
      and not exists (select 1 from private.handle_redirects r where r.handle_kind = p_kind and r.handle = v_try and r.expires_at > now())
      and not exists (select 1 from app.person_profiles p where p_kind = 'Person' and p.handle = v_try)
      and not exists (select 1 from app.organization_profiles o where p_kind = 'Organization' and o.handle = v_try);
    i := i + 1;
    if i > 50 then
      perform private.refuse('handle_unavailable', 'No free handle was found; choose one yourself.');
    end if;
  end loop;
  return v_try;
end;
$$;

comment on function private.suggest_handle(app.handle_kind, text) is 'A free handle derived from a name: the name in lowercase with hyphens, then with a random four-digit suffix until free.';
revoke all on function private.suggest_handle(app.handle_kind, text) from public, anon, authenticated;

create or replace function app.ensure_my_profile()
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_id uuid;
begin
  select p.id into v_id from app.person_profiles p where p.person_id = v_me and p.deleted_at is null;
  if v_id is null then
    insert into app.person_profiles (person_id, handle)
    values (v_me, private.suggest_handle('Person', (select pe.full_name from app.people pe where pe.id = v_me)))
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

comment on function app.ensure_my_profile() is 'Creates the signed-in person''s profile when it does not exist yet, Private with a handle from their name. Returns the profile id.';

create or replace function app.ensure_organization_profile(p_org_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_person();
  if not private.can_edit_org_profile(p_org_id) then
    raise exception using errcode = '42501', message = 'org.profile.write or Account Owner or Admin is required';
  end if;
  select p.id into v_id from app.organization_profiles p where p.org_id = p_org_id and p.deleted_at is null;
  if v_id is null then
    insert into app.organization_profiles (org_id, handle)
    values (p_org_id, private.suggest_handle('Organization', (select o.slug from app.organizations o where o.id = p_org_id)))
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

comment on function app.ensure_organization_profile(uuid) is 'Creates an organization''s profile when it does not exist yet, Network with its slug as the handle when free. Needs org.profile.write or Account Owner or Admin. Returns the profile id.';

revoke all on function app.ensure_my_profile() from public, anon;
revoke all on function app.ensure_organization_profile(uuid) from public, anon;
grant execute on function app.ensure_my_profile() to authenticated, service_role;
grant execute on function app.ensure_organization_profile(uuid) to authenticated, service_role;

-- Public projections ---------------------------------------------------------------------------------------------

create or replace function private.person_profile_by_handle(p_handle text)
returns app.person_profiles
language sql
stable
security definer
set search_path = ''
as $$
  select p.* from app.person_profiles p
  where p.deleted_at is null and p.handle = coalesce(
    (select pp.handle from app.person_profiles pp where pp.handle = lower(btrim(p_handle)) and pp.deleted_at is null),
    (select cur.handle from private.handle_redirects r
       join app.person_profiles cur on cur.person_id = r.subject_id and cur.deleted_at is null
     where r.handle_kind = 'Person' and r.handle = lower(btrim(p_handle)) and r.expires_at > now()
     order by r.created_at desc limit 1));
$$;

comment on function private.person_profile_by_handle(text) is 'The person profile a handle names now, following a live redirect from an old handle.';
revoke all on function private.person_profile_by_handle(text) from public, anon, authenticated;

create or replace function private.profile_visible_to_me(p_person_id uuid, p_visibility app.profile_visibility)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(private.current_person_id() = p_person_id, false)
    or p_visibility = 'Public'
    or (p_visibility = 'Network' and private.in_network(private.current_person_id(), p_person_id));
$$;

comment on function private.profile_visible_to_me(uuid, app.profile_visibility) is 'True when the signed-in person or anon may see a person profile at all.';
revoke all on function private.profile_visible_to_me(uuid, app.profile_visibility) from public, anon, authenticated;

create or replace function api_public.person_profile(p_handle text)
returns table (
  handle text,
  redirected boolean,
  full_name text,
  preferred_name text,
  pronouns text,
  headline text,
  bio text,
  city text,
  country_code char(2),
  photo_path text,
  rate_minor bigint,
  rate_currency char(3),
  rate_unit app.rate_unit,
  visibility app.profile_visibility,
  indexable boolean,
  viewer_is_owner boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_p app.person_profiles := private.person_profile_by_handle(p_handle);
begin
  if v_p.id is null or not private.profile_visible_to_me(v_p.person_id, v_p.visibility) then
    return;
  end if;
  return query select
    v_p.handle,
    v_p.handle <> lower(btrim(p_handle)),
    (select pe.full_name from app.people pe where pe.id = v_p.person_id),
    v_p.preferred_name,
    case when private.section_visible_to_me(v_p.person_id, v_p.visibility, 'pronouns') then v_p.pronouns end,
    case when private.section_visible_to_me(v_p.person_id, v_p.visibility, 'headline') then v_p.headline end,
    case when private.section_visible_to_me(v_p.person_id, v_p.visibility, 'bio') then v_p.bio end,
    case when private.section_visible_to_me(v_p.person_id, v_p.visibility, 'location') then v_p.city end,
    case when private.section_visible_to_me(v_p.person_id, v_p.visibility, 'location') then v_p.country_code end,
    case when private.section_visible_to_me(v_p.person_id, v_p.visibility, 'photo') then v_p.photo_path end,
    case when private.section_visible_to_me(v_p.person_id, v_p.visibility, 'rates') then v_p.rate_minor end,
    case when private.section_visible_to_me(v_p.person_id, v_p.visibility, 'rates') then v_p.rate_currency end,
    case when private.section_visible_to_me(v_p.person_id, v_p.visibility, 'rates') then v_p.rate_unit end,
    v_p.visibility,
    v_p.visibility = 'Public' and v_p.search_indexing,
    private.current_person_id() is not distinct from v_p.person_id;
end;
$$;

comment on function api_public.person_profile(text) is 'A person''s profile at /u/{handle} (Section 4.8.2), as the viewer may see it: nothing when the profile is hidden from them, and NULL for each section set narrower than the viewer''s access. Follows a redirect from an old handle (redirected is true). indexable is false unless the profile is Public with indexing on.';

create or replace function api_public.person_profile_skills(p_handle text)
returns table (cat_urid text, category text, sort_order smallint)
language sql
stable
security definer
set search_path = ''
as $$
  select s.cat_urid, c.category, s.sort_order
  from private.person_profile_by_handle(p_handle) p
  join app.person_skills s on s.person_id = p.person_id and s.deleted_at is null
  join xpms.dim_category c on c.cat_urid = s.cat_urid
  where p.id is not null and private.profile_visible_to_me(p.person_id, p.visibility)
    and private.section_visible_to_me(p.person_id, p.visibility, 'skills')
  order by s.sort_order, s.cat_urid;
$$;

create or replace function api_public.person_profile_languages(p_handle text)
returns table (language_tag text, proficiency app.language_proficiency)
language sql
stable
security definer
set search_path = ''
as $$
  select l.language_tag, l.proficiency
  from private.person_profile_by_handle(p_handle) p
  join app.person_languages l on l.person_id = p.person_id and l.deleted_at is null
  where p.id is not null and private.profile_visible_to_me(p.person_id, p.visibility)
    and private.section_visible_to_me(p.person_id, p.visibility, 'languages')
  order by l.language_tag;
$$;

create or replace function api_public.person_profile_links(p_handle text)
returns table (label text, url text, sort_order smallint)
language sql
stable
security definer
set search_path = ''
as $$
  select l.label, l.url, l.sort_order
  from private.person_profile_by_handle(p_handle) p
  join app.person_links l on l.person_id = p.person_id and l.deleted_at is null
  where p.id is not null and private.profile_visible_to_me(p.person_id, p.visibility)
    and private.section_visible_to_me(p.person_id, p.visibility, 'links')
  order by l.sort_order, l.label;
$$;

create or replace function api_public.person_profile_portfolio(p_handle text)
returns table (portfolio_kind app.portfolio_kind, title text, description text, url text, media_path text, is_epk boolean, sort_order smallint)
language sql
stable
security definer
set search_path = ''
as $$
  select i.portfolio_kind, i.title, i.description, i.url, i.media_path, i.is_epk, i.sort_order
  from private.person_profile_by_handle(p_handle) p
  join app.portfolio_items i on i.person_id = p.person_id and i.deleted_at is null
  where p.id is not null and private.profile_visible_to_me(p.person_id, p.visibility)
    and private.section_visible_to_me(p.person_id, p.visibility, 'portfolio')
  order by i.sort_order, i.title;
$$;

create or replace function api_public.person_profile_references(p_handle text)
returns table (referee_name text, relationship text, organization_name text, statement text)
language sql
stable
security definer
set search_path = ''
as $$
  select r.referee_name, r.relationship, r.organization_name, r.statement
  from private.person_profile_by_handle(p_handle) p
  join app.person_references r on r.person_id = p.person_id and r.deleted_at is null
  where p.id is not null and private.profile_visible_to_me(p.person_id, p.visibility)
    and private.section_visible_to_me(p.person_id, p.visibility, 'references')
  order by r.referee_name;
$$;

create or replace function api_public.person_profile_certifications(p_handle text)
returns table (name text, issuing_body text, issued_on date, expires_on date, verified boolean, verified_by text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.name, c.issuing_body, c.issued_on, c.expires_on,
    c.verified_at is not null and (c.expires_on is null or c.expires_on >= current_date),
    (select coalesce(op.handle, o.name) from app.organizations o
       left join app.organization_profiles op on op.org_id = o.id and op.deleted_at is null
     where o.id = c.verified_by_org_id)
  from private.person_profile_by_handle(p_handle) p
  join app.person_certifications c on c.person_id = p.person_id and c.deleted_at is null
  where p.id is not null and private.profile_visible_to_me(p.person_id, p.visibility)
    and private.section_visible_to_me(p.person_id, p.visibility, 'certifications')
  order by c.name;
$$;

create or replace function api_public.person_profile_organizations(p_handle text)
returns table (org_handle text, name text)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct op.handle, o.name
  from private.person_profile_by_handle(p_handle) p
  join (
    select m.person_id, m.org_id from app.memberships m where m.deleted_at is null
    union select e.person_id, e.org_id from app.engagements e where e.deleted_at is null and e.engagement_state in ('Active', 'Closing', 'Complete')
  ) w on w.person_id = p.person_id
  join app.organizations o on o.id = w.org_id and o.deleted_at is null
  join app.organization_profiles op on op.org_id = o.id and op.deleted_at is null and op.visibility = 'Public'
  where p.id is not null and private.profile_visible_to_me(p.person_id, p.visibility)
    and private.section_visible_to_me(p.person_id, p.visibility, 'organizations')
  order by o.name;
$$;

comment on function api_public.person_profile_skills(text) is 'Skills on a profile, when the viewer may see the skills section.';
comment on function api_public.person_profile_languages(text) is 'Languages on a profile, when the viewer may see the languages section.';
comment on function api_public.person_profile_links(text) is 'Links on a profile, when the viewer may see the links section.';
comment on function api_public.person_profile_portfolio(text) is 'Portfolio and EPK items on a profile, when the viewer may see the portfolio section.';
comment on function api_public.person_profile_references(text) is 'References on a profile without the referee''s contact address, when the viewer may see the references section.';
comment on function api_public.person_profile_certifications(text) is 'Certifications on a profile with their verification badge (verified while backed by an org''s verified record and not expired), when the viewer may see the certifications section.';
comment on function api_public.person_profile_organizations(text) is 'Organizations a person worked with, each shown only when both sides allow it (Section 4.8.2): the person shows the section and the organization''s profile is Public.';

create or replace function private.organization_profile_by_handle(p_handle text)
returns app.organization_profiles
language sql
stable
security definer
set search_path = ''
as $$
  select p.* from app.organization_profiles p
  where p.deleted_at is null and p.handle = coalesce(
    (select pp.handle from app.organization_profiles pp where pp.handle = lower(btrim(p_handle)) and pp.deleted_at is null),
    (select cur.handle from private.handle_redirects r
       join app.organization_profiles cur on cur.org_id = r.subject_id and cur.deleted_at is null
     where r.handle_kind = 'Organization' and r.handle = lower(btrim(p_handle)) and r.expires_at > now()
     order by r.created_at desc limit 1));
$$;

comment on function private.organization_profile_by_handle(text) is 'The organization profile a handle names now, following a live redirect.';
revoke all on function private.organization_profile_by_handle(text) from public, anon, authenticated;

create or replace function private.org_profile_visible_to_me(p_org_id uuid, p_visibility app.profile_visibility)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_visibility = 'Public'
    or private.belongs_to_org(p_org_id)
    or (p_visibility = 'Network' and private.org_in_network(private.current_person_id(), p_org_id));
$$;

comment on function private.org_profile_visible_to_me(uuid, app.profile_visibility) is 'True when the viewer may see an organization profile: Public to everyone, Network to its network, and always to its own members.';
revoke all on function private.org_profile_visible_to_me(uuid, app.profile_visibility) from public, anon, authenticated;

create or replace function api_public.organization_profile(p_handle text)
returns table (
  handle text,
  redirected boolean,
  name text,
  about text,
  logo_path text,
  cover_path text,
  website_url text,
  contact_email text,
  verified boolean,
  visibility app.profile_visibility,
  indexable boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.handle, p.handle <> lower(btrim(p_handle)), o.name, p.about, p.logo_path, p.cover_path, p.website_url, p.contact_email,
    private.organization_verified(p.org_id), p.visibility, p.visibility = 'Public' and p.search_indexing
  from private.organization_profile_by_handle(p_handle) p
  join app.organizations o on o.id = p.org_id and o.deleted_at is null
  where p.id is not null and private.org_profile_visible_to_me(p.org_id, p.visibility);
$$;

create or replace function api_public.organization_profile_details(p_handle text)
returns table (detail_kind text, code text, label text, sort_order integer)
language sql
stable
security definer
set search_path = ''
as $$
  with p as (
    select * from private.organization_profile_by_handle(p_handle) x
    where x.id is not null and private.org_profile_visible_to_me(x.org_id, x.visibility)
  )
  select 'capability', c.cat_urid, d.category, 0
  from p join app.organization_profile_capabilities c on c.org_id = p.org_id and c.deleted_at is null
  join xpms.dim_category d on d.cat_urid = c.cat_urid
  union all
  select 'service_region', r.jurisdiction_id, r.jurisdiction_id, 0
  from p join app.organization_service_regions r on r.org_id = p.org_id and r.deleted_at is null
  union all
  select 'verified_domain', d.hostname, d.hostname, 0
  from p join app.org_domains d on d.org_id = p.org_id and d.deleted_at is null
    and d.purpose = 'Verified Domain' and d.verification_state = 'Verified'
  union all
  select 'team_member', coalesce(pp.handle, ''), coalesce(pe.full_name, '') || coalesce(' · ' || m.title, ''), m.sort_order
  from p join app.organization_profile_members m on m.org_id = p.org_id and m.deleted_at is null
  join app.people pe on pe.id = m.person_id
  left join app.person_profiles pp on pp.person_id = m.person_id and pp.deleted_at is null and pp.visibility = 'Public'
  union all
  select 'case_study', cs.id::text, cs.title || ': ' || cs.summary, cs.sort_order
  from p join app.organization_case_studies cs on cs.org_id = p.org_id and cs.deleted_at is null and cs.published
  order by 1, 4, 3;
$$;

comment on function api_public.organization_profile(text) is 'An organization''s profile at /c/{handle} (Section 4.8.2) as the viewer may see it, with the verified badge (business identity). Follows a redirect from an old handle.';
comment on function api_public.organization_profile_details(text) is 'The lists of an organization profile, by kind: capabilities (category URIDs), service regions (jurisdictions), verified domains, team members who opted in, and published case studies.';

do $$
declare
  f text;
begin
  foreach f in array array[
    'api_public.person_profile(text)', 'api_public.person_profile_skills(text)', 'api_public.person_profile_languages(text)',
    'api_public.person_profile_links(text)', 'api_public.person_profile_portfolio(text)', 'api_public.person_profile_references(text)',
    'api_public.person_profile_certifications(text)', 'api_public.person_profile_organizations(text)',
    'api_public.organization_profile(text)', 'api_public.organization_profile_details(text)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated, service_role', f);
  end loop;
end;
$$;

-- Media bucket ---------------------------------------------------------------------------------------------------
-- Profile photos, portfolio media, certificate scans and org logos and covers. Objects live under the owner id
-- (person id or org id). Public read: profiles render images by path, and only visible sections expose a path.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('profile-media', 'profile-media', true, 26214400,
  array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'application/pdf', 'video/mp4', 'audio/mpeg'])
on conflict (id) do nothing;

create policy profile_media_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'profile-media' and (private.brand_object_org(name) = private.current_person_id()
    or private.can_edit_org_profile(private.brand_object_org(name))));
create policy profile_media_update on storage.objects for update to authenticated
  using (bucket_id = 'profile-media' and (private.brand_object_org(name) = private.current_person_id()
    or private.can_edit_org_profile(private.brand_object_org(name))))
  with check (bucket_id = 'profile-media' and (private.brand_object_org(name) = private.current_person_id()
    or private.can_edit_org_profile(private.brand_object_org(name))));
create policy profile_media_delete on storage.objects for delete to authenticated
  using (bucket_id = 'profile-media' and (private.brand_object_org(name) = private.current_person_id()
    or private.can_edit_org_profile(private.brand_object_org(name))));

-- Domain events, audit and retention -------------------------------------------------------------------------------

insert into private.domain_event_types (code, subject, description) values
  ('organization.profile_changed', 'organization_profiles', 'An organization''s profile was created or changed.'),
  ('organization.verified', 'organization_verifications', 'An organization''s business identity was verified.'),
  ('certification.shared', 'certification_shares', 'A person shared a profile certification with the org.')
on conflict (code) do nothing;

create trigger t80_emit_event after insert on app.organization_verifications
  for each row execute function private.emit_row_event('organization.verified', '-', 'method');
create trigger t80_emit_event after insert on app.certification_shares
  for each row execute function private.emit_row_event('certification.shared', '-', 'person_certification_id');

create or replace function private.emit_org_profile_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.emit_event(new.org_id, 'organization.profile_changed', tg_table_name, new.id, null,
    jsonb_build_object('handle', new.handle, 'visibility', new.visibility));
  return null;
end;
$$;

comment on function private.emit_org_profile_event() is 'After insert or update of an organization profile: emits organization.profile_changed with the handle and visibility.';
revoke all on function private.emit_org_profile_event() from public, anon, authenticated;

create trigger t80_emit_event after insert or update on app.organization_profiles
  for each row execute function private.emit_org_profile_event();

call private.install_audit_trail('app.organization_profiles');
call private.install_audit_trail('app.organization_verifications');
call private.install_audit_trail('app.certification_shares');
call private.install_audit_trail('app.organization_case_studies');

call private.install_default_retention('app.person_profiles');
call private.install_default_retention('app.profile_section_visibility');
call private.install_default_retention('app.person_skills');
call private.install_default_retention('app.person_languages');
call private.install_default_retention('app.person_links');
call private.install_default_retention('app.portfolio_items');
call private.install_default_retention('app.person_references');
call private.install_default_retention('app.person_certifications');
call private.install_default_retention('app.certification_shares');
call private.install_default_retention('app.organization_profiles');
call private.install_default_retention('app.organization_profile_capabilities');
call private.install_default_retention('app.organization_service_regions');
call private.install_default_retention('app.organization_case_studies');
call private.install_default_retention('app.organization_profile_members');
call private.install_default_retention('app.organization_verifications');

-- 0730_onboarding.sql
-- A28 Engagements and Marketplace. Onboarding (Section 4.4.4 onboarding packets, Section 14.9):
--   * onboarding requirements per org, role type and jurisdiction, with verification method, expiry and reminders
--   * onboarding items per engagement (created from the requirements that apply when the engagement is created)
--     and their append-only verifications with expiry
--   * tax forms: Restricted, the identifier encrypted with pgcrypto under a Vault key, only the last four ever shown
--   * payout accounts: payment provider references only
--   * background checks: the provider's result and reference only, never the report
--   * the database rule that an engagement cannot become Active until every blocking requirement that applies
--     to it has a passing, unexpired item (Section 4.4.4)
-- An item passes when its latest verification passed and has not expired, or when a verified, unexpired item
-- for the same requirement and the same party carries over from another engagement with the same org.

-- Enums --------------------------------------------------------------------------------------------------------

create type app.onboarding_item_kind as enum (
  'Document Upload', 'Electronic Signature', 'Form', 'Certification', 'Training', 'Acknowledgment',
  'Background Check', 'Tax Form', 'Payout Details'
);
comment on type app.onboarding_item_kind is 'Kinds of onboarding item (Section 4.4.4).';

create type app.verification_method as enum ('Automatic', 'Reviewer');
comment on type app.verification_method is 'How an onboarding item is verified: automatically by an integration or by an org reviewer.';

create type app.verification_outcome as enum ('Passed', 'Failed');
comment on type app.verification_outcome is 'Outcome of an onboarding verification.';

create type app.tax_form_kind as enum ('W-9', 'W-8BEN', 'W-8BEN-E');
comment on type app.tax_form_kind is 'US tax forms collected from payees (Section 14.9).';

create type app.payout_provider as enum ('Stripe Connect', 'Accounting System');
comment on type app.payout_provider is 'Where payouts run: Stripe Connect, or the org''s own accounts payable through its accounting system (Section 4.4.5). XOS never holds funds.';

create type app.background_check_result as enum ('Pending', 'Clear', 'Consider', 'Suspended', 'Canceled');
comment on type app.background_check_result is 'Background check result as the provider reports it. XOS stores only the result and the provider reference, never the report.';

insert into private.domain_event_types (code, subject, description) values
  ('onboarding_item.verified', 'onboarding_verifications', 'An onboarding item was verified as passed or failed.'),
  ('background_check.updated', 'background_checks', 'A background check result arrived from the provider.');

-- Requirements ---------------------------------------------------------------------------------------------------

create table app.onboarding_requirements (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  name text not null,
  item_kind app.onboarding_item_kind not null,
  role_type app.external_role_type,
  jurisdiction_id text references xpms.jurisdiction (jurisdiction_id),
  verification_method app.verification_method not null,
  is_blocking boolean not null default true,
  valid_for_days integer,
  remind_days_before integer,
  deleted_at timestamptz,
  constraint onboarding_requirements_name_length check (char_length(btrim(name)) between 1 and 200),
  constraint onboarding_requirements_valid_for check (valid_for_days is null or valid_for_days > 0),
  constraint onboarding_requirements_remind check (remind_days_before is null or (valid_for_days is not null and remind_days_before between 1 and valid_for_days))
);

create index onboarding_requirements_jurisdiction_id_idx on app.onboarding_requirements (jurisdiction_id);
create index onboarding_requirements_role_type_idx on app.onboarding_requirements (org_id, role_type);

call private.install_domain_table('app.onboarding_requirements');
call private.describe('app.onboarding_requirements', 'An org''s onboarding packet requirements (Section 4.4.4), per role type and jurisdiction. A requirement applies to an engagement when its role type is NULL or matches and its jurisdiction is NULL or encloses the project''s.', array[
  'name', 'Requirement name, for example Certificate of Insurance.',
  'item_kind', 'Kind of item.',
  'role_type', 'External role type it applies to; NULL for every role type.',
  'jurisdiction_id', 'Jurisdiction it applies in, with those beneath it; NULL everywhere.',
  'verification_method', 'Automatic or Reviewer.',
  'is_blocking', 'True when the engagement cannot become Active until the item passes.',
  'valid_for_days', 'Days a verification stays valid; NULL when it does not expire.',
  'remind_days_before', 'Days before expiry the party is reminded.'
]);

-- Items and verifications -------------------------------------------------------------------------------------------

create table app.onboarding_items (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  engagement_id uuid not null references app.engagements (id),
  onboarding_requirement_id uuid not null references app.onboarding_requirements (id),
  document_id uuid references app.documents (id),
  submitted_at timestamptz,
  deleted_at timestamptz
);

create index onboarding_items_engagement_id_idx on app.onboarding_items (engagement_id);
create index onboarding_items_requirement_idx on app.onboarding_items (onboarding_requirement_id);
create index onboarding_items_document_id_idx on app.onboarding_items (document_id);
create unique index onboarding_items_key on app.onboarding_items (engagement_id, onboarding_requirement_id) where deleted_at is null;

call private.install_domain_table('app.onboarding_items', 'app.engagements', 'engagement_id',
  array['app.onboarding_requirements', 'onboarding_requirement_id', 'app.documents', 'document_id']);
call private.describe('app.onboarding_items', 'One onboarding requirement for one engagement: what the party submitted. Whether it passes is derived from its verifications (app.onboarding_item_status).', array[
  'engagement_id', 'Engagement being onboarded.',
  'onboarding_requirement_id', 'Requirement the item satisfies.',
  'document_id', 'Document the party submitted, when the item takes one.',
  'submitted_at', 'When the party submitted the item; NULL until then.'
]);

create table app.onboarding_verifications (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  onboarding_item_id uuid not null references app.onboarding_items (id),
  outcome app.verification_outcome not null,
  verified_by uuid references app.people (id),
  verified_at timestamptz not null default now(),
  expires_on date,
  note text,
  constraint onboarding_verifications_note_length check (note is null or char_length(btrim(note)) between 1 and 2000),
  constraint onboarding_verifications_failed_no_expiry check (outcome = 'Passed' or expires_on is null)
);

create index onboarding_verifications_item_idx on app.onboarding_verifications (onboarding_item_id, verified_at);
create index onboarding_verifications_verified_by_idx on app.onboarding_verifications (verified_by);

call private.install_domain_table('app.onboarding_verifications', 'app.onboarding_items', 'onboarding_item_id', '{}', true);
call private.describe('app.onboarding_verifications', 'Append-only verifications of an onboarding item. The latest decides; a Passed verification holds until expires_on. The reviewer is never the engaged party.', array[
  'onboarding_item_id', 'Item verified.',
  'outcome', 'Passed or Failed.',
  'verified_by', 'Reviewer, set from the session; NULL for an automatic verification by the platform.',
  'verified_at', 'When the item was verified, set by the database.',
  'expires_on', 'Last day a Passed verification holds; set from the requirement''s validity.',
  'note', 'Reviewer note. Internal.'
]);

insert into private.column_classifications (table_name, column_name, classification, read_capability) values
  ('app.onboarding_verifications', 'note', 'Confidential', null);

create trigger t90_emit_onboarding_verified after insert on app.onboarding_verifications
  for each row execute function private.emit_row_event('onboarding_item.verified', '-', 'onboarding_item_id', 'outcome');

-- Tax forms --------------------------------------------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'xos_tax_form_key') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'xos_tax_form_key',
      'Symmetric key that encrypts tax identifiers on app.tax_forms (Section 4.4.4, Section 8.3 Restricted).');
  end if;
end $$;

create table app.tax_forms (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  person_id uuid references app.people (id),
  organization_id uuid references app.organizations (id),
  form_kind app.tax_form_kind not null,
  tin_encrypted bytea not null,
  tin_last4 text not null,
  foreign_performer_withholding boolean not null default false,
  signed_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint tax_forms_one_payee check (num_nonnulls(person_id, organization_id) = 1),
  constraint tax_forms_last4_format check (tin_last4 ~ '^[0-9A-Z]{4}$'),
  constraint tax_forms_withholding_foreign check (not foreign_performer_withholding or form_kind <> 'W-9')
);

create index tax_forms_person_id_idx on app.tax_forms (person_id);
create index tax_forms_organization_id_idx on app.tax_forms (organization_id);

call private.install_domain_table('app.tax_forms');
call private.describe('app.tax_forms', 'Tax forms a payee gives an org (W-9, W-8BEN, W-8BEN-E; Section 14.9). The tax identifier is Restricted: stored encrypted with pgcrypto under a Vault key, never selectable by signed-in callers, and only its last four characters are ever displayed. The payee always reads their own forms (Section 8.7).', array[
  'org_id', 'Org the form was given to.',
  'person_id', 'Payee person.',
  'organization_id', 'Payee external account.',
  'form_kind', 'W-9, W-8BEN or W-8BEN-E.',
  'tin_encrypted', 'Tax identifier encrypted with pgp_sym_encrypt. Restricted (data.restricted.read.tax); readable only by the service role for year-end export.',
  'tin_last4', 'Last four characters of the tax identifier, the only part ever displayed.',
  'foreign_performer_withholding', 'True when foreign performer withholding applies (Section 4.4.4 artists).',
  'signed_at', 'When the payee signed the form, set by the database.'
]);

insert into private.column_classifications (table_name, column_name, classification, read_capability) values
  ('app.tax_forms', 'tin_encrypted', 'Restricted', 'data.restricted.read.tax');

create or replace function private.tax_form_key()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'xos_tax_form_key';
$$;

comment on function private.tax_form_key() is 'The Vault key that encrypts tax identifiers. Never granted to signed-in callers.';

create or replace function private.tax_form_tin(p_tax_form_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select extensions.pgp_sym_decrypt(t.tin_encrypted, private.tax_form_key()) from app.tax_forms t where t.id = p_tax_form_id;
$$;

comment on function private.tax_form_tin(uuid) is 'Decrypts a tax identifier for the year-end 1099-NEC export. Executable only by the service role.';

-- Payout accounts and background checks ----------------------------------------------------------------------------------

create table app.payout_accounts (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  person_id uuid references app.people (id),
  organization_id uuid references app.organizations (id),
  provider app.payout_provider not null,
  provider_account_reference text not null,
  account_last4 text,
  deleted_at timestamptz,
  constraint payout_accounts_one_payee check (num_nonnulls(person_id, organization_id) = 1),
  constraint payout_accounts_reference_length check (char_length(btrim(provider_account_reference)) between 1 and 200),
  constraint payout_accounts_last4_format check (account_last4 is null or account_last4 ~ '^[0-9A-Z]{4}$')
);

create index payout_accounts_person_id_idx on app.payout_accounts (person_id);
create index payout_accounts_organization_id_idx on app.payout_accounts (organization_id);

call private.install_domain_table('app.payout_accounts');
call private.describe('app.payout_accounts', 'Where an org pays a payee: a reference held by the payment provider, never bank details (Section 4.4.4).', array[
  'org_id', 'Paying org.',
  'person_id', 'Payee person.',
  'organization_id', 'Payee external account.',
  'provider', 'Stripe Connect or the org''s accounting system.',
  'provider_account_reference', 'The provider''s account or vendor reference.',
  'account_last4', 'Last four characters the provider reports for display, when it reports them.'
]);

insert into private.column_classifications (table_name, column_name, classification, read_capability) values
  ('app.payout_accounts', 'provider_account_reference', 'Confidential', null);

create table app.background_checks (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  engagement_id uuid not null references app.engagements (id),
  provider text not null default 'Checkr',
  provider_reference text not null,
  result app.background_check_result not null default 'Pending',
  completed_at timestamptz,
  deleted_at timestamptz,
  constraint background_checks_provider check (provider = 'Checkr'),
  constraint background_checks_reference_length check (char_length(btrim(provider_reference)) between 1 and 200),
  constraint background_checks_completed check ((result = 'Pending') = (completed_at is null))
);

create index background_checks_engagement_id_idx on app.background_checks (engagement_id);
create unique index background_checks_reference_key on app.background_checks (provider, provider_reference);

call private.install_domain_table('app.background_checks', 'app.engagements', 'engagement_id');
call private.describe('app.background_checks', 'Background checks run through the provider (Checkr), which handles FCRA disclosure, authorization and adverse action (Section 4.4.4, Section 14.9). XOS stores only the result and the provider reference, never the report.', array[
  'engagement_id', 'Engagement the check is for.',
  'provider', 'Provider; Checkr.',
  'provider_reference', 'The provider''s report reference.',
  'result', 'Result as the provider reports it.',
  'completed_at', 'When the provider completed the check; NULL while Pending.'
]);

create trigger t90_emit_background_check after insert or update of result on app.background_checks
  for each row execute function private.emit_row_event('background_check.updated', '-', 'engagement_id', 'result');

-- Applicability and passing ---------------------------------------------------------------------------------------------

create or replace function private.jurisdiction_chain(p_jurisdiction_id text)
returns setof text
language sql
stable
set search_path = ''
as $$
  with recursive chain as (
    select j.jurisdiction_id, j.parent from xpms.jurisdiction j where j.jurisdiction_id = p_jurisdiction_id
    union all
    select j.jurisdiction_id, j.parent from xpms.jurisdiction j join chain c on j.jurisdiction_id = c.parent
  )
  select c.jurisdiction_id::text from chain c;
$$;

comment on function private.jurisdiction_chain(text) is 'A jurisdiction and every jurisdiction enclosing it.';

create or replace function private.engagement_requirement_ids(p_engagement_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select r.id
  from app.engagements e
  join app.projects p on p.id = e.project_id
  left join app.venues v on v.id = p.venue_id
  join app.onboarding_requirements r on r.org_id = e.org_id and r.deleted_at is null
  where e.id = p_engagement_id
    and (r.role_type is null or r.role_type = e.role_type)
    and (r.jurisdiction_id is null
         or r.jurisdiction_id in (select private.jurisdiction_chain(coalesce(p.jurisdiction_id, v.jurisdiction_id))));
$$;

comment on function private.engagement_requirement_ids(uuid) is 'Onboarding requirements that apply to an engagement: the org''s requirements whose role type is NULL or matches and whose jurisdiction is NULL or encloses the project''s.';

create or replace function private.onboarding_item_passes(p_item_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select v.outcome = 'Passed' and (v.expires_on is null or v.expires_on >= current_date)
    from app.onboarding_verifications v
    where v.onboarding_item_id = p_item_id
    order by v.verified_at desc, v.id desc limit 1), false);
$$;

comment on function private.onboarding_item_passes(uuid) is 'True when the item''s latest verification passed and has not expired.';

create or replace function private.requirement_satisfied(p_engagement_id uuid, p_requirement_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from app.engagements e
    join app.engagements e2 on e2.org_id = e.org_id and e2.deleted_at is null
      and (e2.id = e.id or e2.person_id = e.person_id or e2.counterparty_id = e.counterparty_id)
    join app.onboarding_items i on i.engagement_id = e2.id and i.onboarding_requirement_id = p_requirement_id and i.deleted_at is null
    where e.id = p_engagement_id and private.onboarding_item_passes(i.id)
  );
$$;

comment on function private.requirement_satisfied(uuid, uuid) is 'True when the engagement has a passing item for the requirement, or a verified, unexpired item for the same requirement carries over from another engagement of the same party with the same org (Section 4.4.4).';

create or replace function private.engagement_open_blocking_requirements(p_engagement_id uuid)
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select r.name from app.onboarding_requirements r
  where r.id in (select private.engagement_requirement_ids(p_engagement_id))
    and r.is_blocking and not private.requirement_satisfied(p_engagement_id, r.id)
  order by r.name;
$$;

comment on function private.engagement_open_blocking_requirements(uuid) is 'Names of blocking requirements that apply to the engagement and are not yet satisfied.';

-- Guards ---------------------------------------------------------------------------------------------------------------

create or replace function private.guard_engagement_activation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_open text;
begin
  if new.engagement_state = 'Active' and old.engagement_state <> 'Active' then
    select string_agg(x, ', ') into v_open from private.engagement_open_blocking_requirements(new.id) x;
    if v_open is not null then
      perform private.refuse('onboarding_incomplete', format('Every blocking onboarding item must pass before the engagement is Active; open: %s.', v_open));
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_engagement_activation() is 'Section 4.4.4: an engagement becomes Active only when every blocking onboarding requirement that applies to it is satisfied. Database-enforced on every path that changes the state.';

create trigger t47_guard_engagement_activation before update of engagement_state on app.engagements
  for each row execute function private.guard_engagement_activation();

create or replace function private.create_onboarding_items()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into app.onboarding_items (engagement_id, onboarding_requirement_id)
  select new.id, r from private.engagement_requirement_ids(new.id) r;
  return null;
end;
$$;

comment on function private.create_onboarding_items() is 'After an engagement is created: one onboarding item for each requirement that applies to it (the onboarding packet).';

create trigger t85_create_onboarding_items after insert on app.engagements
  for each row execute function private.create_onboarding_items();

create or replace function private.guard_onboarding_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.engagement_id <> old.engagement_id or new.onboarding_requirement_id <> old.onboarding_requirement_id) then
    perform private.refuse('onboarding_item_immutable', 'An onboarding item keeps its engagement and requirement.');
  end if;
  if tg_op = 'INSERT' and (select r.org_id from app.onboarding_requirements r where r.id = new.onboarding_requirement_id)
     is distinct from (select e.org_id from app.engagements e where e.id = new.engagement_id) then
    perform private.refuse('cross_org_reference', 'onboarding_items.onboarding_requirement_id points to a row of another org.');
  end if;
  return new;
end;
$$;

comment on function private.guard_onboarding_item() is 'Onboarding items keep their engagement and requirement.';

create trigger t40_guard_onboarding_item before insert or update on app.onboarding_items
  for each row execute function private.guard_onboarding_item();

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
    new.expires_on := current_date + v_requirement.valid_for_days;
  end if;
  return new;
end;
$$;

comment on function private.guard_onboarding_verification() is 'Verifications: reviewer stamped from the session, never the engaged party (Section 8.2), Reviewer items only by people and Automatic items only by the platform, and a Passed verification expires after the requirement''s validity.';

create trigger t40_guard_onboarding_verification before insert on app.onboarding_verifications
  for each row execute function private.guard_onboarding_verification();

-- Policies -------------------------------------------------------------------------------------------------------------

create or replace function private.internal_engagement_ids(p_capability text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.id from app.engagements e where e.project_id in (select private.project_ids_with(p_capability));
$$;

comment on function private.internal_engagement_ids(text) is 'Engagements of projects on which the signed-in member holds the capability.';

create or replace function private.my_person_engagement_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.id from app.engagements e where e.person_id = private.current_person_id() and e.deleted_at is null;
$$;

comment on function private.my_person_engagement_ids() is 'Engagements in which the signed-in person is the engaged person, whatever their state; used for the person''s own background check results.';

call private.install_policies('app.onboarding_requirements',
  $$org_id in (select private.orgs_with_capability('opportunities.engagement.read'))$$,
  $$org_id in (select private.orgs_with_capability('opportunities.onboarding.write'))$$);

call private.install_policies('app.onboarding_items',
  $$engagement_id in (select private.internal_engagement_ids('opportunities.engagement.read'))
    or engagement_id in (select private.my_engagement_ids('onboarding'))$$,
  $$engagement_id in (select private.internal_engagement_ids('opportunities.onboarding.write'))$$);

create or replace function private.internal_onboarding_item_ids(p_capability text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select i.id from app.onboarding_items i
  where i.engagement_id in (select private.internal_engagement_ids(p_capability));
$$;

comment on function private.internal_onboarding_item_ids(text) is 'Onboarding items of engagements on projects where the signed-in member holds the capability.';

call private.install_policies('app.onboarding_verifications',
  $$onboarding_item_id in (select private.internal_onboarding_item_ids('opportunities.engagement.read'))$$,
  $$onboarding_item_id in (select private.internal_onboarding_item_ids('opportunities.onboarding.write'))$$);

call private.install_policies('app.tax_forms',
  $$person_id = (select private.current_person_id())
    or organization_id in (select private.my_account_ids(array['Account Owner', 'Account Admin', 'Account Finance']::app.account_role[]))
    or org_id in (select private.orgs_with_capability('data.restricted.read.tax'))$$);

call private.install_policies('app.payout_accounts',
  $$person_id = (select private.current_person_id())
    or organization_id in (select private.my_account_ids(array['Account Owner', 'Account Admin', 'Account Finance']::app.account_role[]))
    or org_id in (select private.orgs_with_capability('data.restricted.read.banking'))$$,
  $$person_id = (select private.current_person_id())
    or organization_id in (select private.my_account_ids(array['Account Owner', 'Account Admin', 'Account Finance']::app.account_role[]))$$);

call private.install_policies('app.background_checks',
  $$engagement_id in (select private.internal_engagement_ids('opportunities.onboarding.write'))
    or engagement_id in (select private.my_person_engagement_ids())$$,
  $$engagement_id in (select private.internal_engagement_ids('opportunities.onboarding.write'))$$);

-- Column privileges -----------------------------------------------------------------------------------------------------

revoke select, insert, update on app.tax_forms from authenticated;
grant select (id, org_id, person_id, organization_id, form_kind, tin_last4, foreign_performer_withholding, signed_at,
  created_at, created_by, updated_at, updated_by, deleted_at) on app.tax_forms to authenticated;
revoke insert, update on app.onboarding_items from authenticated;
grant insert (engagement_id, onboarding_requirement_id), update (deleted_at) on app.onboarding_items to authenticated;
revoke insert, update on app.onboarding_verifications from authenticated;
grant insert (onboarding_item_id, outcome, expires_on, note) on app.onboarding_verifications to authenticated;
revoke insert, update on app.payout_accounts from authenticated;
grant insert (org_id, person_id, organization_id, provider, provider_account_reference, account_last4),
  update (provider_account_reference, account_last4, deleted_at) on app.payout_accounts to authenticated;
revoke insert, update on app.background_checks from authenticated;
grant insert (engagement_id, provider, provider_reference), update (deleted_at) on app.background_checks to authenticated;

-- RPCs ---------------------------------------------------------------------------------------------------------------------

create or replace function app.submit_onboarding_item(p_item_id uuid, p_document_id uuid default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_item app.onboarding_items;
begin
  perform private.require_person();
  select * into v_item from app.onboarding_items i where i.id = p_item_id and i.deleted_at is null;
  if v_item.id is null or not exists (select 1 from private.engagement_scope(v_item.engagement_id) a where a = 'onboarding') then
    raise exception using errcode = '42501', message = 'the onboarding of this engagement is not open to the caller';
  end if;
  if p_document_id is not null and (select d.org_id from app.documents d where d.id = p_document_id) is distinct from v_item.org_id then
    perform private.refuse('cross_org_reference', 'onboarding_items.document_id points to a row of another org.');
  end if;
  update app.onboarding_items set submitted_at = now(), document_id = coalesce(p_document_id, document_id) where id = p_item_id;
end;
$$;

comment on function app.submit_onboarding_item(uuid, uuid) is 'The engaged party submits an onboarding item, optionally with a document of the org, while the onboarding area is open (Section 8.7).';

create or replace function app.submit_tax_form(
  p_org_id uuid,
  p_form_kind app.tax_form_kind,
  p_tin text,
  p_account_id uuid default null,
  p_foreign_performer_withholding boolean default false
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_tin text := upper(regexp_replace(coalesce(p_tin, ''), '[^0-9A-Za-z]', '', 'g'));
  v_id uuid;
begin
  if p_account_id is not null and not exists (
    select 1 from private.account_role(p_account_id) r where r in ('Account Owner', 'Account Admin', 'Account Finance')) then
    raise exception using errcode = '42501', message = 'Account Owner, Admin or Finance submits the account''s tax form';
  end if;
  if p_form_kind = 'W-9' and v_tin !~ '^[0-9]{9}$' then
    perform private.refuse('tin_format', 'A W-9 taxpayer identification number has nine digits.');
  end if;
  if char_length(v_tin) not between 4 and 30 then
    perform private.refuse('tin_format', 'A tax identifier has between 4 and 30 letters and digits.');
  end if;
  if (p_form_kind = 'W-8BEN-E' and p_account_id is null) or (p_form_kind = 'W-8BEN' and p_account_id is not null) then
    perform private.refuse('tax_form_payee', 'W-8BEN-E is filed by entities and W-8BEN by individuals; either files a W-9 when it is a US person.');
  end if;
  insert into app.tax_forms (org_id, person_id, organization_id, form_kind, tin_encrypted, tin_last4, foreign_performer_withholding)
  values (p_org_id, case when p_account_id is null then v_me end, p_account_id, p_form_kind,
    extensions.pgp_sym_encrypt(v_tin, private.tax_form_key()), right(v_tin, 4), p_foreign_performer_withholding)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.submit_tax_form(uuid, app.tax_form_kind, text, uuid, boolean) is 'A payee gives an org a tax form through the secure form path: the identifier is format-checked (Section 14.9), encrypted under the Vault key and reduced to its last four for display. Returns the form id.';

create or replace function app.verify_onboarding_item_automatically(p_item_id uuid, p_outcome app.verification_outcome, p_expires_on date default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if auth.uid() is not null then
    raise exception using errcode = '42501', message = 'automatic verifications come from the platform';
  end if;
  insert into app.onboarding_verifications (onboarding_item_id, outcome, expires_on)
  values (p_item_id, p_outcome, p_expires_on) returning id into v_id;
  return v_id;
end;
$$;

comment on function app.verify_onboarding_item_automatically(uuid, app.verification_outcome, date) is 'Records an automatic verification from an integration (service role only).';

-- Views ----------------------------------------------------------------------------------------------------------------------

create view app.onboarding_item_status as
select i.id as onboarding_item_id, i.org_id, i.engagement_id, i.onboarding_requirement_id, r.name, r.item_kind, r.is_blocking,
  r.verification_method, i.submitted_at,
  lv.outcome as latest_outcome, lv.expires_on,
  private.onboarding_item_passes(i.id) as passes,
  (not private.onboarding_item_passes(i.id) and private.requirement_satisfied(i.engagement_id, i.onboarding_requirement_id)) as carried_over,
  (lv.expires_on is not null and r.remind_days_before is not null
    and lv.expires_on - r.remind_days_before <= current_date and lv.expires_on >= current_date) as reminder_due
from app.onboarding_items i
join app.onboarding_requirements r on r.id = i.onboarding_requirement_id
left join lateral (
  select v.outcome, v.expires_on from app.onboarding_verifications v
  where v.onboarding_item_id = i.id order by v.verified_at desc, v.id desc limit 1
) lv on true
where i.deleted_at is null
  and (i.engagement_id in (select private.internal_engagement_ids('opportunities.engagement.read'))
       or i.engagement_id in (select private.my_engagement_ids('onboarding')));

call private.describe('app.onboarding_item_status', 'Onboarding progress per item, derived: the latest verification, whether the item passes or carries over from the same party''s earlier engagement with the org, and whether an expiry reminder is due. Rows follow the onboarding item read rule; reviewer notes are not projected.', array[
  'onboarding_item_id', 'Item.',
  'org_id', 'Org.',
  'engagement_id', 'Engagement.',
  'onboarding_requirement_id', 'Requirement.',
  'name', 'Requirement name.',
  'item_kind', 'Kind of item.',
  'is_blocking', 'True when the item blocks Active.',
  'verification_method', 'Automatic or Reviewer.',
  'submitted_at', 'When the party submitted it.',
  'latest_outcome', 'Outcome of the latest verification; NULL before any.',
  'expires_on', 'Expiry of the latest verification.',
  'passes', 'True when the latest verification passed and has not expired.',
  'carried_over', 'True when the item does not pass itself but a verified item for the same requirement carries over.',
  'reminder_due', 'True when the expiry reminder window has opened.'
]);

revoke all on app.onboarding_item_status from public, anon;
grant select on app.onboarding_item_status to authenticated, service_role;

-- Function privileges --------------------------------------------------------------------------------------------------------

revoke all on function private.tax_form_key() from public, anon, authenticated;
revoke all on function private.tax_form_tin(uuid) from public, anon, authenticated;
grant execute on function private.tax_form_tin(uuid) to service_role;
revoke all on function private.jurisdiction_chain(text) from public, anon;
revoke all on function private.engagement_requirement_ids(uuid) from public, anon, authenticated;
revoke all on function private.onboarding_item_passes(uuid) from public, anon;
revoke all on function private.requirement_satisfied(uuid, uuid) from public, anon;
revoke all on function private.engagement_open_blocking_requirements(uuid) from public, anon, authenticated;
revoke all on function private.guard_engagement_activation() from public, anon, authenticated;
revoke all on function private.create_onboarding_items() from public, anon, authenticated;
revoke all on function private.guard_onboarding_item() from public, anon, authenticated;
revoke all on function private.guard_onboarding_verification() from public, anon, authenticated;
revoke all on function private.internal_engagement_ids(text) from public, anon;
revoke all on function private.internal_onboarding_item_ids(text) from public, anon;
revoke all on function private.my_person_engagement_ids() from public, anon;
grant execute on function private.my_person_engagement_ids() to authenticated, service_role;
grant execute on function private.jurisdiction_chain(text) to authenticated, service_role;
grant execute on function private.onboarding_item_passes(uuid) to authenticated, service_role;
grant execute on function private.requirement_satisfied(uuid, uuid) to authenticated, service_role;
grant execute on function private.internal_engagement_ids(text) to authenticated, service_role;
grant execute on function private.internal_onboarding_item_ids(text) to authenticated, service_role;

revoke all on function app.submit_onboarding_item(uuid, uuid) from public, anon;
revoke all on function app.submit_tax_form(uuid, app.tax_form_kind, text, uuid, boolean) from public, anon;
revoke all on function app.verify_onboarding_item_automatically(uuid, app.verification_outcome, date) from public, anon, authenticated;
grant execute on function app.submit_onboarding_item(uuid, uuid) to authenticated, service_role;
grant execute on function app.submit_tax_form(uuid, app.tax_form_kind, text, uuid, boolean) to authenticated, service_role;
grant execute on function app.verify_onboarding_item_automatically(uuid, app.verification_outcome, date) to service_role;

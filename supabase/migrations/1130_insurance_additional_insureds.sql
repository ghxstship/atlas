-- 1130_insurance_additional_insureds.sql
-- A44 Gateway, notification and Compass gaps (RRR-88), finding A38-001 (journey 43: "an insurance certificate whose
-- additional insureds are verified"). Certificates of insurance (0330) recorded carrier, policy, limit and validity
-- only, so nothing could name or check the additional insureds an org requires:
--   * app.insurance_certificate_insureds: the additional insureds a certificate names, with the endorsement kind
--     (Aurora's certificate extraction proposes them as repeating lines, journey 36)
--   * app.required_additional_insureds: who an org requires its vendors to name, org-wide or for one project
--   * app.engagement_insured_checks: per vendor engagement and required insured, the current certificate naming
--     it, or NULL when none does; app.insurance_certificate_checks: per certificate, whether it names every
--     org-wide required insured
--   * app.verify_onboarding_insureds: the reviewer's verification step. It records a Passed verification on an
--     onboarding item only when a current certificate names every required insured for the engagement's project,
--     and a Failed one naming who is missing otherwise
--   * api_external.vendor_certificate_insureds: the vendor sees the insureds each org has on file for it
-- Names match ignoring case, surrounding space and repeated spaces; the endorsement kind must match too.

create type app.endorsement_kind as enum ('Additional Insured', 'Primary and Noncontributory', 'Waiver of Subrogation');
comment on type app.endorsement_kind is 'Endorsement a certificate of insurance grants a named party: Additional Insured status, primary and noncontributory wording, or a waiver of subrogation.';

create or replace function private.insured_name_key(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')));
$$;

comment on function private.insured_name_key(text) is 'Comparison key of an insured name: lower case, trimmed, single spaces.';

-- Insureds a certificate names -----------------------------------------------------------------------------------

create table app.insurance_certificate_insureds (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  certificate_id uuid not null references app.insurance_certificates (id),
  insured_name text not null,
  endorsement_kind app.endorsement_kind not null default 'Additional Insured',
  deleted_at timestamptz,
  constraint insurance_certificate_insureds_name_length check (char_length(btrim(insured_name)) between 1 and 200)
);

create index insurance_certificate_insureds_certificate_idx on app.insurance_certificate_insureds (certificate_id);
create unique index insurance_certificate_insureds_key on app.insurance_certificate_insureds
  (certificate_id, private.insured_name_key(insured_name), endorsement_kind) where deleted_at is null;

call private.install_domain_table('app.insurance_certificate_insureds', 'app.insurance_certificates', 'certificate_id');
call private.describe('app.insurance_certificate_insureds', 'Parties a certificate of insurance names, one row per party and endorsement (finding A38-001). A name appears once per endorsement on a certificate.', array[
  'certificate_id', 'Certificate naming the party.',
  'insured_name', 'Party named, as the certificate prints it.',
  'endorsement_kind', 'Endorsement granted: Additional Insured, Primary and Noncontributory, or Waiver of Subrogation.'
]);

-- Who an org requires --------------------------------------------------------------------------------------------

create table app.required_additional_insureds (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid references app.projects (id),
  insured_name text not null,
  endorsement_kind app.endorsement_kind not null default 'Additional Insured',
  deleted_at timestamptz,
  constraint required_additional_insureds_name_length check (char_length(btrim(insured_name)) between 1 and 200)
);

create index required_additional_insureds_project_idx on app.required_additional_insureds (project_id);
create unique index required_additional_insureds_key on app.required_additional_insureds
  (org_id, coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid), private.insured_name_key(insured_name), endorsement_kind)
  where deleted_at is null;

call private.install_domain_table('app.required_additional_insureds', null, null, array['app.projects', 'project_id']);
call private.describe('app.required_additional_insureds', 'Parties an org requires its vendors'' certificates to name (finding A38-001): org-wide when project_id is NULL, otherwise for vendors engaged on that project as well.', array[
  'project_id', 'Project the requirement adds to; NULL for every project of the org.',
  'insured_name', 'Party that must be named, for example the venue owner.',
  'endorsement_kind', 'Endorsement the party must hold.'
]);

call private.install_policies('app.insurance_certificate_insureds',
  $$org_id in (select private.orgs_with_capability('vendors.vendor.read'))$$,
  $$org_id in (select private.orgs_with_capability('vendors.coi.write'))$$);
call private.install_policies('app.required_additional_insureds',
  $$org_id in (select private.orgs_with_capability('vendors.vendor.read'))$$,
  $$org_id in (select private.orgs_with_capability('vendors.coi.write'))$$);

call private.install_default_retention('app.insurance_certificate_insureds');
call private.install_default_retention('app.required_additional_insureds');
call private.install_audit_trail('app.insurance_certificate_insureds');
call private.install_audit_trail('app.required_additional_insureds');

-- Checks ------------------------------------------------------------------------------------------------------------

create or replace function private.current_certificate_naming(p_vendor_id uuid, p_insured_name text, p_endorsement app.endorsement_kind)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select ic.id from app.insurance_certificates ic
  join app.insurance_certificate_insureds n on n.certificate_id = ic.id and n.deleted_at is null
  where ic.vendor_id = p_vendor_id and ic.deleted_at is null and current_date between ic.valid_from and ic.valid_to
    and private.insured_name_key(n.insured_name) = private.insured_name_key(p_insured_name) and n.endorsement_kind = p_endorsement
  order by ic.valid_to desc, ic.id
  limit 1;
$$;

comment on function private.current_certificate_naming(uuid, text, app.endorsement_kind) is 'The vendor''s current certificate (valid today) that names the party with the endorsement, latest expiry first; NULL when none does. Callers reach it only through rows they may already read (the checks view and the verification step).';

create view app.engagement_insured_checks with (security_invoker = true) as
select e.id as engagement_id, e.org_id, e.project_id, v.id as vendor_id, r.id as required_insured_id, r.insured_name, r.endorsement_kind,
  (r.project_id is not null) as project_specific,
  private.current_certificate_naming(v.id, r.insured_name, r.endorsement_kind) as named_on_certificate_id
from app.engagements e
join app.vendors v on v.counterparty_id = e.counterparty_id and v.org_id = e.org_id and v.deleted_at is null
join app.required_additional_insureds r on r.org_id = e.org_id and r.deleted_at is null and (r.project_id is null or r.project_id = e.project_id)
where e.deleted_at is null;

call private.describe('app.engagement_insured_checks', 'For each engagement of a vendor and each additional insured the org requires on its project (org-wide or project), the current certificate that names the party with the endorsement. named_on_certificate_id is NULL when no current certificate does.', array[
  'engagement_id', 'Vendor engagement.', 'org_id', 'Org.', 'project_id', 'Project of the engagement.', 'vendor_id', 'Vendor facet of the engaged counterparty.',
  'required_insured_id', 'Requirement.', 'insured_name', 'Party that must be named.', 'endorsement_kind', 'Endorsement required.',
  'project_specific', 'True when the requirement is for this project only.',
  'named_on_certificate_id', 'Current certificate naming the party; NULL when missing.']);

create view app.insurance_certificate_checks with (security_invoker = true) as
select c.*, (c.missing_count = 0) as insureds_verified
from (
  select ic.id as certificate_id, ic.org_id, ic.vendor_id,
    (select count(*)::int from app.insurance_certificate_insureds n where n.certificate_id = ic.id and n.deleted_at is null) as insured_count,
    (select count(*)::int from app.required_additional_insureds r where r.org_id = ic.org_id and r.project_id is null and r.deleted_at is null) as required_count,
    (select count(*)::int from app.required_additional_insureds r
     where r.org_id = ic.org_id and r.project_id is null and r.deleted_at is null
       and not exists (select 1 from app.insurance_certificate_insureds n
                       where n.certificate_id = ic.id and n.deleted_at is null and n.endorsement_kind = r.endorsement_kind
                         and private.insured_name_key(n.insured_name) = private.insured_name_key(r.insured_name))) as missing_count,
    (current_date between ic.valid_from and ic.valid_to) as is_current
  from app.insurance_certificates ic
  where ic.deleted_at is null
) c;

call private.describe('app.insurance_certificate_checks', 'Per certificate: how many parties it names, how many the org requires org-wide, and how many of those it misses. insureds_verified is missing_count = 0; project requirements are checked per engagement in app.engagement_insured_checks.', array[
  'certificate_id', 'Certificate.', 'org_id', 'Org.', 'vendor_id', 'Vendor.', 'insured_count', 'Parties the certificate names.',
  'required_count', 'Org-wide required insureds.', 'missing_count', 'Org-wide required insureds the certificate does not name.',
  'is_current', 'True when valid today.', 'insureds_verified', 'True when the certificate names every org-wide required insured.']);

revoke all on app.engagement_insured_checks, app.insurance_certificate_checks from public, anon;
grant select on app.engagement_insured_checks, app.insurance_certificate_checks to authenticated, service_role;

-- Verification step ---------------------------------------------------------------------------------------------------

create or replace function app.verify_onboarding_insureds(p_item_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
  v_vendor uuid;
  v_missing text[];
  v_required integer;
  v_outcome app.verification_outcome;
  v_verification uuid;
begin
  perform private.require_person();
  if p_item_id is null or p_item_id not in (select private.internal_onboarding_item_ids('opportunities.onboarding.write')) then
    raise exception using errcode = '42501', message = 'opportunities.onboarding.write is required on the engagement''s project';
  end if;
  select e.* into v_engagement from app.onboarding_items i join app.engagements e on e.id = i.engagement_id
  where i.id = p_item_id and i.deleted_at is null;
  select v.id into v_vendor from app.vendors v
  where v.counterparty_id = v_engagement.counterparty_id and v.org_id = v_engagement.org_id and v.deleted_at is null;
  if v_vendor is null then
    perform private.refuse('insureds_vendor_only', 'Additional insureds are checked for vendor engagements; this party is not a vendor of the org.');
  end if;
  select count(*)::int,
    coalesce(array_agg(r.insured_name || ' (' || r.endorsement_kind::text || ')' order by r.insured_name)
      filter (where private.current_certificate_naming(v_vendor, r.insured_name, r.endorsement_kind) is null), '{}')
  into v_required, v_missing
  from app.required_additional_insureds r
  where r.org_id = v_engagement.org_id and r.deleted_at is null and (r.project_id is null or r.project_id = v_engagement.project_id);
  if v_required = 0 then
    perform private.refuse('insureds_none_required', 'The org requires no additional insureds for this project. Add them under Vendors, Insurance certificates first.');
  end if;
  v_outcome := case when cardinality(v_missing) = 0 then 'Passed' else 'Failed' end;
  insert into app.onboarding_verifications (onboarding_item_id, outcome, note)
  values (p_item_id, v_outcome,
    case when v_outcome = 'Passed' then 'A current certificate names every required additional insured.'
         else left('Missing additional insureds: ' || array_to_string(v_missing, ', ') || '.', 2000) end)
  returning id into v_verification;
  return jsonb_build_object('verification_id', v_verification, 'outcome', v_outcome, 'required', v_required,
    'missing', to_jsonb(v_missing));
end;
$$;

comment on function app.verify_onboarding_insureds(uuid) is 'The reviewer''s additional insureds step (journey 43, finding A38-001): compares the insureds named on the vendor''s current certificates with those the org requires on the engagement''s project and records a Passed verification on the onboarding item when none is missing, or a Failed one naming who is missing. Needs opportunities.onboarding.write; the engaged party can never verify itself (the verification guard). Refuses a party that is not a vendor and a project with no requirement. Returns the outcome and the missing names.';

-- The vendor's view ------------------------------------------------------------------------------------------------------

create view api_external.vendor_certificate_insureds as
select n.id, n.certificate_id, x.org_id, x.account_id, n.insured_name, n.endorsement_kind
from app.insurance_certificate_insureds n
join api_external.vendor_insurance_certificates x on x.id = n.certificate_id
where n.deleted_at is null;

call private.describe('api_external.vendor_certificate_insureds', 'Parties named on the certificates each org keeps on file for the caller''s account, with the endorsement, while an engagement with that org has the documents area open.', array[
  'id', 'Named party.', 'certificate_id', 'Certificate.', 'org_id', 'Org.', 'account_id', 'The caller''s account.',
  'insured_name', 'Party named.', 'endorsement_kind', 'Endorsement.']);

revoke all on api_external.vendor_certificate_insureds from public, anon;
grant select on api_external.vendor_certificate_insureds to authenticated, service_role;

insert into private.comment_subjects (table_name) values ('app.insurance_certificate_insureds'), ('app.required_additional_insureds')
on conflict do nothing;

revoke all on function private.insured_name_key(text) from public, anon;
grant execute on function private.insured_name_key(text) to authenticated, service_role;
revoke all on function private.current_certificate_naming(uuid, text, app.endorsement_kind) from public, anon;
grant execute on function private.current_certificate_naming(uuid, text, app.endorsement_kind) to authenticated, service_role;
revoke all on function app.verify_onboarding_insureds(uuid) from public, anon;
grant execute on function app.verify_onboarding_insureds(uuid) to authenticated, service_role;

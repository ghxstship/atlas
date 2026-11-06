-- 6071_vendor_certificate_uploads.sql
-- Launch flag (owner, 2026-11-06, RRR-247): a vendor's upload became an onboarding item and nothing else, so the vendor
-- kept seeing "No insurance certificate on file" and the people who record certificates had no way to see it.
--   * app.vendor_certificate_uploads: for holders of vendors.coi.write, files a vendor engagement's party uploaded that
--     nobody has reviewed yet and no certificate points at. Requirements have only a free-text name (Certificate of
--     Insurance, COI, Proof of Coverage), so this does not guess which uploads are insurance: it lists them all, by name,
--     and the reviewer decides. A certificate recorded from one names its file in document_uri, which takes it off the list.
--   * private.onboarding_upload_readable also lets holders of vendors.coi.write read the file of a vendor engagement's
--     item, from its latest definition (0762), since recording a certificate means reading it. It gives them nothing else.
-- Nothing here verifies anything. Recording a certificate does not pass the onboarding item; a reviewer still does that
-- on the engagement. Requirements, expiry cycles and automatic checks of a certificate are later work (S-34, S-39, S-47).

create function app.vendor_certificate_uploads(p_org_id uuid)
returns table (
  onboarding_item_id uuid,
  engagement_id uuid,
  vendor_id uuid,
  vendor_name text,
  item_name text,
  submitted_at timestamptz,
  storage_uri text
)
language sql
stable
security definer
set search_path = ''
as $$
  select i.id, e.id, v.id, c.counterparty_name, r.name, i.submitted_at, f.storage_uri
  from app.onboarding_items i
  join app.onboarding_requirements r on r.id = i.onboarding_requirement_id and r.item_kind in ('Document Upload', 'Certification')
  join app.engagements e on e.id = i.engagement_id and e.deleted_at is null
    and e.engagement_state in ('Onboarding', 'Blocked', 'Active', 'Closing')
  join app.vendors v on v.counterparty_id = e.counterparty_id and v.org_id = e.org_id and v.deleted_at is null
  join app.counterparties c on c.id = v.counterparty_id
  join lateral (
    select dv.storage_uri from app.document_versions dv
    where dv.document_id = i.document_id
    order by dv.created_at desc, dv.id desc limit 1
  ) f on true
  where private.has_capability(p_org_id, 'vendors.coi.write')
    and i.org_id = p_org_id and i.deleted_at is null and i.submitted_at is not null
    and f.storage_uri like 'storage://onboarding-uploads/%'
    and not exists (
      select 1 from app.onboarding_verifications ov
      where ov.onboarding_item_id = i.id and ov.verified_at >= i.submitted_at)
    and not exists (
      select 1 from app.insurance_certificates ic
      where ic.org_id = p_org_id and ic.vendor_id = v.id and ic.document_uri = f.storage_uri and ic.deleted_at is null)
  order by i.submitted_at desc, i.id;
$$;
comment on function app.vendor_certificate_uploads(uuid) is 'Files vendor engagements uploaded for onboarding items that nobody has reviewed since and no certificate of insurance points at, for holders of vendors.coi.write (6071); others get no rows. It lists every such upload, since a requirement''s name alone does not say it is insurance.';
revoke all on function app.vendor_certificate_uploads(uuid) from public, anon;
grant execute on function app.vendor_certificate_uploads(uuid) to authenticated, service_role;

create or replace function private.onboarding_upload_readable(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.onboarding_upload_writable(p_object_name)
    or private.onboarding_upload_item(p_object_name) in (select private.internal_onboarding_item_ids('opportunities.engagement.read'))
    or exists (
      select 1 from app.onboarding_items i
      join app.engagements e on e.id = i.engagement_id
      join app.vendors v on v.counterparty_id = e.counterparty_id and v.org_id = e.org_id and v.deleted_at is null
      where i.id = private.onboarding_upload_item(p_object_name)
        and private.has_capability(i.org_id, 'vendors.coi.write'));
$$;
comment on function private.onboarding_upload_readable(text) is 'True when the signed-in person may read an onboarding upload: the party while the onboarding area is open, an org member who reads the engagement, or for a vendor engagement a holder of vendors.coi.write, who records its certificate (6071).';

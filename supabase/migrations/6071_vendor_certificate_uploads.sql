-- 6071_vendor_certificate_uploads.sql
-- Launch flag (owner, 2026-11-06, RRR-247): a vendor's upload became an onboarding item and nothing else, so the vendor
-- kept seeing "No insurance certificate on file" and the people who record certificates had no way to see it.
-- app.vendor_certificate_uploads lists, for holders of vendors.coi.write, files a vendor engagement's party uploaded that
-- no certificate points at. Requirements have only a free-text name (Certificate of Insurance, COI, Proof of Coverage),
-- so this does not guess which uploads are insurance: it lists them all, by name, and the person decides.
--   * A failed review takes a file off the list until the vendor uploads again. A passed one does not: passing an item
--     records no certificate, so the file has to stay reachable, and a file that is not insurance leaves when the
--     engagement closes.
--   * A file the scanner refused or removed is not listed. One still being scanned is, and says so.
--   * A certificate recorded from one names its file in document_uri, which takes it off the list.
-- Who may open the file is unchanged: private.onboarding_upload_readable already admits whoever reads the engagement,
-- which every seeded role holding vendors.coi.write does. Someone holding only vendors.coi.write sees the row with no
-- link and cannot record from it.
-- Only a Vendor engagement's uploads are listed, as Gateway shows the certificate line only to one: a Contractor or Sponsor
-- whose counterparty is also a vendor is not listed.
-- The party's own view of an item, api_external.onboarding_items, gains awaiting_review: submitted, not reviewed since,
-- and not refused by the scanner. Gateway and Compass read it, so a file uploaded again after a failed review reads as
-- received and waiting, as the staff list above shows it, and a file the scanner refused does not.
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
  storage_uri text,
  review_passed boolean,
  scan_status text,
  total_count integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select i.id, e.id, v.id, o.name, r.name, i.submitted_at, f.storage_uri,
    coalesce(ov.outcome = 'Passed', false), s.scan_status::text, (count(*) over ())::integer
  from app.onboarding_items i
  join app.onboarding_requirements r on r.id = i.onboarding_requirement_id and r.item_kind in ('Document Upload', 'Certification')
  join app.engagements e on e.id = i.engagement_id and e.deleted_at is null and e.role_type = 'Vendor'
    and e.engagement_state in ('Onboarding', 'Blocked', 'Active', 'Closing')
  join app.vendors v on v.counterparty_id = e.counterparty_id and v.org_id = e.org_id and v.deleted_at is null
  join app.counterparties c on c.id = v.counterparty_id
  left join app.organizations o on o.id = c.organization_id
  join lateral (
    select dv.storage_uri from app.document_versions dv
    where dv.document_id = i.document_id
    order by dv.created_at desc, dv.id desc limit 1
  ) f on true
  join private.object_scans s on s.bucket_id = 'onboarding-uploads'
    and s.object_name = substr(f.storage_uri, char_length('storage://onboarding-uploads/') + 1)
    and s.scan_status in ('Scanning', 'Clean')
  left join lateral (
    select x.outcome from app.onboarding_verifications x
    where x.onboarding_item_id = i.id and x.verified_at >= i.submitted_at
    order by x.verified_at desc, x.id desc limit 1
  ) ov on true
  where private.has_capability(p_org_id, 'vendors.coi.write')
    and i.org_id = p_org_id and i.deleted_at is null and i.submitted_at is not null
    and f.storage_uri like 'storage://onboarding-uploads/%'
    and ov.outcome is distinct from 'Failed'
    and not exists (
      select 1 from app.insurance_certificates ic
      where ic.org_id = p_org_id and ic.vendor_id = v.id and ic.document_uri = f.storage_uri and ic.deleted_at is null)
  order by coalesce(ov.outcome = 'Passed', false), i.submitted_at desc, i.id
  limit 50;
$$;
comment on function app.vendor_certificate_uploads(uuid) is 'Files Vendor engagements uploaded for onboarding items that no certificate of insurance points at, unless a review failed them or the scanner refused them, for holders of vendors.coi.write (6071); others get no rows. Those not reviewed come first, at most 50, each with how many there are in all. It lists every such upload, since a requirement''s name alone does not say it is insurance.';
revoke all on function app.vendor_certificate_uploads(uuid) from public, anon;
grant execute on function app.vendor_certificate_uploads(uuid) to authenticated, service_role;

-- What the party reads: the view of 0750, its latest definition, with awaiting_review added at the end.
create or replace view api_external.onboarding_items as
select i.id, i.engagement_id, r.name, r.item_kind, r.is_blocking, r.verification_method, i.submitted_at,
  lv.outcome as latest_outcome, lv.expires_on, private.onboarding_item_passes(i.id) as passes,
  private.requirement_satisfied(i.engagement_id, i.onboarding_requirement_id) as satisfied,
  (i.submitted_at is not null
    and not exists (select 1 from app.onboarding_verifications v where v.onboarding_item_id = i.id and v.verified_at >= i.submitted_at)
    and not exists (
      select 1 from (
        select dv.storage_uri from app.document_versions dv
        where dv.document_id = i.document_id
        order by dv.created_at desc, dv.id desc limit 1) f
      join private.object_scans s on s.bucket_id = 'onboarding-uploads'
        and s.object_name = substr(f.storage_uri, char_length('storage://onboarding-uploads/') + 1)
      where f.storage_uri like 'storage://onboarding-uploads/%' and s.scan_status in ('Infected', 'Scan Failed'))) as awaiting_review
from app.onboarding_items i
join app.onboarding_requirements r on r.id = i.onboarding_requirement_id
left join lateral (
  select v.outcome, v.expires_on from app.onboarding_verifications v
  where v.onboarding_item_id = i.id order by v.verified_at desc, v.id desc limit 1
) lv on true
where i.deleted_at is null and i.engagement_id in (select private.my_engagement_ids('onboarding'));

call private.describe('api_external.onboarding_items', 'The caller''s onboarding packet items and their progress while the onboarding area is open. Reviewer notes never appear.', array[
  'awaiting_review', 'True when it was submitted, nobody has reviewed it since, and the scanner has not refused its file (6071).']);

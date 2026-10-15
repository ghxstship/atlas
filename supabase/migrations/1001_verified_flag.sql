-- 1001_verified_flag.sql
-- A28 Engagements and Marketplace (RRR-30), post-late-slot range (ADR 0022): A30's verified flag (Section 4.8.3,
-- private.organization_verified in 0860) on the Gateway marketplace. Lives after 0860 because the helper is created
-- there. Columns are appended; earlier columns are unchanged.
--   * api_external.opportunities.org_verified: the posting org's verified badge
--   * api_external.my_accounts.verified: whether the caller's own account is verified

create or replace view api_external.opportunities as
select op.id, op.org_id, o.name as org_name, op.title, op.description, op.role_type, op.role_code, op.cat_urid,
  v.name as venue_name, op.jurisdiction_id, op.starts_on, op.ends_on, op.visibility, op.rate_type,
  op.pay_min_minor, op.pay_max_minor, op.currency_code, (op.rate_type is null) as rate_on_request,
  op.deadline_at, op.minimum_age, op.opportunity_state,
  (select count(*) from app.opportunity_positions pp where pp.opportunity_id = op.id and pp.deleted_at is null) as position_count,
  v.locality as venue_locality,
  private.organization_verified(op.org_id) as org_verified
from app.opportunities op
join app.organizations o on o.id = op.org_id
left join app.venues v on v.id = op.venue_id
where op.deleted_at is null
  and (op.id in (select private.visible_opportunity_ids())
    or op.id in (select a.opportunity_id from app.applications a where a.id in (select private.my_application_ids())));

comment on column api_external.opportunities.org_verified is 'True while the posting org holds a current business identity verification (Section 4.8.3): the verified badge.';

create or replace view api_external.my_accounts as
select o.id as account_id, o.name, o.slug, o.organization_type,
  array(select r.r from private.account_role(o.id) r (r) order by r.r) as my_roles,
  private.organization_verified(o.id) as verified
from app.organizations o
where o.id in (select private.my_account_ids(null));

comment on column api_external.my_accounts.verified is 'True while the account holds a current business identity verification (Section 4.8.3).';

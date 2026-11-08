-- 6143_account_deletion_billing_consent.sql
-- Legal billing issue 1 (RRR-248, ADR 0161 D6.4): account deletion says what it keeps (SIM-004), and a renewal consent
-- (6141) keeps the person's sign-in email and initials as evidence of what was agreed. app.delete_my_account leaves it, so
-- the list Compass and Gateway show before and after deletion names it whenever the person agreed to one.
--   * private.account_deletion_kept, restated from 1112 (its only definition) with one item: billing_consent, kept 7 years
--     and a year after the plan ends (private.run_billing_evidence_retention). Nothing else changes.

create or replace function private.account_deletion_kept(p_person_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with mine as (select m.id from app.memberships m where m.person_id = p_person_id),
  engaged as (select e.id from app.engagements e where e.person_id = p_person_id and e.deleted_at is null)
  select jsonb_agg(k.item order by k.ord) from (
    select 1 as ord, jsonb_build_object('category', 'time_and_pay', 'retention', '7 years') as item
    where exists (select 1 from app.time_entries t where t.deleted_at is null
                    and (t.membership_id in (select id from mine) or t.engagement_id in (select id from engaged)))
       or exists (select 1 from app.payroll_lines l where l.deleted_at is null and l.membership_id in (select id from mine))
    union all
    select 2, jsonb_build_object('category', 'tax_forms', 'retention', '7 years')
    where exists (select 1 from app.tax_forms f where f.person_id = p_person_id and f.deleted_at is null)
    union all
    select 3, jsonb_build_object('category', 'engagements', 'retention', '7 years')
    where exists (select 1 from engaged)
    union all
    select 4, jsonb_build_object('category', 'org_records', 'retention', 'org')
    union all
    -- The renewal terms they agreed to for an org's paid plan, with their sign-in email and initials (6141).
    select 5, jsonb_build_object('category', 'billing_consent', 'retention', '7 years')
    where exists (select 1 from private.billing_renewal_consents c where c.consented_by = p_person_id)
    union all
    select 6, jsonb_build_object('category', 'audit_trail', 'retention', '7 years')
    union all
    select 7, jsonb_build_object('category', 'erasure_request', 'retention', '7 years')
  ) k;
$$;

comment on function private.account_deletion_kept(uuid) is 'What an account deletion keeps, and for how long (SIM-004): time and pay records, tax forms and engagement records under payroll retention, the org''s own records without the person''s name, the renewal terms they agreed to for a paid plan with their sign-in email and initials (6143, ADR 0161), the audit trail and the erasure request.';
revoke all on function private.account_deletion_kept(uuid) from public, anon, authenticated;

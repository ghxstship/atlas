-- pgTAP: migration 0761. Every table of the 07xx range has a retention policy (ledgers by age, the rest by soft
-- delete), and hand-edited engagement and marketplace tables write the audit trail, with Restricted columns left
-- out of the diff.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

-- Every table of the 07xx range has a retention row ------------------------------------------------------------------
select is(
  (select coalesce(string_agg(t.rel, ', ' order by t.rel), '') from (values
     ('app.labor_agreements'), ('app.engagements'), ('app.engagement_state_transitions'), ('app.engagement_documents'),
     ('app.engagement_document_state_transitions'), ('app.account_memberships'), ('app.account_membership_roles'),
     ('app.representations'), ('app.representation_scopes'), ('app.profile_shares'), ('app.profile_share_fields'),
     ('app.onboarding_requirements'), ('app.onboarding_items'), ('app.onboarding_verifications'), ('app.tax_forms'),
     ('app.payout_accounts'), ('app.background_checks'), ('app.talent_pools'), ('app.pool_members'), ('app.opportunities'),
     ('app.opportunity_state_transitions'), ('app.opportunity_positions'), ('app.opportunity_requirements'),
     ('app.opportunity_questions'), ('app.opportunity_invitations'), ('app.listing_reports'), ('app.moderation_actions'),
     ('app.saved_searches'), ('app.opportunity_alerts'), ('app.applications'), ('app.application_state_transitions'),
     ('app.application_answers'), ('app.bids'), ('app.bid_lines'), ('app.agency_slates'), ('app.shortlists'),
     ('app.interviews'), ('app.ratings'), ('app.rating_replies'), ('app.engagement_threads'), ('app.engagement_messages'),
     ('app.availability_calendars'), ('app.availability_blocks'), ('app.engagement_cues')) t (rel)
   where not exists (select 1 from private.retention_policies r where r.table_name = t.rel)),
  '', 'every 07xx table has a retention policy');
select is((select basis::text from private.retention_policies where table_name = 'app.moderation_actions'), 'Age',
  'append-only moderation decisions are kept by age');
select is((select basis::text from private.retention_policies where table_name = 'app.engagements'), 'Soft Deleted',
  'engagements are kept by soft delete');
select is((select retention from private.retention_policies where table_name = 'app.saved_searches'), interval '1 year',
  'saved searches carry a one year period');
select is((select retention from private.retention_policies where table_name = 'app.tax_forms'), interval '7 years',
  'tax forms keep the 7 year default');

-- Audit trail ------------------------------------------------------------------------------------------------------------
select is(
  (select coalesce(string_agg(t.rel, ', ' order by t.rel), '') from (values
     ('engagements'), ('engagement_documents'), ('opportunities'), ('applications'), ('pool_members'), ('talent_pools'),
     ('shortlists'), ('interviews'), ('ratings'), ('onboarding_requirements'), ('tax_forms'), ('engagement_cues')) t (rel)
   where not exists (select 1 from pg_trigger g join pg_class c on c.oid = g.tgrelid join pg_namespace n on n.oid = c.relnamespace
                     where n.nspname = 'app' and c.relname = t.rel and g.tgname = 't85_audit_trail')),
  '', 'hand-edited engagement and marketplace tables carry the audit trail');

select pg_temp.as_user('carol');
update app.engagements set end_date = '2027-06-30' where id = pg_temp.id('eng_ivy_a');
select pg_temp.as_platform();
select ok(exists (select 1 from app.audit_events a where a.subject_table = 'app.engagements' and a.subject_id = pg_temp.id('eng_ivy_a')
  and a.actor_person_id = pg_temp.id('carol')), 'an engagement edit lands in the audit ledger with its actor');
select ok(not exists (select 1 from app.audit_events a where a.subject_table = 'app.engagements' and a.diff ? 'agreed_rate_minor'),
  'the Restricted agreed rate never enters an audit diff');

select * from finish();
rollback;

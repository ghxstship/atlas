-- 0761_engagement_retention_audit.sql
-- A28 Engagements and Marketplace (RRR-30). Carry-over from A18's retention framework (0550) and audit trail
-- (0501) for every table of the 07xx range:
--   * a retention policy for each table through private.install_default_retention: append-only ledgers by age of
--     created_at, other tables by soft delete, 7 years unless a shorter period is stated here
--   * the audit trail on the tables people change by hand, so every change lands in app.audit_events (Section
--     19.6); lifecycle moves are already written to their transition ledgers
-- Shorter periods: saved searches, alerts and availability carry no evidence value once deleted.

-- Retention --------------------------------------------------------------------------------------------------------

call private.install_default_retention('app.labor_agreements');
call private.install_default_retention('app.engagements');
call private.install_default_retention('app.engagement_state_transitions');
call private.install_default_retention('app.engagement_documents');
call private.install_default_retention('app.engagement_document_state_transitions');
call private.install_default_retention('app.account_memberships');
call private.install_default_retention('app.account_membership_roles');
call private.install_default_retention('app.representations');
call private.install_default_retention('app.representation_scopes');
call private.install_default_retention('app.profile_shares');
call private.install_default_retention('app.profile_share_fields');
call private.install_default_retention('app.onboarding_requirements');
call private.install_default_retention('app.onboarding_items');
call private.install_default_retention('app.onboarding_verifications');
call private.install_default_retention('app.tax_forms');
call private.install_default_retention('app.payout_accounts');
call private.install_default_retention('app.background_checks');
call private.install_default_retention('app.talent_pools');
call private.install_default_retention('app.pool_members');
call private.install_default_retention('app.opportunities');
call private.install_default_retention('app.opportunity_state_transitions');
call private.install_default_retention('app.opportunity_positions');
call private.install_default_retention('app.opportunity_requirements');
call private.install_default_retention('app.opportunity_questions');
call private.install_default_retention('app.opportunity_invitations');
call private.install_default_retention('app.listing_reports');
call private.install_default_retention('app.moderation_actions');
call private.install_default_retention('app.saved_searches', interval '1 year');
call private.install_default_retention('app.opportunity_alerts', interval '1 year');
call private.install_default_retention('app.applications');
call private.install_default_retention('app.application_state_transitions');
call private.install_default_retention('app.application_answers');
call private.install_default_retention('app.bids');
call private.install_default_retention('app.bid_lines');
call private.install_default_retention('app.agency_slates');
call private.install_default_retention('app.shortlists');
call private.install_default_retention('app.interviews');
call private.install_default_retention('app.ratings');
call private.install_default_retention('app.rating_replies');
call private.install_default_retention('app.engagement_threads');
call private.install_default_retention('app.engagement_messages');
call private.install_default_retention('app.availability_calendars', interval '1 year');
call private.install_default_retention('app.availability_blocks', interval '1 year');
call private.install_default_retention('app.engagement_cues');

-- Audit trail ------------------------------------------------------------------------------------------------------

call private.install_audit_trail('app.labor_agreements');
call private.install_audit_trail('app.engagements');
call private.install_audit_trail('app.engagement_documents');
call private.install_audit_trail('app.account_memberships');
call private.install_audit_trail('app.account_membership_roles');
call private.install_audit_trail('app.representations');
call private.install_audit_trail('app.representation_scopes');
call private.install_audit_trail('app.profile_shares');
call private.install_audit_trail('app.onboarding_requirements');
call private.install_audit_trail('app.onboarding_items');
call private.install_audit_trail('app.tax_forms');
call private.install_audit_trail('app.payout_accounts');
call private.install_audit_trail('app.background_checks');
call private.install_audit_trail('app.talent_pools');
call private.install_audit_trail('app.pool_members');
call private.install_audit_trail('app.opportunities');
call private.install_audit_trail('app.opportunity_positions');
call private.install_audit_trail('app.opportunity_requirements');
call private.install_audit_trail('app.opportunity_questions');
call private.install_audit_trail('app.opportunity_invitations');
call private.install_audit_trail('app.applications');
call private.install_audit_trail('app.shortlists');
call private.install_audit_trail('app.interviews');
call private.install_audit_trail('app.ratings');
call private.install_audit_trail('app.rating_replies');
call private.install_audit_trail('app.engagement_cues');

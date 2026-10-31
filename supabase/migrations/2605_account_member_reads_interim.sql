-- 2605_account_member_reads_interim.sql
-- RRR-209 interim fix (4.1 release plan, approved 2026-10-28). Under owner decision 6 an Account Member reaches only
-- the engagements assigned to them; until R4's app.account_engagement_assignments lands, they reach none of a supplied
-- person's per diems or lot movements through the tables.
--
--   * app.per_diems (read policy from 0981) and app.asset_lot_movements (read policy from 2602) read an engagement's
--     rows through private.my_engagement_ids('operational'), which opens the operational area to every Account Member
--     of the supplying account (private.engagement_party_areas, 0710). Both now keep only the engagements the
--     signed-in person answers for (private.engagement_principal, 2601): the engaged person, the supplying account's
--     Owner or Admin, and an Artist's Advance representative, while the operational area is open. This matches what
--     2601 did for api_external.per_diems.
--   * Every other branch is unchanged: org readers (crew.time_entry.read on the project; assets.asset.read in the org)
--     and the member's own rows (membership_id; custodian_membership_id).
--   * The narrowing filters the same set the policy read before, so it still runs once per query as a hashed subplan.
-- R4's assignment model replaces this file's account branch. No table becomes eligible for Trash (ADR 0110), and
-- this file adds no view.
-- Numbered in R1's block (ADR 0022), not the fix series at 2400: it must sort after 2601 (private.engagement_principal)
-- and 2602 (custodian_engagement_id and the lot policy it narrows), and before R4 (2630), whose file replaces it.

-- Per diems --------------------------------------------------------------------------------------------------------------

drop policy per_diems_read on app.per_diems;
create policy per_diems_read on app.per_diems for select to authenticated using (
  project_id in (select private.project_ids_with('crew.time_entry.read'))
    or membership_id in (select private.my_membership_ids())
    or engagement_id in (select m.id from private.my_engagement_ids('operational') as m (id) where private.engagement_principal(m.id)));

comment on policy per_diems_read on app.per_diems is 'Per diems of projects where the person may read time entries, their own as a member, and those of engagements they answer for while the operational area is open: their own, those of the people their account supplies for its Owner and Admin, and an artist''s for the Advance representative. Interim narrowing for RRR-209 (2605): an Account Member reads none of another person''s. R4''s account engagement assignments replace the account branch.';

-- Lot movements ----------------------------------------------------------------------------------------------------------

drop policy asset_lot_movements_read on app.asset_lot_movements;
create policy asset_lot_movements_read on app.asset_lot_movements for select to authenticated using (
  org_id in (select private.orgs_with_capability('assets.asset.read'))
  or custodian_membership_id in (select private.my_membership_ids())
  or custodian_engagement_id in (select m.id from private.my_engagement_ids('operational') as m (id) where private.engagement_principal(m.id)));

comment on policy asset_lot_movements_read on app.asset_lot_movements is 'Lot movements of orgs where the person may read assets, those made to them as a member, and those made to engagements they answer for while the operational area is open: their own, those of the people their account supplies for its Owner and Admin, and an artist''s for the Advance representative. Interim narrowing for RRR-209 (2605): an Account Member reads none of another person''s. R4''s account engagement assignments replace the account branch.';

-- Grants -----------------------------------------------------------------------------------------------------------------
-- Recreating a policy keeps the table's privileges; restated so this file reads whole (0300's install_domain_table and
-- install_policies). The lot ledger is append-only for signed-in users: they write it through app.apply_asset_scan.

revoke all on app.per_diems, app.asset_lot_movements from public, anon;
grant select, insert, update on app.per_diems to authenticated;
grant select on app.asset_lot_movements to authenticated;
grant all on app.per_diems, app.asset_lot_movements to service_role;

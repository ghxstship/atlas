-- 1221_advisor_fixes.sql
-- A54 (RRR-99), Section 18 gate 11: the Supabase database advisors (`supabase db advisors`, run by
-- infra/security/supabase-advisors.sh) report no errors, and these were the warnings:
--
-- duplicate_index: 0638 created `identity_providers_org_idx` and `organization_verification_requests_org_idx`, and
-- private.install_domain_table adds the same index on org_id under its own name (`<table>_org_id_idx`). The 0638
-- copies are dropped; the convention's index stays.
--
-- multiple_permissive_policies: four tables had a second permissive select policy for authenticated, so Postgres
-- evaluated both on every row read. Each pair is folded into the table's `<table>_read` policy as one expression
-- (the two halves joined by or), which admits exactly the rows either policy admitted:
-- - app.shifts: published open shifts visible at any reach of crew.shift.read (0462);
-- - app.support_tickets, app.support_ticket_messages, app.support_ticket_state_transitions: the help desk teams the
--   person belongs to (0805).

drop index app.identity_providers_org_idx;
drop index app.organization_verification_requests_org_idx;

alter policy shifts_read on app.shifts using (
  (project_id in (select private.project_ids_with('crew.shift.read')))
  or (membership_id in (select private.my_membership_ids()))
  or (engagement_id in (select private.my_engagement_ids('operational')))
  or (membership_id is null and shift_state = 'Published' and deleted_at is null
      and private.capability_reach(org_id, 'crew.shift.read') is not null)
);
drop policy shifts_open_read on app.shifts;
comment on policy shifts_read on app.shifts is 'Shifts of projects where the person may read shifts, their own shifts and engaged shifts, and published open shifts for every member who may read shifts at any reach, so crew can claim them (0462, folded in by 1221).';

alter policy support_tickets_read on app.support_tickets using (
  private.can_read_support_ticket(org_id, membership_id)
  or help_desk_team_id = any (array(select private.my_help_desk_team_ids()))
);
drop policy support_tickets_help_desk_read on app.support_tickets;

alter policy support_ticket_messages_read on app.support_ticket_messages using (
  support_ticket_id in (select private.readable_support_ticket_ids())
  or support_ticket_id in (select private.help_desk_ticket_ids())
);
drop policy support_ticket_messages_help_desk_read on app.support_ticket_messages;

alter policy support_ticket_state_transitions_read on app.support_ticket_state_transitions using (
  support_ticket_id in (select private.readable_support_ticket_ids())
  or support_ticket_id in (select private.help_desk_ticket_ids())
);
drop policy support_ticket_state_transitions_help_desk_read on app.support_ticket_state_transitions;

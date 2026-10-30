-- 2872_budget_line_custom_fields.sql
-- P10 (RRR-224), gap G-217, Section 4.5.6 org settings item 16 and Section 4.6.3: budget lines become the tenth built-in
-- table an org may add custom fields to, so a line carries the org's own tags (for example a Choice field Tag with
-- Rental, Overtime and Client billable, marked filterable) and the budget grid filters by them (A117's filter builder).
-- The custom field machinery covers the rest unchanged:
--   * app.budget_lines has id and org_id (0320), which private.guard_custom_field_value (0540, 2110) checks
--   * values are read through private.custom_field_target_visible, which runs as the caller under the budget lines'
--     own policy (finance.budget.read on the budget's project, 0320)
--   * values are written by the Collaborator band or higher on a line the writer reads (private.custom_writer_orgs,
--     ADR 0076 decision 4): tags annotate a line and never change an amount
--   * a filterable field gets its partial index from private.sync_filterable_index, and app.custom_field_targets
--     (1433) lists the new target to Settings
-- No new data type: a multi-select tag type is out of scope. Trash membership of budget lines does not change, so no
-- private.sync_trash_tables call is needed.

insert into private.custom_field_targets (table_name) values ('app.budget_lines') on conflict do nothing;

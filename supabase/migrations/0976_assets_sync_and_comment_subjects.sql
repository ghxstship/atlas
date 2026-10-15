-- 0976_assets_sync_and_comment_subjects.sql
-- A12 Assets (RRR-24), late slot. Runs after A03F's sync allowlist (0364), A18's comment subjects
-- (0580) and this module's scan RPC (0975):
--   1. Compass replays scan events offline through app.apply_sync_mutation, so app.apply_asset_scan
--      joins the allowlist. Its own event id keeps a replay idempotent even past the sync window.
--   2. Asset classes, lots, maintenance and damage carry comments and attachments like units do
--      (0580 already lists app.asset_units).

insert into private.sync_rpcs (rpc, description) values
  ('app.apply_asset_scan', 'A field person checks a scanned asset or lot out, in or across; replays are idempotent on the scan event id.')
on conflict (rpc) do nothing;

insert into private.comment_subjects (table_name) values
  ('app.asset_classes'),
  ('app.asset_lots'),
  ('app.asset_maintenance'),
  ('app.asset_damage')
on conflict (table_name) do nothing;

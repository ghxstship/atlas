-- 1171_kiosk_device_upkeep.sql
-- A50 gate 5 handlers (RRR-94, ADR 0032). Kiosks (0340) could be registered (app.register_kiosk_device) but
-- never renamed, moved to another project or retired: app.kiosk_devices had a read policy only, so a lost or
-- stolen tablet kept its device key. This adds the update policy for org.time_attendance.write, the capability
-- that registers kiosks, limited by column grants to:
--   * name and project_id, to rename a kiosk or move it to another project of the org
--   * deleted_at, to retire it: private.verify_kiosk_pin already refuses a deleted kiosk, so its key stops working
-- The key hash, last_seen_at and revoked_at stay out of reach; tenant guards keep org_id fixed and the project
-- inside the org.

call private.install_policies('app.kiosk_devices',
  $$org_id in (select private.orgs_with_capability('org.time_attendance.write'))$$,
  null,
  $$org_id in (select private.orgs_with_capability('org.time_attendance.write'))$$);

revoke update on app.kiosk_devices from authenticated;
grant update (name, project_id, deleted_at) on app.kiosk_devices to authenticated;

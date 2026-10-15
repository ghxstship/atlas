-- 0971_operations_comment_subjects_travel_engagements.sql
-- A11 late slot (0970 to 0974), for references to later ranges:
--   * comments and attachments (A18, 0580 and 0590) on the logistics and hospitality records Atlas opens
--     as a peek or full page; app.shipments is already a subject;
--   * travel_segments.engagement_id, so Gateway's crew and artist travel tabs (A28b) read the segments of
--     the caller's own engagement. Lives here because app.engagements is created in 0700.

insert into private.comment_subjects (table_name) values
  ('app.dock_slots'),
  ('app.fulfillments'),
  ('app.beos'),
  ('app.accommodation_blocks'),
  ('app.travel_segments')
on conflict (table_name) do nothing;

alter table app.travel_segments add column engagement_id uuid references app.engagements (id);
create index travel_segments_engagement_id_idx on app.travel_segments (engagement_id);
comment on column app.travel_segments.engagement_id is 'Engagement of the same project the traveler travels under, when the traveler is an external party.';

drop trigger if exists t30_refuse_cross_org_reference on app.travel_segments;
create trigger t30_refuse_cross_org_reference before insert or update on app.travel_segments
  for each row execute function private.refuse_cross_org_reference(
    'app.fulfillments', 'fulfillment_id', 'app.engagements', 'engagement_id');
create trigger t39_travel_segment_engagement_project before insert or update on app.travel_segments
  for each row execute function private.assert_same_project('app.engagements', 'engagement_id');

drop trigger if exists t90_emit_travel_created on app.travel_segments;
create trigger t90_emit_travel_created after insert on app.travel_segments
  for each row execute function private.emit_row_event('travel_segment.created', 'project_id', 'person_id', 'engagement_id', 'travel_mode', 'departs_at');

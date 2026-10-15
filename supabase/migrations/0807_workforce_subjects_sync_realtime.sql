-- 0807_workforce_subjects_sync_realtime.sql
-- A29 Workforce Suite wiring into the platform:
--   1. Comments and attachments (A18, 0580 and 0590): group spaces carry files, chat messages carry photos,
--      files and voice notes, and events, form submissions, handbook articles and lost items carry
--      comments and photos. Feed posts joined in 0801.
--   2. Offline replay (A03F, 0364): Compass queues these RPCs offline and replays them through
--      app.apply_sync_mutation, which stores each result so a replay never acts twice.
--   3. Realtime: chat, the feed, occupancy counters and weather alerts update live. Row level security
--      still filters every change a subscriber receives.

insert into private.comment_subjects (table_name) values
  ('app.groups'),
  ('app.chat_messages'),
  ('app.workforce_events'),
  ('app.form_submissions'),
  ('app.handbook_articles'),
  ('app.lost_found_items')
on conflict (table_name) do nothing;

insert into private.sync_rpcs (rpc, description) values
  ('app.send_chat_message', 'A member sends a chat message queued while offline.'),
  ('app.mark_conversation_read', 'A member marks a conversation read while offline.'),
  ('app.acknowledge_feed_post', 'A member acknowledges a feed post that requires it.'),
  ('app.react_to_feed_post', 'A member reacts to a feed post.'),
  ('app.vote_in_poll', 'A member votes in a feed poll.'),
  ('app.respond_to_survey', 'A member responds to a pulse survey.'),
  ('app.rsvp_to_event', 'A member answers an event invitation.'),
  ('app.check_in_to_event', 'An attendee checks in to a briefing, crew call or meeting.'),
  ('app.submit_form', 'A field person submits a form filled in offline, with photos, GPS stamp and signature.'),
  ('app.complete_training_lesson', 'A learner finishes a reading or video lesson offline.'),
  ('app.acknowledge_handbook_article', 'A member acknowledges a mandatory handbook article read offline.'),
  ('app.recognize', 'A member recognizes a colleague.'),
  ('app.record_occupancy_count', 'Door staff count people in or out of a space.'),
  ('app.record_weather_reading', 'A field person records a wind, lightning or heat reading.'),
  ('app.check_in_guest', 'Door staff check in an approved guest with plus-ones.'),
  ('app.log_lost_item', 'A field person logs a found item.')
on conflict (rpc) do nothing;

do $$
declare
  v_table text;
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    foreach v_table in array array['chat_messages', 'conversation_members', 'feed_posts', 'occupancy_counters', 'weather_alerts'] loop
      if not exists (select 1 from pg_catalog.pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'app' and tablename = v_table) then
        execute format('alter publication supabase_realtime add table app.%I', v_table);
      end if;
    end loop;
  end if;
end;
$$;

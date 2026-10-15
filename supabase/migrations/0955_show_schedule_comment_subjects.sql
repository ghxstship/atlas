-- 0955_show_schedule_comment_subjects.sql
-- A08 late slot (ADR 0022, 0955 to 0959). Running orders, day sheets, call sheets and schedule
-- baselines carry comments and attachments (A18, 0580 and 0590). Records, work orders and punch
-- items were registered by 0580.

insert into private.comment_subjects (table_name) values
  ('app.run_of_show'),
  ('app.day_sheets'),
  ('app.call_sheets'),
  ('app.schedule_baselines')
on conflict (table_name) do nothing;

-- 0986_credentials_comment_subjects.sql
-- A14 late slot: comments and attachments (A18 0580 and 0590, after the A14 main range) on credential
-- categories, issued credentials, crisis alerts and radio channels. Incidents are already subjects.

insert into private.comment_subjects (table_name) values
  ('app.credential_categories'),
  ('app.credentials'),
  ('app.crisis_alerts'),
  ('app.radio_channels')
on conflict (table_name) do nothing;

-- 0960_places_safety_comment_subjects.sql
-- A09 late slot (ADR 0022). Makes the remaining Places and Safety tables commentable and attachable
-- through A18's unified comments (0580) and attachments (0590). Venues and inspections are already
-- subjects. Access follows each table's own read policy through private.can_read_subject.

insert into private.comment_subjects (table_name) values
  ('app.spaces'),
  ('app.zones'),
  ('app.capability_documents'),
  ('app.site_plans'),
  ('app.permit_requirements'),
  ('app.inspection_templates'),
  ('app.capability_statements')
on conflict (table_name) do nothing;

-- pgTAP: 1750, custom object record activity (A114, RRR-159, Section 4.6.3). A custom object record is a comment and
-- attachment subject whose files the attachments bucket serves to its readers only; it has an audit trail that also
-- carries its value changes, a field history, and created, updated and deleted events that webhooks and automations
-- see.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(29);

create temporary table k (key text primary key, id uuid, val text);
grant select, insert on k to public;

-- An object with a Choice and a Text field, as 0540 defines one.
select pg_temp.as_user('bob');
insert into app.custom_object_types (org_id, object_key, label, icon) values (pg_temp.id('org_a'), 'props', 'Props', 'box');
insert into k (key, id) select 'type', id from app.custom_object_types where object_key = 'props';
insert into app.custom_object_fields (custom_object_type_id, field_key, label, data_type, sort_order) values
  ((select id from k where key = 'type'), 'status', 'Status', 'Choice', 1),
  ((select id from k where key = 'type'), 'notes', 'Notes', 'Text', 2);
insert into k (key, id) select field_key, id from app.custom_object_fields where custom_object_type_id = (select id from k where key = 'type');
insert into app.custom_object_field_choices (custom_object_field_id, choice_key, label, sort_order) values
  ((select id from k where key = 'status'), 'requested', 'Requested', 1),
  ((select id from k where key = 'status'), 'built', 'Built', 2);
insert into k (key, id) select choice_key, id from app.custom_object_field_choices
where custom_object_field_id = (select id from k where key = 'status');

select pg_temp.as_user('dave');
insert into app.custom_object_records (custom_object_type_id, title) values ((select id from k where key = 'type'), 'Breakaway table');
insert into k (key, id) select 'rec', id from app.custom_object_records where title = 'Breakaway table';

-- Comment and attachment subject, and its storage policy -------------------------------------------------------------------
select pg_temp.as_platform();
select ok(exists (select 1 from private.comment_subjects where table_name = 'app.custom_object_records'),
  'custom object records are a comment and attachment subject');

select pg_temp.as_user('dave');
insert into k select 'v1', attachment_version_id, object_name
from app.begin_attachment_upload('app.custom_object_records', (select id from k where key = 'rec'), 'cut-list.pdf', 'application/pdf', 1200);
select is((select a.org_id from app.attachments a join app.attachment_versions v on v.attachment_id = a.id where v.id = (select id from k where key = 'v1')),
  pg_temp.id('org_a'), 'a file attaches to a custom object record, in the record''s org');
select lives_ok($$insert into storage.objects (bucket_id, name, metadata) values ('attachments', (select val from k where key = 'v1'), '{"size": 1200}')$$,
  'the uploader writes the issued object name');
select app.complete_attachment_upload((select id from k where key = 'v1'), repeat('ab', 32));
select pg_temp.as_user('xavier');
select throws_ok($$select app.begin_attachment_upload('app.custom_object_records', (select id from k where key = 'rec'), 'x.pdf', 'application/pdf', 10)$$,
  '42501', null, 'another org attaches nothing to the record');
select pg_temp.as_user('gina');
select is((select count(*)::integer from storage.objects where bucket_id = 'attachments' and name = (select val from k where key = 'v1')), 0,
  'an unscanned file on the record cannot be downloaded');
select pg_temp.as_platform();
select app.record_attachment_scan((select id from k where key = 'v1'), true);
select pg_temp.as_user('gina');
select is((select count(*)::integer from storage.objects where bucket_id = 'attachments' and name = (select val from k where key = 'v1')), 1,
  'a member who reads the record downloads its clean file');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from storage.objects where bucket_id = 'attachments' and name = (select val from k where key = 'v1'))
  + (select count(*)::integer from app.attachments where subject_id = (select id from k where key = 'rec')), 0,
  'another org sees neither the file nor the attachment');
select pg_temp.as_user('dave');
select lives_ok($$select app.post_comment('app.custom_object_records', (select id from k where key = 'rec'), 'Needs a second coat.')$$,
  'a member comments on the record');

-- Audit trail: the record and its values -------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is((select count(*)::integer from pg_trigger where tgrelid = 'app.custom_object_records'::regclass and tgname = 't85_audit_trail'), 1,
  'custom object records have an audit trail');
select is((select count(*)::integer from app.audit_events where subject_id = (select id from k where key = 'rec') and action = 'custom_object_records.insert'), 1,
  'the record''s creation is in the ledger');

select pg_temp.as_user('dave');
insert into app.custom_object_values (custom_object_record_id, custom_object_field_id, value_choice_id, value_text)
select (select id from k where key = 'rec'), f.id, case when f.field_key = 'status' then (select id from k where key = 'requested') end,
       case when f.field_key = 'notes' then 'Sugar glass top' end
from app.custom_object_fields f where f.custom_object_type_id = (select id from k where key = 'type');
update app.custom_object_values set value_choice_id = (select id from k where key = 'built')
where custom_object_field_id = (select id from k where key = 'status');
update app.custom_object_values set value_text = 'Sugar glass top' where custom_object_field_id = (select id from k where key = 'notes');
update app.custom_object_records set title = 'Breakaway table, large' where id = (select id from k where key = 'rec');

select pg_temp.as_platform();
select is((select count(*)::integer from app.audit_events where subject_id = (select id from k where key = 'rec') and action = 'custom_object_records.update'), 3,
  'one update per write: both values set together, the status changed, the title changed; an unchanged value writes nothing');
select is((select diff -> 'new' from app.audit_events where subject_id = (select id from k where key = 'rec') and action = 'custom_object_records.update'
           and diff -> 'new' ? 'values.notes'),
  jsonb_build_object('values.notes', 'Sugar glass top', 'values.status', (select id from k where key = 'requested')),
  'values written together are one entry, each keyed by its field');
select is((select count(*)::integer from app.audit_events where subject_table = 'app.custom_object_values'), 0,
  'values have no trail of their own: their changes are the record''s');

-- Field history -------------------------------------------------------------------------------------------------------------
select ok(exists (select 1 from private.field_history_subjects where table_name = 'app.custom_object_records'),
  'custom object records are in the field history registry');
select pg_temp.as_user('gina');
create temporary table history as select * from app.field_history('app.custom_object_records', (select id from k where key = 'rec'));
grant select on history to public;
select is((select count(*)::integer from history where operation = 'insert'), 1, 'the history starts with the creation');
select results_eq($$select old_value #>> '{}', new_value #>> '{}' from history where field = 'values.status' order by changed_at, old_value nulls first$$,
  $$values (null::text, (select id from k where key = 'requested')::text), ((select id from k where key = 'requested')::text, (select id from k where key = 'built')::text)$$,
  'a value''s changes show in the record''s history, oldest first here');
select is((select new_value #>> '{}' from history where field = 'title'), 'Breakaway table, large', 'and so does the title');
select is((select actor_name from history where field = 'title'), 'Dave Lindqvist', 'each change names the person who made it');
select pg_temp.as_user('xavier');
select throws_ok($$select * from app.field_history('app.custom_object_records', (select id from k where key = 'rec'))$$, '42501', null,
  'another org reads no history of the record');

-- Domain events ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select results_eq($$select code, subject from private.domain_event_types where code like 'custom_object_record.%' order by code$$,
  $$values ('custom_object_record.created'::text, 'custom_object_records'::text), ('custom_object_record.deleted', 'custom_object_records'),
    ('custom_object_record.updated', 'custom_object_records')$$, 'the catalog has the three record events');
select is((select data from app.domain_events where event_type = 'custom_object_record.created' and subject_id = (select id from k where key = 'rec')),
  jsonb_build_object('object_key', 'props', 'custom_object_type_id', (select id from k where key = 'type'), 'title', 'Breakaway table'),
  'a new record emits created with its object key, type and title');
select results_eq($$select data -> 'changed' from app.domain_events where event_type = 'custom_object_record.updated'
    and subject_id = (select id from k where key = 'rec') order by data ->> 'changed'$$,
  $$values ('["title"]'::jsonb), ('["values.notes", "values.status"]'::jsonb), ('["values.status"]'::jsonb)$$,
  'each write emits one updated event naming what changed');
select is((select count(*)::integer from app.domain_events where subject_table = 'custom_object_records' and project_id is not null), 0,
  'record events belong to no project');

select pg_temp.as_user('dave');
update app.custom_object_records set deleted_at = now() where id = (select id from k where key = 'rec');
update app.custom_object_values set value_choice_id = (select id from k where key = 'requested')
where custom_object_field_id = (select id from k where key = 'status');
select pg_temp.as_platform();
select is((select count(*)::integer from app.domain_events where event_type = 'custom_object_record.deleted' and subject_id = (select id from k where key = 'rec')), 1,
  'moving the record to Trash emits deleted');
select is((select count(*)::integer from app.domain_events where event_type = 'custom_object_record.updated' and subject_id = (select id from k where key = 'rec')), 3,
  'a record in Trash emits no updated event');
select is((select count(*)::integer from app.audit_events where subject_id = (select id from k where key = 'rec') and action = 'custom_object_records.update'), 5,
  'but its trail still records the move to Trash and the value change');

-- Webhooks and automations see them ----------------------------------------------------------------------------------------
select is(private.automation_trigger_subject('custom_object_record.updated'), 'custom_object_records',
  'automations read the record events'' subject from the catalog');
select lives_ok($$select private.check_automation_actions(pg_temp.id('org_a'), 'custom_object_record.created',
  '[{"type": "add_comment", "body": "Check the build."}]'::jsonb)$$,
  'an automation on a record event may comment on the record');
select pg_temp.as_user('alice');
select is((select count(*)::integer from app.domain_event_catalog where code like 'custom_object_record.%'), 3,
  'webhook endpoints subscribe to them from the event catalog');

select * from finish();
rollback;

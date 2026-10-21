-- pgTAP: migration 1411, the project inbox surface (A84, RRR-129, finding A65-018, Section 4.6.5). One live address per
-- project that can be replaced or disabled but never edited; verified mail filed as a Document record of the project,
-- optionally to one of its records, with the mail posted as a comment; discarding with who, when and why; both once,
-- by people who file documents on the project, with the audit ledger recording each.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(31);

create temporary table k (key text primary key, id uuid, val text);
grant select, insert, update on k to public;

create function pg_temp.receive(p_local text, p_message_id text, p_dkim boolean default true) returns uuid
language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.as_platform();
  v := app.receive_inbound_email(p_local, 'Rigging@Bayside-Audio.test', 'Rigging plot v4', p_message_id, p_dkim,
    'Updated plot attached. Load in moves to 07:00.', 'raw/' || p_message_id || '.eml');
  return v;
end $$;

-- Addresses ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select throws_ok($$select app.create_project_inbox(pg_temp.id('prj_a'))$$, '42501', null,
  'only people who change project settings create its inbox');
select pg_temp.as_user('bob');
insert into k (key, val) values ('local1', app.create_project_inbox(pg_temp.id('prj_a')));
select ok((select val ~ '^nwl-[0-9a-f]{10}$' from k where key = 'local1'), 'an inbox address is the project key and a random suffix');
select is(app.create_project_inbox(pg_temp.id('prj_a')), (select val from k where key = 'local1'), 'asking again returns the live address');
select throws_ok($$update app.inbound_addresses set local_part = 'nwl-vanity'$$, '42501', null, 'nobody edits an address');
insert into k (key, val) values ('local2', app.replace_project_inbox(pg_temp.id('prj_a')));
select isnt((select val from k where key = 'local2'), (select val from k where key = 'local1'), 'replacing issues a new address');
select is((select count(*)::integer from app.inbound_addresses where project_id = pg_temp.id('prj_a') and disabled_at is null), 1,
  'a project has one live address');
select throws_ok($$update app.inbound_addresses set disabled_at = null$$, 'XR001', null, 'a disabled address stays disabled');
select is(pg_temp.receive((select val from k where key = 'local1'), '<old@bayside-audio.test>'), null::uuid,
  'mail to a replaced address is not accepted');
insert into k (key, id) values ('verified', pg_temp.receive((select val from k where key = 'local2'), '<m1@bayside-audio.test>'));
insert into k (key, id) values ('unverified', pg_temp.receive((select val from k where key = 'local2'), '<m2@bayside-audio.test>', false));
insert into k (key, id) values ('second', pg_temp.receive((select val from k where key = 'local2'), '<m3@bayside-audio.test>'));
select ok((select count(*) = 3 and bool_and(id is not null) from k where key in ('verified', 'unverified', 'second')),
  'mail to the live address lands in the inbox');

-- Records to file to: one on the inbox's project, one on another project ----------------------------------------------------
select pg_temp.as_platform();
insert into app.records (project_id, record_kind, title, xyz, xyz_basis) values
  (pg_temp.id('prj_a'), 'Task', 'Hang the rigging plot', 'Y', 'Declared');
insert into k (key, id) select 'record', id from app.records where title = 'Hang the rigging plot';
insert into app.records (project_id, record_kind, title, xyz, xyz_basis) values
  (pg_temp.id('prj_a2'), 'Task', 'Hang the gala banner', 'Y', 'Declared');
insert into k (key, id) select 'other_record', id from app.records where title = 'Hang the gala banner';

-- Who sees the inbox ----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select is((select count(*)::integer from app.inbound_messages), 0, 'a field member who files no documents sees no inbox mail');
select throws_ok(format($$select app.file_inbound_message('%s')$$, (select id from k where key = 'verified')), '42501', null,
  'and cannot file it');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.inbound_messages), 0, 'no cross-tenant inbox reads');
select throws_ok(format($$select app.discard_inbound_message('%s')$$, (select id from k where key = 'verified')), '42501', null,
  'no cross-tenant discards');

-- Filing ------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is((select count(*)::integer from app.inbound_messages), 3, 'a coordinator who files documents on the project sees its inbox');
select throws_ok(format($$select app.file_inbound_message('%s', null, '%s')$$, (select id from k where key = 'verified'),
  (select id from k where key = 'other_record')), 'XR001', null, 'mail is never filed to another project''s record');
update k set val = app.file_inbound_message((select id from k where key = 'verified'), null, (select id from k where key = 'record'))::text
where key = 'verified';
select is((select title from app.documents where id = (select val from k where key = 'verified')::uuid), 'Rigging plot v4',
  'filing makes a Document record titled by the subject');
select is((select project_id from app.documents where id = (select val from k where key = 'verified')::uuid), pg_temp.id('prj_a'),
  'the document belongs to the inbox''s project');
select is((select inbound_status::text || ' ' || filed_by::text from app.inbound_messages where id = (select id from k where key = 'verified')),
  'Filed ' || pg_temp.id('dave')::text, 'the mail is Filed, and the database names who filed it');
select is((select filed_record_id from app.inbound_messages where id = (select id from k where key = 'verified')), (select id from k where key = 'record'),
  'the mail remembers the record it was filed to');
select ok((select bool_and(c.body like 'Rigging plot v4' || chr(10) || 'rigging@bayside-audio.test%Load in moves to 07:00.')
           and count(*) = 2
           and bool_and(c.author_person_id = pg_temp.id('dave'))
           from app.comments c join app.comment_threads t on t.id = c.comment_thread_id
           where (t.subject_table = 'app.documents' and t.subject_id = (select val from k where key = 'verified')::uuid)
              or (t.subject_table = 'app.records' and t.subject_id = (select id from k where key = 'record'))),
  'the subject, sender and text are posted on the document and on the record');
select throws_ok(format($$select app.file_inbound_message('%s')$$, (select id from k where key = 'verified')), 'XR001', null,
  'filed mail is filed once');
select throws_ok(format($$select app.discard_inbound_message('%s')$$, (select id from k where key = 'verified')), 'XR001', null,
  'filed mail cannot be discarded');
select is(app.file_inbound_message((select id from k where key = 'second'), 'Rigging plot, venue copy') is not null, true,
  'mail can be filed under a title of the coordinator''s choosing, to no record');
select is((select count(*)::integer from app.documents where title = 'Rigging plot, venue copy'), 1, 'and the document takes that title');

-- Unverified mail and discarding ------------------------------------------------------------------------------------------------
select throws_ok(format($$select app.file_inbound_message('%s')$$, (select id from k where key = 'unverified')), 'XR001', null,
  'mail whose sender did not verify is never filed');
select throws_ok(format($$update app.inbound_messages set discarded_by = '%s' where id = '%s'$$, pg_temp.id('erin'),
  (select id from k where key = 'unverified')), 'XR001', null, 'nobody writes who discarded mail');
select app.discard_inbound_message((select id from k where key = 'unverified'), '  Spoofed sender.  ');
select is((select discard_reason || ' ' || discarded_by::text from app.inbound_messages where id = (select id from k where key = 'unverified')),
  'Spoofed sender. ' || pg_temp.id('dave')::text, 'discarding keeps the mail with the reason and who discarded it');
select throws_ok(format($$select app.discard_inbound_message('%s')$$, (select id from k where key = 'unverified')), 'XR001', null,
  'discarded mail stays discarded');

-- Audit and disabling -----------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is((select count(*)::integer from app.audit_events where subject_table = 'app.inbound_messages'), 3,
  'the audit ledger records each filing and discard, and never the mail itself on arrival');
select ok((select count(*) from app.audit_events where subject_table = 'app.inbound_addresses') >= 3,
  'the audit ledger records each address created and disabled');
select pg_temp.as_user('bob');
select app.disable_project_inbox(pg_temp.id('prj_a'));
select is(pg_temp.receive((select val from k where key = 'local2'), '<late@bayside-audio.test>'), null::uuid,
  'a disabled inbox accepts no more mail');

select * from finish();
rollback;

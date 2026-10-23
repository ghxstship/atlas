-- pgTAP: migration 1396, numbering.document_number_padding pads document numbers and never cuts them (RRR-121,
-- audit of A76). A number longer than the padding keeps every digit, so invoices and certificates stay unique, and a
-- padding below four still numbers training certificates.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(8);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

-- A padding of 1: the tenth number is 10, not 1 again -------------------------------------------------------------
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'numbering.document_number_padding', 'Organization', pg_temp.id('org_a'), p_value_integer => 1);
select pg_temp.as_platform();
insert into private.key_sequences (org_id, sequence_name, last_value) values (pg_temp.id('org_a'), 'training_certificate', 9)
on conflict (org_id, sequence_name) do update set last_value = 9;
select is(private.document_number(pg_temp.id('org_a'), 'TRN-', 'training_certificate'), 'TRN-10',
  'a number longer than the padding keeps every digit');

-- A passing course at a padding of 1 gets its certificate -------------------------------------------------------------
select pg_temp.as_user('carol');
with c as (insert into app.training_courses (org_id, title, summary, pass_percent)
  values (pg_temp.id('org_a'), 'Venue orientation', 'Exits, muster points and radio channels.', 50) returning id)
insert into k select 'course', id from c;
with l as (insert into app.training_lessons (training_course_id, position, title, lesson_kind, body)
  values ((select id from k where key = 'course'), 1, 'Exits', 'Reading', 'Know the two nearest exits from your post.') returning id)
insert into k select 'reading', id from l;
select app.publish_training_course((select id from k where key = 'course'));
select pg_temp.as_user('frank');
select app.complete_training_lesson((select id from k where key = 'reading'));
select lives_ok($$insert into k select 'pass1', app.complete_training((select id from k where key = 'course'), '{}'::jsonb)$$,
  'a learner passes a course while the padding is 1');
select is((select certificate_number from app.training_completions where id = (select id from k where key = 'pass1')), 'TRN-11',
  'and the certificate number keeps every digit');
select pg_temp.as_user('dave');
select app.complete_training_lesson((select id from k where key = 'reading'));
select lives_ok($$insert into k select 'pass2', app.complete_training((select id from k where key = 'course'), '{}'::jsonb)$$,
  'the next learner passes too');
select is((select certificate_number from app.training_completions where id = (select id from k where key = 'pass2')), 'TRN-12',
  'with the next number, never a repeat');

-- The default padding of 4: invoice 10000 is not a second INV-1000 ---------------------------------------------------
select pg_temp.as_user('alice');
select app.clear_setting(pg_temp.id('org_a'), 'numbering.document_number_padding', 'Organization', pg_temp.id('org_a'));
insert into world values ('cp_client', app.create_counterparty(pg_temp.id('org_a'), 'Lakeshore Brands', null));
select pg_temp.as_platform();
insert into private.key_sequences (org_id, sequence_name, last_value) values (pg_temp.id('org_a'), 'invoice', 999)
on conflict (org_id, sequence_name) do update set last_value = 999;
with x as (insert into app.invoices (project_id, direction, counterparty_id, currency_code) values (pg_temp.id('prj_a'), 'Receivable', pg_temp.id('cp_client'), 'USD') returning id)
insert into world select 'inv1000', id from x;
select is((select invoice_number from app.invoices where id = pg_temp.id('inv1000')), 'INV-1000', 'invoice 1000 fills the default padding');
update private.key_sequences set last_value = 9999 where org_id = pg_temp.id('org_a') and sequence_name = 'invoice';
select lives_ok($$with x as (insert into app.invoices (project_id, direction, counterparty_id, currency_code) values ((select id from world where key = 'prj_a'), 'Receivable', (select id from world where key = 'cp_client'), 'USD') returning id)
  insert into world select 'inv10000', id from x$$, 'invoice 10000 for the same client is created');
select is((select invoice_number from app.invoices where id = pg_temp.id('inv10000')), 'INV-10000', 'and numbered INV-10000');

select * from finish();
rollback;

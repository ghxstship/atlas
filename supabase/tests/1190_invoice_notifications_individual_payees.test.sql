-- pgTAP (orchestrator, integration of A43 and A44): an individual payee is notified of their invoice's steps.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(3);

create function pg_temp.kinds(p_person text) returns text
language sql as $$
  select coalesce(string_agg(n.kind, ',' order by n.kind), '') from app.notifications n
  where n.recipient_person_id = pg_temp.id(p_person) and n.subject_table = 'invoices'
$$;

select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.as_user('ivy');
with i as (select app.submit_engagement_invoice(pg_temp.id('eng_ivy_a'), 'IV-1190', '2027-06-05', '2027-07-05', 'USD',
  '[{"description": "Rigging day", "quantity": 1, "unit_price_minor": 99000}]'::jsonb) as id)
  insert into world select 'inv', id from i;
select pg_temp.as_platform();

select is((select payee_person_id from app.invoices where id = pg_temp.id('inv')), pg_temp.id('ivy'),
  'the individual is the invoice payee, with no account');
select is(pg_temp.kinds('ivy'), 'invoice.submitted', 'the individual payee is notified the invoice was submitted');
select is((select message_args ->> 'title' from app.notifications where recipient_person_id = pg_temp.id('ivy') and subject_table = 'invoices'),
  'IV-1190', 'the notification carries the invoice number');

select * from finish();
rollback;

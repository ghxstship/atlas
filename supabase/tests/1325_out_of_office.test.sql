-- pgTAP: migration 1325, Out of Office takes effect (A76, RRR-121, A65-001). A person is away while
-- me.out_of_office.enabled is on and today falls between me.out_of_office.starts_on and ends_on. A direct message to
-- them gets their me.out_of_office.auto_reply once for the time away, marked automatic; group conversations and people
-- who are in get none. While an approver is away, their delegate may decide their approval steps and is notified
-- instead; back in, the delegate no longer may.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(16);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

-- Away ---------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is(private.person_away(pg_temp.id('bob'), pg_temp.id('org_a')), false, 'nobody is away by default');
select pg_temp.as_user('bob');
select app.set_personal_setting('me.out_of_office.enabled', null, p_value_boolean => true);
select app.set_personal_setting('me.out_of_office.auto_reply', null, p_value_text => 'Away at the Harbor show until Monday. Ask Carol for approvals.');
select pg_temp.as_platform();
select is(private.person_away(pg_temp.id('bob'), pg_temp.id('org_a')), true, 'turning out of office on without dates makes a person away');
select pg_temp.as_user('bob');
select app.set_personal_setting('me.out_of_office.starts_on', null, p_value_text => to_char(current_date + 3, 'YYYY-MM-DD'));
select pg_temp.as_platform();
select is(private.person_away(pg_temp.id('bob'), pg_temp.id('org_a')), false, 'a start date in the future is not away yet');
select is(private.person_away(pg_temp.id('bob'), pg_temp.id('org_a'), now() + interval '4 days'), true, 'from the start date on, the person is away');
select pg_temp.as_user('bob');
select app.set_personal_setting('me.out_of_office.starts_on', null, p_value_text => to_char(current_date - 1, 'YYYY-MM-DD'));
select app.set_personal_setting('me.out_of_office.ends_on', null, p_value_text => to_char(current_date + 2, 'YYYY-MM-DD'));
select pg_temp.as_platform();
select is(private.person_away(pg_temp.id('bob'), pg_temp.id('org_a'), now() + interval '5 days'), false, 'after the end date the person is back');

-- Automatic reply -------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into k select 'conv', app.start_direct_conversation(pg_temp.id('org_a'), pg_temp.id('bob@org_a'));
select app.send_chat_message((select id from k where key = 'conv'), 'Can you sign off the rigging plan?');
select results_eq($$select body, auto_reply from app.chat_messages where conversation_id = (select id from k where key = 'conv') and author_membership_id = (select id from world where key = 'bob@org_a')$$,
  $$values ('Away at the Harbor show until Monday. Ask Carol for approvals.'::text, true)$$, 'a direct message to someone away gets their automatic reply');
select app.send_chat_message((select id from k where key = 'conv'), 'Also the truck schedule.');
select is((select count(*)::int from app.chat_messages where conversation_id = (select id from k where key = 'conv') and auto_reply), 1,
  'once per conversation while away');
select ok(exists (select 1 from app.notifications n where n.recipient_person_id = pg_temp.id('alice') and n.subject_id =
  (select x.id from app.chat_messages x where x.conversation_id = (select id from k where key = 'conv') and x.auto_reply)),
  'the sender is notified of the reply');
select pg_temp.as_user('bob');
select app.send_chat_message((select id from k where key = 'conv'), 'Back early, signing now.');
select is((select count(*)::int from app.chat_messages where conversation_id = (select id from k where key = 'conv') and auto_reply), 1,
  'a person who is in (alice) sends no automatic reply');
select pg_temp.as_user('carol');
insert into k select 'conv2', app.start_direct_conversation(pg_temp.id('org_a'), pg_temp.id('dave@org_a'));
select app.send_chat_message((select id from k where key = 'conv2'), 'Lunch at noon?');
select is((select count(*)::int from app.chat_messages where conversation_id = (select id from k where key = 'conv2') and auto_reply), 0,
  'nobody away, no automatic reply');

-- Approvals go to the delegate ----------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
with x as (insert into app.approval_policies (org_id, name, document_type) values (pg_temp.id('org_a'), 'Purchase orders', 'Purchase Order') returning id)
insert into k select 'policy', id from x;
insert into app.approval_steps (org_id, approval_policy_id, step_order, name, approver_membership_id)
values (pg_temp.id('org_a'), (select id from k where key = 'policy'), 1, 'Admin review', pg_temp.id('bob@org_a'));
select pg_temp.as_user('bob');
insert into app.delegations (delegator_membership_id, delegate_membership_id, valid_from, valid_to, reason)
values (pg_temp.id('bob@org_a'), pg_temp.id('carol@org_a'), now() - interval '1 hour', now() + interval '7 days', 'Covering approvals while I am at the Harbor show.');
select pg_temp.as_platform();
select set_eq($$select private.step_approver_person_ids((select id from k where key = 'policy'), 1::smallint)$$,
  $$values ((select id from world where key = 'carol'))$$, 'while the approver is away, their delegate is notified instead');
select pg_temp.claims('carol');
select is(private.is_step_approver(pg_temp.id('org_a'), null, pg_temp.id('bob@org_a')), true, 'and may decide the step');
select pg_temp.claims('dave');
select is(private.is_step_approver(pg_temp.id('org_a'), null, pg_temp.id('bob@org_a')), false, 'nobody else may');
select pg_temp.as_user('bob');
select app.set_personal_setting('me.out_of_office.enabled', null, p_value_boolean => false);
select pg_temp.as_platform();
select set_eq($$select private.step_approver_person_ids((select id from k where key = 'policy'), 1::smallint)$$,
  $$values ((select id from world where key = 'bob'))$$, 'back in, the approver is notified again');
select pg_temp.claims('carol');
select is(private.is_step_approver(pg_temp.id('org_a'), null, pg_temp.id('bob@org_a')), false, 'and the delegate no longer decides for them');
select pg_temp.claims('bob');
select is(private.is_step_approver(pg_temp.id('org_a'), null, pg_temp.id('bob@org_a')), true, 'the approver decides their own step');

select * from finish();
rollback;

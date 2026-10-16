-- pgTAP: the requester of a help desk request replies through app.answer_help_desk_request (A29, 0809).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(5);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

select pg_temp.as_user('bob');
with t as (insert into app.help_desk_teams (org_id, name, team_kind) values (pg_temp.id('org_a'), 'Ops Desk', 'Operations') returning id)
insert into k select 'team', id from t;
insert into app.help_desk_team_members (help_desk_team_id, membership_id) values ((select id from k where key = 'team'), pg_temp.id('dave@org_a'));

select pg_temp.as_user('frank');
insert into k select 'req', app.open_help_desk_request(pg_temp.id('org_a'), (select id from k where key = 'team'), 'Problem', 'Gate jammed', 'Gate C will not open.');

select pg_temp.as_user('dave');
select app.answer_help_desk_request((select id from k where key = 'req'), 'Which gate exactly?');
select app.transition_help_desk_request((select id from k where key = 'req'), 'Open', 'Waiting', 'Asked which gate.');

select pg_temp.as_user('frank');
select lives_ok($$select app.answer_help_desk_request((select id from k where key = 'req'), 'Gate C by the dock.')$$, 'the requester replies');
select is((select ticket_state::text from app.support_tickets where id = (select id from k where key = 'req')), 'Open', 'the reply hands a waiting request back');
select pg_temp.as_user('gina');
select throws_ok($$select app.answer_help_desk_request((select id from k where key = 'req'), 'Me too.')$$, '42501', null, 'others still cannot write');
select pg_temp.as_platform();
select is((select count(*)::integer from app.support_ticket_messages where support_ticket_id = (select id from k where key = 'req')), 2, 'both messages are on the thread');
select is((select count(*)::integer from app.domain_events where org_id = pg_temp.id('org_a') and event_type = 'support_ticket.answered'), 1,
  'only the team''s first answer counts as the response');

select * from finish();
rollback;

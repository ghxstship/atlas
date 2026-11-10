-- pgTAP: migration 904090002, api_external.briefings. Outside crew read the briefings of projects they hold an
-- operational Crew engagement on, and only project briefings: not crew calls or meetings, not org- or team-wide
-- events, not another project's, and nothing before the engagement is Active. Anonymous callers read nothing.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select no_plan();

create function pg_temp.n(p_who text, p_title text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  select count(*)::int into v from api_external.briefings b where b.title = p_title;
  perform pg_temp.as_platform();
  return v;
end $$;

select pg_temp.as_platform();
insert into app.workforce_events (org_id, event_kind, title, agenda, location, audience_kind, project_id, starts_at, ends_at) values
  (pg_temp.id('org_a'), 'Briefing', 'Load-in safety briefing', 'Rigging zones and radio channels.', 'Stage left',
   'Project', pg_temp.id('prj_a'), now() + interval '1 day', now() + interval '1 day 30 minutes'),
  (pg_temp.id('org_a'), 'Crew Call', 'Load-in crew call', null, 'Dock', 'Project', pg_temp.id('prj_a'),
   now() + interval '1 day', now() + interval '1 day 1 hour'),
  (pg_temp.id('org_a'), 'Briefing', 'Members-only briefing', null, null, 'Organization', null,
   now() + interval '2 days', now() + interval '2 days 1 hour'),
  (pg_temp.id('org_b'), 'Briefing', 'Harbor briefing', null, null, 'Project', pg_temp.id('prj_b'),
   now() + interval '1 day', now() + interval '1 day 30 minutes');

select is(pg_temp.n('ivy', 'Load-in safety briefing'), 0, 'nothing before the engagement is Active');
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select is(pg_temp.n('ivy', 'Load-in safety briefing'), 1, 'outside crew read their project''s briefing once Active');
select pg_temp.as_user('ivy');
select is((select project_id::text || '|' || agenda || '|' || location from api_external.briefings where title = 'Load-in safety briefing'),
  pg_temp.id('prj_a')::text || '|Rigging zones and radio channels.|Stage left', 'with its project, agenda and location');
select pg_temp.as_platform();
select is(pg_temp.n('ivy', 'Load-in crew call'), 0, 'not a crew call');
select is(pg_temp.n('ivy', 'Members-only briefing'), 0, 'not an org-wide briefing, which addresses members');
select is(pg_temp.n('quinn', 'Load-in safety briefing'), 0, 'not another crew member''s project');
select is(pg_temp.n('ivy', 'Harbor briefing'), 0, 'not a project their engagement there has not opened');

select pg_temp.as_platform();
update app.workforce_events set canceled_at = now(), cancel_reason = 'Weather.' where title = 'Load-in safety briefing';
select pg_temp.as_user('ivy');
select is((select cancel_reason from api_external.briefings where title = 'Load-in safety briefing'), 'Weather.',
  'a canceled briefing stays, with its reason');

set local role anon;
select throws_ok($$select count(*) from api_external.briefings$$, '42501', null, 'anonymous callers read nothing');
reset role;

select * from finish();
rollback;

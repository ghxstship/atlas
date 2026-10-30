-- pgTAP: migrations 2790 to 2794 (P2, RRR-216, ADR 0131), run of show and show calling. Start times to be confirmed
-- (columns, the normalizer, the external views, Up Next and the calendar feed), standby (app.standby_cue and the cue
-- guard), moving a cue in one step (app.move_cue), nudging the plan (app.shift_cue_plan) and saving department calls
-- (app.save_cue_calls). Trash membership of the tables touched is unchanged.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

create temporary table k (key text primary key, id uuid, val text);
grant select, insert, update on k to public;

create function pg_temp.feed_status(p_key text, p_id uuid) returns text
language sql as $$
  select e ->> 'status'
  from jsonb_array_elements(api_public.calendar_feed((select val from k where key = p_key)) -> 'events') e
  where (e ->> 'id')::uuid = p_id
$$;

create function pg_temp.n(p_who text, p_sql text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  execute 'select count(*)::int from (' || p_sql || ') x' into v;
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.order_of(p_run text) returns text
language sql as $$
  select string_agg(c.label || '@' || c.position, ',' order by c.position)
  from app.cues c where c.run_of_show_id = pg_temp.id(p_run) and c.deleted_at is null
$$;

create function pg_temp.trash_set() returns text
language sql as $$
  select coalesce(string_agg(t.table_name::text, ',' order by t.table_name::text), '')
  from private.trash_tables t
  where t.table_name::text in ('app.cues', 'app.cue_calls', 'app.run_of_show', 'app.records')
$$;

-- Columns ---------------------------------------------------------------------------------------------------------------
select col_type_is('app', 'records', 'start_tbc', 'boolean', 'records.start_tbc is boolean');
select col_not_null('app', 'records', 'start_tbc', 'records.start_tbc is not null');
select col_default_is('app', 'records', 'start_tbc', 'false', 'records.start_tbc defaults to false');
select col_type_is('app', 'cues', 'start_tbc', 'boolean', 'cues.start_tbc is boolean');
select col_not_null('app', 'cues', 'start_tbc', 'cues.start_tbc is not null');
select col_default_is('app', 'cues', 'start_tbc', 'false', 'cues.start_tbc defaults to false');
select col_type_is('app', 'run_of_show', 'curfew_at', 'timestamp with time zone', 'run_of_show.curfew_at is a timestamptz');
select col_is_null('app', 'run_of_show', 'curfew_at', 'run_of_show.curfew_at is nullable');
select col_type_is('app', 'cues', 'standby_at', 'timestamp with time zone', 'cues.standby_at is a timestamptz');
select col_is_null('app', 'cues', 'standby_at', 'cues.standby_at is nullable');
select is((select count(*)::int from (values ('app.records'::regclass, 'start_tbc'), ('app.cues'::regclass, 'start_tbc'),
    ('app.run_of_show'::regclass, 'curfew_at'), ('app.cues'::regclass, 'standby_at')) v (rel, col)
  join pg_catalog.pg_attribute a on a.attrelid = v.rel and a.attname = v.col
  where col_description(a.attrelid, a.attnum) is not null), 4, 'every new column carries a comment');
select is((select count(*)::int from (values ('cues', 'start_tbc'), ('records', 'start_tbc'), ('engagement_up_next', 'next_call_tbc')) v (rel, col)
  join pg_catalog.pg_attribute a on a.attrelid = ('api_external.' || v.rel)::regclass and a.attname = v.col
  where col_description(a.attrelid, a.attnum) is not null), 3, 'every new view column carries a comment');

-- Fixture: a running order of six cues on NWL, a Client party and a meeting ------------------------------------------------
select pg_temp.as_user('dave');
with x as (insert into app.run_of_show (project_id, scope_node_id, name, show_date)
  values (pg_temp.id('prj_a'), pg_temp.id('show_a'), 'Opening Night Running Order', '2027-06-05') returning id)
  insert into world select 'ros', id from x;
insert into app.cues (run_of_show_id, position, label, planned_at)
select pg_temp.id('ros'), v.p, v.label, '2027-06-05 23:00+00'::timestamptz + make_interval(mins => v.p * 5)
from (values (1, 'House to Half'), (2, 'Walk-in Music Out'), (3, 'Host Welcome'), (4, 'Award One'),
  (5, 'Headliner On'), (6, 'House Lights Up')) v (p, label);
insert into world select 'q' || c.position, c.id from app.cues c where c.run_of_show_id = pg_temp.id('ros');

-- The normalizer: a TBC needs an estimate ---------------------------------------------------------------------------------
update app.cues set start_tbc = true where id = pg_temp.id('q6');
select ok((select start_tbc from app.cues where id = pg_temp.id('q6')), 'a cue with a planned time can be TBC');
update app.cues set planned_at = null where id = pg_temp.id('q6');
select ok(not (select start_tbc from app.cues where id = pg_temp.id('q6')), 'clearing the planned time clears TBC');
update app.cues set start_tbc = true where id = pg_temp.id('q6');
select ok(not (select start_tbc from app.cues where id = pg_temp.id('q6')), 'a cue without a planned time cannot be TBC');
update app.cues set planned_at = '2027-06-05 23:30+00', start_tbc = true where id = pg_temp.id('q6');

select pg_temp.as_user('carol');
with r as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis, starts_at, ends_at, time_zone, owner_party_id, start_tbc)
  values (pg_temp.id('prj_a'), 'Meeting', 'Production Meeting', 'Y', 'Declared', date_trunc('day', now()) + interval '10 days 14 hours',
    date_trunc('day', now()) + interval '10 days 15 hours', 'America/New_York', pg_temp.id('frank'), true) returning id)
  insert into world select 'meeting', id from r;
with r as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis, start_tbc)
  values (pg_temp.id('prj_a'), 'Meeting', 'Undated Meeting', 'Y', 'Declared', true) returning id)
  insert into world select 'undated', id from r;
select ok(not (select start_tbc from app.records where id = pg_temp.id('undated')), 'a record inserted without a start is never TBC');
select ok((select start_tbc from app.records where id = pg_temp.id('meeting')), 'a record with a start can be TBC');
select app.transition_record(pg_temp.id('meeting'), 'Proposed', 'Scheduled', 'Room booked.');
insert into app.record_external_visibility (record_id, person_id) values (pg_temp.id('meeting'), pg_temp.id('ivy'));
with r as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis, starts_at, start_tbc)
  values (pg_temp.id('prj_a'), 'Meeting', 'Sponsor Walkthrough', 'Y', 'Declared', now() + interval '12 days', true) returning id)
  insert into world select 'walk', id from r;
update app.records set starts_at = null where id = pg_temp.id('walk');
select ok(not (select start_tbc from app.records where id = pg_temp.id('walk')), 'clearing a record''s start clears TBC, by any writer');

-- External views: a Client and an artist read start_tbc, never who called -----------------------------------------------------
select pg_temp.new_user('cleo', 'cleo@coral-group.test', 'Cleo Marsh');
select pg_temp.as_user('cleo');
insert into world values ('acct_c', app.create_external_account('Coral Group', 'coral-group'));
select pg_temp.as_user('alice');
insert into world values ('cp_c_a', app.create_counterparty(pg_temp.id('org_a'), null, null, pg_temp.id('acct_c')));
with x as (insert into app.engagements (project_id, person_id, counterparty_id, role_type, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('cleo'), pg_temp.id('cp_c_a'), 'Client', '2027-06-01') returning id)
  insert into world select 'eng_client_a', id from x;
insert into app.engagement_cues (engagement_id, cue_id) values (pg_temp.id('eng_art_a'), pg_temp.id('q6'));
select pg_temp.as_platform();
select pg_temp.move_engagement('eng_client_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_art_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');

select is(((select array_agg(column_name::text order by ordinal_position) from information_schema.columns
  where table_schema = 'api_external' and table_name = 'cues')::text[])[10:10], array['start_tbc'], 'api_external.cues ends with start_tbc');
select is(((select array_agg(column_name::text order by ordinal_position) from information_schema.columns
  where table_schema = 'api_external' and table_name = 'records')::text[])[11:11], array['start_tbc'], 'api_external.records ends with start_tbc');
select is(pg_temp.n('cleo', format('select 1 from api_external.cues where id = %L and start_tbc', pg_temp.id('q6'))), 1,
  'a Client reads that a cue is TBC');
select is(pg_temp.n('art', format('select 1 from api_external.cues where id = %L and start_tbc', pg_temp.id('q6'))), 1,
  'an artist reads that their set is TBC');
select is(pg_temp.n('ivy', format('select 1 from api_external.records where id = %L and start_tbc', pg_temp.id('meeting'))), 1,
  'a party the record is shown to reads that its start is TBC');
select hasnt_column('api_external', 'cues', 'called_by', 'who called a cue still never reaches externals');
select hasnt_column('api_external', 'cues', 'standby_at', 'standby stays internal');

-- Up Next: a TBC set is not a firm call ---------------------------------------------------------------------------------------
update app.cues set planned_at = now() + interval '5 days', start_tbc = true where id = pg_temp.id('q6');
select pg_temp.as_user('art');
select is((select next_call_tbc from api_external.engagement_up_next where engagement_id = pg_temp.id('eng_art_a')), true,
  'Up Next flags a set whose time is to be confirmed');
select pg_temp.as_platform();
update app.cues set start_tbc = false where id = pg_temp.id('q6');
select pg_temp.as_user('art');
select is((select next_call_tbc from api_external.engagement_up_next where engagement_id = pg_temp.id('eng_art_a')), false,
  'and a confirmed set as firm');
select pg_temp.as_platform();
update app.cues set planned_at = '2027-06-05 23:30+00', start_tbc = true where id = pg_temp.id('q6');

-- Calendar feed: TBC is tentative --------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
insert into k (key, val) select 'frank', feed_token from app.create_calendar_feed(pg_temp.id('org_a'));
select pg_temp.as_user('dave');
insert into k (key, val) select 'dave_project', feed_token from app.create_calendar_feed(pg_temp.id('org_a'), pg_temp.id('prj_a'));
select pg_temp.as_user('ivy');
insert into k (key, val) select 'ivy', feed_token from app.create_person_calendar_feed();
select pg_temp.as_platform();
insert into k (key, val) select 'meeting_at', starts_at::text from app.records where id = pg_temp.id('meeting');
select pg_temp.as_anon();
select is(pg_temp.feed_status('frank', pg_temp.id('meeting')), 'tentative', 'member feed: a Scheduled meeting to be confirmed is tentative');
select is(pg_temp.feed_status('dave_project', pg_temp.id('meeting')), 'tentative', 'project feed: tentative');
select is(pg_temp.feed_status('ivy', pg_temp.id('meeting')), 'tentative', 'person feed: tentative');
select is((select e ->> 'starts_at' from jsonb_array_elements(api_public.calendar_feed((select val from k where key = 'frank')) -> 'events') e
    where (e ->> 'id')::uuid = pg_temp.id('meeting'))::timestamptz,
  (select val::timestamptz from k where key = 'meeting_at'), 'the event starts at the estimate');
select pg_temp.as_user('carol');
update app.records set start_tbc = false where id = pg_temp.id('meeting');
select pg_temp.as_anon();
select is(pg_temp.feed_status('frank', pg_temp.id('meeting')), 'confirmed', 'member feed: confirmed once the time is');
select is(pg_temp.feed_status('dave_project', pg_temp.id('meeting')), 'confirmed', 'project feed: confirmed');
select is(pg_temp.feed_status('ivy', pg_temp.id('meeting')), 'confirmed', 'person feed: confirmed');
select pg_temp.as_user('carol');
update app.records set start_tbc = true where id = pg_temp.id('meeting');
select app.transition_record(pg_temp.id('meeting'), 'Scheduled', 'Canceled', 'Speaker withdrew.');
select pg_temp.as_anon();
select is(pg_temp.feed_status('frank', pg_temp.id('meeting')), 'cancelled', 'member feed: cancelled wins over TBC');
select is(pg_temp.feed_status('dave_project', pg_temp.id('meeting')), 'cancelled', 'project feed: cancelled wins');
select is(pg_temp.feed_status('ivy', pg_temp.id('meeting')), 'cancelled', 'person feed: cancelled wins');
select pg_temp.as_platform();

-- Standby ---------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select throws_ok(format('select app.standby_cue(%L, %L)', pg_temp.id('ros'), pg_temp.id('q2')), '42501', null,
  'a Viewer without show.cue.call cannot put a cue on standby');
update app.cues set standby_at = now() where id = pg_temp.id('q2');
select pg_temp.as_platform();
select ok((select standby_at is null from app.cues where id = pg_temp.id('q2')), 'nor write the row: a Viewer has no update policy');
select pg_temp.as_user('xavier');
select throws_ok(format('select app.standby_cue(%L, %L)', pg_temp.id('ros'), pg_temp.id('q2')), '42501', null,
  'another org cannot put a cue on standby');
select pg_temp.as_anon();
select throws_ok(format('select app.standby_cue(%L, %L)', pg_temp.id('ros'), pg_temp.id('q2')), '42501', null, 'anon cannot either');

select pg_temp.as_user('dave');
select lives_ok(format('select app.standby_cue(%L, %L)', pg_temp.id('ros'), pg_temp.id('q2')), 'a caller puts a cue on standby');
select ok((select standby_at > now() - interval '1 minute' from app.cues where id = pg_temp.id('q2')), 'the standby is stamped now');
select lives_ok(format('select app.standby_cue(%L, %L)', pg_temp.id('ros'), pg_temp.id('q3')), 'moving the standby to another cue');
select is((select array_agg(label order by position) from app.cues where run_of_show_id = pg_temp.id('ros') and standby_at is not null),
  array['Host Welcome'], 'one standby per running order: the earlier one is cleared');
select throws_ok(format('update app.cues set standby_at = now() where id = %L', pg_temp.id('q4')), '23505', null,
  'a second standby is refused by cues_standby_key');
select lives_ok(format('select app.standby_cue(%L)', pg_temp.id('ros')), 'a NULL cue only clears');
select is((select count(*)::int from app.cues where run_of_show_id = pg_temp.id('ros') and standby_at is not null), 0, 'no standby is left');
select app.call_cue(pg_temp.id('q1'));
select throws_ok(format('select app.standby_cue(%L, %L)', pg_temp.id('ros'), pg_temp.id('q1')), 'XR001', 'cue_standby_called: A called cue cannot go on standby.',
  'a called cue cannot go on standby');
select throws_ok(format('update app.cues set standby_at = now() where id = %L', pg_temp.id('q1')), 'XR001', 'cue_standby_called: A called cue cannot go on standby.',
  'nor directly');
update app.cues set standby_at = '2000-01-01' where id = pg_temp.id('q4');
select ok((select standby_at > '2020-01-01' from app.cues where id = pg_temp.id('q4')), 'a direct standby by a caller is stamped with the database time');
update app.cues set standby_at = null where id = pg_temp.id('q4');


-- People with half the show capabilities: mia edits the running order without calling cues, gina calls cues without
-- editing it (project grants on NWL).
select pg_temp.as_user('alice');
insert into app.user_capability_grants (membership_id, capability_code, scope_kind, scope_id, reason) values
  (pg_temp.id('mia@org_a'), 'show.run_of_show.write', 'project', pg_temp.id('prj_a'), 'Script supervisor for the run.'),
  (pg_temp.id('mia@org_a'), 'show.run_of_show.read', 'project', pg_temp.id('prj_a'), 'Script supervisor for the run.'),
  (pg_temp.id('gina@org_a'), 'show.cue.call', 'project', pg_temp.id('prj_a'), 'Calls the show from the booth.');
select pg_temp.as_user('mia');
select throws_ok(format('update app.cues set standby_at = now() where id = %L', pg_temp.id('q4')), 'XR001',
  'cue_standby_capability: Only a person who may call cues on the project puts a cue on standby.',
  'an editor without show.cue.call cannot put a cue on standby directly');
select throws_ok(format('select app.standby_cue(%L, %L)', pg_temp.id('ros'), pg_temp.id('q4')), '42501', null,
  'nor through app.standby_cue');
select pg_temp.as_user('gina');
select lives_ok(format('select app.standby_cue(%L, %L)', pg_temp.id('ros'), pg_temp.id('q4')),
  'a caller without show.run_of_show.write puts a cue on standby');
select lives_ok(format('select app.standby_cue(%L)', pg_temp.id('ros')), 'and clears it');

-- Move to position ------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
create temporary table moved (id uuid);
grant select, insert on moved to public;
create function pg_temp.note_move() returns trigger
language plpgsql as $$ begin insert into moved values (new.id); return new; end $$;
create trigger zz_note_move after update of position on app.cues for each row execute function pg_temp.note_move();

select pg_temp.as_user('dave');
with x as (insert into app.cues (run_of_show_id, position, label) values (pg_temp.id('ros'), 7, 'Encore') returning id)
  insert into world select 'q7', id from x;
update app.cues set deleted_at = now() where id = pg_temp.id('q7');
select is(app.move_cue(pg_temp.id('q5'), 2), 2, 'moving cue 5 to place 2 returns its new position');
select is(pg_temp.order_of('ros'),
  'House to Half@1,Headliner On@2,Walk-in Music Out@3,Host Welcome@4,Award One@5,House Lights Up@6',
  'one call reorders the run densely, 1 to 6');
select set_eq('select distinct id from moved', array[pg_temp.id('q2'), pg_temp.id('q3'), pg_temp.id('q4'), pg_temp.id('q5')],
  'only the cues whose position changes are written');
select pg_temp.as_platform();
select is((select position from app.cues where id = pg_temp.id('q7')), 7, 'a deleted cue is untouched');
select pg_temp.as_user('dave');
select throws_ok(format('select app.move_cue(%L, 4)', pg_temp.id('q1')), 'XR001', 'cue_move_called: A called cue keeps its place.',
  'a called cue keeps its place');
select throws_ok(format('select app.move_cue(%L, 1)', pg_temp.id('q6')), 'XR001', 'cue_move_before_called: Move it after the last called cue.',
  'nothing moves to or before the last called cue');
select is(app.move_cue(pg_temp.id('q2'), 99), 6, 'a place past the end is clamped to the last place');
select pg_temp.as_user('gina');
select throws_ok(format('select app.move_cue(%L, 3)', pg_temp.id('q6')), '42501', null,
  'a caller without show.run_of_show.write cannot move cues');
select pg_temp.as_user('xavier');
select throws_ok(format('select app.move_cue(%L, 3)', pg_temp.id('q6')), '42501', null, 'another org cannot move cues');
select pg_temp.as_user('mia');
select lives_ok(format('select app.move_cue(%L, 2)', pg_temp.id('q6')), 'an editor moves cues');
select pg_temp.as_platform();
drop trigger zz_note_move on app.cues;

-- Nudge ------------------------------------------------------------------------------------------------------------------------
insert into k (key, val) select 'q1_at', planned_at::text from app.cues where id = pg_temp.id('q1');
insert into k (key, val) select 'q3_at', planned_at::text from app.cues where id = pg_temp.id('q3');
select pg_temp.as_user('dave');
select is(app.shift_cue_plan(pg_temp.id('ros'), 60), 5, 'nudging later moves every live, uncalled, planned cue');
select is((select planned_at from app.cues where id = pg_temp.id('q3')), (select val::timestamptz + interval '1 minute' from k where key = 'q3_at'),
  'by one minute');
select is((select planned_at from app.cues where id = pg_temp.id('q1')), (select val::timestamptz from k where key = 'q1_at'),
  'a called cue keeps its plan');
select is(app.shift_cue_plan(pg_temp.id('ros'), -60), 5, 'nudging earlier moves them back');
select throws_ok(format('select app.shift_cue_plan(%L, 0)', pg_temp.id('ros')), 'XR001', null, 'a zero nudge is refused');
select throws_ok(format('select app.shift_cue_plan(%L, 3601)', pg_temp.id('ros')), 'XR001',
  'cue_shift_range: Nudge by up to an hour earlier or later.', 'more than an hour later is refused');
select throws_ok(format('select app.shift_cue_plan(%L, -3601)', pg_temp.id('ros')), 'XR001', null, 'more than an hour earlier is refused');
select pg_temp.as_user('gina');
select is(app.shift_cue_plan(pg_temp.id('ros'), 60), 5, 'a caller with only show.cue.call may nudge');
select pg_temp.as_user('mia');
select is(app.shift_cue_plan(pg_temp.id('ros'), -60), 5, 'an editor with only show.run_of_show.write may nudge');
select pg_temp.as_user('xavier');
select throws_ok(format('select app.shift_cue_plan(%L, 60)', pg_temp.id('ros')), '42501', null, 'another org cannot nudge');
select pg_temp.as_user('ivy');
select throws_ok(format('select app.shift_cue_plan(%L, 60)', pg_temp.id('ros')), '42501', null, 'an external party cannot nudge');

-- Department calls ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select lives_ok(format($$select app.save_cue_calls(%L, '{"Lighting": "LX 14 GO, house to half", "Audio": "Host mic live"}')$$, pg_temp.id('q3')),
  'an editor saves two department calls in one call');
select is((select array_agg(call_kind::text || ':' || instruction order by call_kind) from app.cue_calls where cue_id = pg_temp.id('q3') and deleted_at is null),
  array['Audio:Host mic live', 'Lighting:LX 14 GO, house to half'], 'both calls are live');
select lives_ok(format($$select app.save_cue_calls(%L, '{"Lighting": "LX 15 GO"}')$$, pg_temp.id('q3')), 'saving again upserts');
select is((select array_agg(call_kind::text || ':' || instruction order by call_kind) from app.cue_calls where cue_id = pg_temp.id('q3') and deleted_at is null),
  array['Audio:Host mic live', 'Lighting:LX 15 GO'], 'the Lighting call changed in place and Audio, left out, is untouched');
select lives_ok(format($$select app.save_cue_calls(%L, '{"Audio": null, "Lighting": "   "}')$$, pg_temp.id('q3')), 'NULL and blank clear');
select is((select count(*)::int from app.cue_calls where cue_id = pg_temp.id('q3') and deleted_at is null), 0, 'no live call is left');
select is((select count(*)::int from app.cue_calls where cue_id = pg_temp.id('q3') and deleted_at is not null), 2, 'cleared calls are soft-deleted');
select throws_ok(format($$select app.save_cue_calls(%L, '{"Pyro": "Gerbs GO"}')$$, pg_temp.id('q3')), 'XR001',
  'cue_call_kind: A call goes to Audio, Lighting, Video, Special Effects or Stage.', 'an unknown department is refused');
select lives_ok(format($$select app.save_cue_calls(%L, '{"Special Effects": "Confetti GO", "Stage": "Podium strike"}')$$, pg_temp.id('q4')),
  'every department label is accepted');
select pg_temp.as_user('gina');
select throws_ok(format($$select app.save_cue_calls(%L, '{"Video": "Roll VT 1"}')$$, pg_temp.id('q4')), '42501', null,
  'a caller without show.run_of_show.write cannot save calls');
select pg_temp.as_user('mia');
select is((select count(*)::int from app.cue_calls where cue_id = pg_temp.id('q4') and deleted_at is null), 2,
  'reading calls still follows show.run_of_show.read (row level security unchanged)');
select pg_temp.as_user('xavier');
select throws_ok(format($$select app.save_cue_calls(%L, '{"Video": "Roll VT 1"}')$$, pg_temp.id('q4')), '42501', null,
  'another org cannot save calls');
select is((select count(*)::int from app.cue_calls where cue_id = pg_temp.id('q4')), 0, 'nor read them');
select pg_temp.as_platform();

-- Trash and catalogs ---------------------------------------------------------------------------------------------------------------
select is((select description from app.capabilities where code = 'show.cue.call'),
  'Call cues live during a show: go, standby and nudging the remaining planned times.',
  'show.cue.call says it covers standby and nudging the plan (2793)');
select is(pg_temp.trash_set(), '', 'the Trash membership of cues, cue calls, running orders and records is unchanged (ADR 0110)');

select * from finish();
rollback;

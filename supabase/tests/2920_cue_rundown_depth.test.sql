-- pgTAP: migration 2920, B3 (RRR-227, ADR 0142). Rundown depth: cues are a custom field target with A117's guards, a
-- cue value takes show.run_of_show.write, choices carry an optional color, every cue field starts with the Crew
-- audience, Showcaller and Client never take a Person, Money or Email field nor a field of another table, a Client reads
-- the Client-audience values of their project's cues and nobody else does, the script column, and segment colors set
-- and cleared in one statement. Neither new table enters Trash, and both have retention.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

create temporary table k (key text primary key, id uuid, val text);
grant select, insert, update on k to public;

create function pg_temp.k(p_key text) returns uuid
language sql stable as $$ select id from k where key = p_key $$;

create function pg_temp.n(p_who text, p_sql text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  execute 'select count(*)::int from (' || p_sql || ') x' into v;
  perform pg_temp.as_platform();
  return v;
end $$;

-- A refusal's rule, or ok.
create function pg_temp.try(p_who text, p_sql text) returns text
language plpgsql as $$
begin
  perform pg_temp.as_user(p_who);
  begin
    execute p_sql;
  exception
    when sqlstate 'XR001' then
      perform pg_temp.as_platform();
      return split_part(sqlerrm, ':', 1);
    when insufficient_privilege then
      perform pg_temp.as_platform();
      return '42501';
    when check_violation then
      perform pg_temp.as_platform();
      return '23514';
  end;
  perform pg_temp.as_platform();
  return 'ok';
end $$;

create function pg_temp.field(p_key text, p_type text, p_target text default 'app.cues', p_required boolean default false) returns uuid
language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.as_user('alice');
  insert into app.custom_field_definitions (org_id, target_table, field_key, label, data_type, required, sort_order)
  values (pg_temp.id('org_a'), p_target, p_key, initcap(replace(p_key, '_', ' ')), p_type::app.custom_data_type, p_required,
    (select count(*) from k)::int)
  returning id into v;
  perform pg_temp.as_platform();
  insert into k values (p_key, v, null);
  return v;
end $$;

-- The target --------------------------------------------------------------------------------------------------------------
select ok(exists (select 1 from private.custom_field_targets where table_name = 'app.cues'), 'cues are a custom field target');
select is(pg_temp.n('dave', $$select 1 from app.custom_field_targets where table_name = 'app.cues'$$), 1,
  'and the Settings page lists them');
select is((select count(*)::int from private.custom_field_targets), 10, 'ten built-in tables take custom fields now');

-- A running order on NWL, and a Client --------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
with x as (insert into app.run_of_show (project_id, scope_node_id, name, show_date)
  values (pg_temp.id('prj_a'), pg_temp.id('show_a'), 'Opening Night Running Order', '2027-06-05') returning id)
  insert into world select 'ros', id from x;
insert into app.cues (run_of_show_id, position, label, segment) values
  (pg_temp.id('ros'), 1, 'House to Half', 'Act I'), (pg_temp.id('ros'), 2, 'Host Welcome', 'act i '),
  (pg_temp.id('ros'), 3, 'Headliner On', 'Act II');
insert into world select 'q' || c.position, c.id from app.cues c where c.run_of_show_id = pg_temp.id('ros');
select pg_temp.as_platform();

select pg_temp.new_user('cleo', 'cleo@coral-group.test', 'Cleo Marsh');
select pg_temp.as_user('cleo');
insert into world values ('acct_c', app.create_external_account('Coral Group', 'coral-group'));
select pg_temp.as_user('alice');
insert into world values ('cp_c_a', app.create_counterparty(pg_temp.id('org_a'), null, null, pg_temp.id('acct_c')));
with x as (insert into app.engagements (project_id, person_id, counterparty_id, role_type, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('cleo'), pg_temp.id('cp_c_a'), 'Client', '2027-06-01') returning id)
  insert into world select 'eng_client_a', id from x;
select pg_temp.as_platform();
select pg_temp.move_engagement('eng_client_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_art_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');

-- Fields, audiences and colors --------------------------------------------------------------------------------------------------
select pg_temp.field('camera', 'Choice');
select pg_temp.field('mic_note', 'Text');
select pg_temp.field('host', 'Person');
select pg_temp.field('budget_line', 'Money');
select pg_temp.field('wardrobe', 'Text', 'app.cues', true);
select pg_temp.field('venue_note', 'Text', 'app.projects');

select is((select array_agg(audience::text) from app.cue_field_audiences where custom_field_definition_id = pg_temp.k('camera') and deleted_at is null),
  array['Crew'], 'a new cue field starts with the Crew audience');
select is((select count(*)::int from app.cue_field_audiences where custom_field_definition_id = pg_temp.k('venue_note')), 0,
  'a field of another table gets no audience');

select is(pg_temp.try('alice', format($$insert into app.custom_field_choices (custom_field_definition_id, choice_key, label, sort_order, color_key)
  values (%L, 'wide', 'Wide', 1, 'cat-3')$$, pg_temp.k('camera'))), 'ok', 'a choice takes a color from the palette');
select is(pg_temp.try('alice', format($$insert into app.custom_field_choices (custom_field_definition_id, choice_key, label, sort_order, color_key)
  values (%L, 'tight', 'Tight', 2, 'cat-8')$$, pg_temp.k('camera'))), '23514', 'and nothing outside cat-1 to cat-7');
select is(pg_temp.try('alice', format($$insert into app.custom_field_choices (custom_field_definition_id, choice_key, label, sort_order, color_key)
  values (%L, 'tight', 'Tight', 2, '#ff0000')$$, pg_temp.k('camera'))), '23514', 'nor a raw color');
select is(pg_temp.try('alice', format($$insert into app.custom_field_choices (custom_field_definition_id, choice_key, label, sort_order)
  values (%L, 'tight', 'Tight', 2)$$, pg_temp.k('camera'))), 'ok', 'and no color is fine');
insert into k select 'choice:' || choice_key, id, null from app.custom_field_choices where custom_field_definition_id = pg_temp.k('camera');

select is(pg_temp.try('alice', format($$insert into app.cue_field_audiences (custom_field_definition_id, audience) values (%L, 'Showcaller')$$,
  pg_temp.k('host'))), 'cue_field_audience_type', 'a Person field never goes to showcaller links');
select is(pg_temp.try('alice', format($$insert into app.cue_field_audiences (custom_field_definition_id, audience) values (%L, 'Client')$$,
  pg_temp.k('budget_line'))), 'cue_field_audience_type', 'a Money field never goes to Clients');
select is(pg_temp.try('alice', format($$insert into app.cue_field_audiences (custom_field_definition_id, audience) values (%L, 'Crew')$$,
  pg_temp.k('venue_note'))), 'cue_field_audience_target', 'an audience belongs to a cue field');
select is(pg_temp.try('alice', format($$insert into app.cue_field_audiences (custom_field_definition_id, audience) values (%L, 'Client'), (%L, 'Showcaller')$$,
  pg_temp.k('camera'), pg_temp.k('camera'))), 'ok', 'a Choice field may go to Clients and showcaller links');
select is(pg_temp.try('dave', format($$insert into app.cue_field_audiences (custom_field_definition_id, audience) values (%L, 'Client')$$,
  pg_temp.k('mic_note'))), '42501', 'only org.custom_fields.write sets audiences');
select is(pg_temp.try('alice', format($$update app.custom_field_definitions set data_type = 'Email' where id = %L$$, pg_temp.k('camera'))),
  'cue_field_audience_type', 'a field shown outside cannot become an Email field');

-- Values: A117's guards hold for cues, and writing takes show.run_of_show.write ---------------------------------------------------
select is(pg_temp.try('dave', format($$insert into app.custom_field_values (custom_field_definition_id, target_id, value_choice_id) values (%L, %L, %L)$$,
  pg_temp.k('camera'), pg_temp.id('q1'), pg_temp.k('choice:wide'))), 'ok', 'an editor fills in a cue''s Choice field');
select is(pg_temp.try('dave', format($$insert into app.custom_field_values (custom_field_definition_id, target_id, value_text) values (%L, %L, 'Boom left')$$,
  pg_temp.k('mic_note'), pg_temp.id('q1'))), 'ok', 'and a Text field');
select is(pg_temp.try('dave', format($$insert into app.custom_field_values (custom_field_definition_id, target_id, value_number) values (%L, %L, 3)$$,
  pg_temp.k('mic_note'), pg_temp.id('q2'))), 'custom_value_type', 'the type rule holds for cues');
select is(pg_temp.try('dave', format($$insert into app.custom_field_values (custom_field_definition_id, target_id, value_text) values (%L, %L, null)$$,
  pg_temp.k('wardrobe'), pg_temp.id('q2'))), 'custom_value_required', 'and the required rule');
select is(pg_temp.try('dave', format($$insert into app.custom_field_values (custom_field_definition_id, target_id, value_person_id) values (%L, %L, %L)$$,
  pg_temp.k('host'), pg_temp.id('q2'), pg_temp.id('ivy'))), 'custom_value_person', 'and the person rule');

select pg_temp.as_user('alice');
insert into app.user_capability_grants (membership_id, capability_code, scope_kind, scope_id, reason) values
  (pg_temp.id('mia@org_a'), 'show.run_of_show.read', 'project', pg_temp.id('prj_a'), 'Follows the run.');
select pg_temp.as_platform();
select is(pg_temp.n('mia', format($$select 1 from app.custom_field_values where target_id = %L$$, pg_temp.id('q1'))), 2,
  'a reader of the running order reads its cue values (row level security of the cue decides)');
select is(pg_temp.try('mia', format($$insert into app.custom_field_values (custom_field_definition_id, target_id, value_text) values (%L, %L, 'Lav')$$,
  pg_temp.k('mic_note'), pg_temp.id('q3'))), 'custom_value_capability', 'but writing one takes show.run_of_show.write');
select is(pg_temp.n('xavier', format($$select 1 from app.custom_field_values where target_id = %L$$, pg_temp.id('q1'))), 0,
  'another org reads none');

-- The Client's view -----------------------------------------------------------------------------------------------------------
select has_view('api_external', 'cue_field_values', 'Gateway reads Client cue fields through api_external.cue_field_values');
select is(pg_temp.n('cleo', format($$select 1 from api_external.cue_field_values where cue_id = %L and field_key = 'camera'
  and choice_label = 'Wide' and choice_color_key = 'cat-3'$$, pg_temp.id('q1'))), 1, 'a Client reads a Client-audience value with its color');
select is(pg_temp.n('cleo', format($$select 1 from api_external.cue_field_values where cue_id = %L and field_key = 'mic_note'$$, pg_temp.id('q1'))), 0,
  'never a Crew-only field');
select is(pg_temp.n('art', $$select 1 from api_external.cue_field_values$$), 0, 'an artist reads none');
select is(pg_temp.n('ivy', $$select 1 from api_external.cue_field_values$$), 0, 'nor crew engaged on the project');
select is(pg_temp.n('dave', $$select 1 from api_external.cue_field_values$$), 0, 'nor a member, who is not engaged as Client');
select pg_temp.as_anon();
select throws_ok($$select * from api_external.cue_field_values$$, '42501', null, 'anon cannot read the view');
select pg_temp.as_platform();
update app.cues set deleted_at = now() where id = pg_temp.id('q1');
select is(pg_temp.n('cleo', $$select 1 from api_external.cue_field_values$$), 0, 'a deleted cue''s values leave the view');
update app.cues set deleted_at = null where id = pg_temp.id('q1');
update app.custom_field_choices set deleted_at = now() where id = pg_temp.k('choice:wide');
select is(pg_temp.n('cleo', $$select 1 from api_external.cue_field_values$$), 0, 'and so do values of a removed choice');
update app.custom_field_choices set deleted_at = null where id = pg_temp.k('choice:wide');
update app.cue_field_audiences set deleted_at = now() where custom_field_definition_id = pg_temp.k('camera') and audience = 'Client';
select is(pg_temp.n('cleo', $$select 1 from api_external.cue_field_values$$), 0, 'and removing the Client audience hides the field at once');

-- The script ----------------------------------------------------------------------------------------------------------------------
select col_type_is('app', 'cues', 'script', 'text', 'cues.script is text');
select is(pg_temp.try('dave', format($$update app.cues set script = %L where id = %L$$, repeat('a', 20000), pg_temp.id('q2'))), 'ok',
  'a script holds 20,000 characters');
select is(pg_temp.try('dave', format($$update app.cues set script = %L where id = %L$$, repeat('a', 20001), pg_temp.id('q2'))), '23514',
  'and no more');
select hasnt_column('app', 'cues', 'segment_color', 'a segment''s color is not copied onto its cues');

-- Segment colors -------------------------------------------------------------------------------------------------------------------
select is(pg_temp.try('dave', format($$select app.set_segment_color(%L, '  Act I ', 'cat-2')$$, pg_temp.id('ros'))), 'ok', 'an editor colors a segment');
select is((select count(*)::int from app.run_segment_colors where run_of_show_id = pg_temp.id('ros') and deleted_at is null), 1,
  'in one row for the segment');
select is((select count(*)::int from app.cues c join app.run_segment_colors s on s.run_of_show_id = c.run_of_show_id
  and lower(btrim(s.segment)) = lower(btrim(c.segment)) and s.deleted_at is null and s.color_key = 'cat-2'
  where c.run_of_show_id = pg_temp.id('ros') and c.deleted_at is null), 2, 'which every cue of the segment shows, ignoring case and spaces');
select is(pg_temp.try('dave', format($$select app.set_segment_color(%L, 'Act I', 'cat-5')$$, pg_temp.id('ros'))), 'ok', 'coloring it again');
select is((select array_agg(color_key) from app.run_segment_colors where run_of_show_id = pg_temp.id('ros') and deleted_at is null),
  array['cat-5'], 'changes the one row');
select is(pg_temp.try('dave', format($$select app.set_segment_color(%L, 'Act I', null)$$, pg_temp.id('ros'))), 'ok', 'a NULL color');
select is((select count(*)::int from app.run_segment_colors where run_of_show_id = pg_temp.id('ros') and deleted_at is null), 0, 'clears it');
select is(pg_temp.try('dave', format($$select app.set_segment_color(%L, 'Act I', 'red')$$, pg_temp.id('ros'))), 'segment_color_key',
  'only the seven colors are accepted');
select is(pg_temp.try('dave', format($$select app.set_segment_color(%L, '  ', 'cat-1')$$, pg_temp.id('ros'))), 'segment_color_segment',
  'a blank segment is refused');
select is(pg_temp.try('mia', format($$select app.set_segment_color(%L, 'Act II', 'cat-1')$$, pg_temp.id('ros'))), '42501',
  'a reader cannot color a segment');
select is(pg_temp.try('xavier', format($$select app.set_segment_color(%L, 'Act II', 'cat-1')$$, pg_temp.id('ros'))), '42501',
  'nor another org');

-- Catalog -----------------------------------------------------------------------------------------------------------------------------
select is((select count(*)::int from (values ('app.custom_field_choices'::regclass, 'color_key'), ('app.cues'::regclass, 'script'),
    ('app.cue_field_audiences'::regclass, 'audience'), ('app.run_segment_colors'::regclass, 'segment'), ('app.run_segment_colors'::regclass, 'color_key')) v (rel, col)
  join pg_catalog.pg_attribute a on a.attrelid = v.rel and a.attname = v.col
  where col_description(a.attrelid, a.attnum) is not null), 5, 'every new column carries a comment');
select ok(not exists (select 1 from private.trash_tables where table_name in ('cue_field_audiences', 'run_segment_colors')),
  'neither new table is in Trash');
select is((select count(*)::int from private.retention_policies where table_name in ('app.cue_field_audiences', 'app.run_segment_colors')), 2,
  'and both have their retention policy');

select * from finish();
rollback;

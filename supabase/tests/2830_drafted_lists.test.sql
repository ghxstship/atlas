-- pgTAP: drafted lists (P6, RRR-220, migration 2830). Whether a running order or a project's risks is empty, for a caller
-- who may write to it (soft-deleted entries ignored, risks the caller cannot see counted); applying a drafted list in one
-- transaction (cues numbered 1..n, Risk records with their record_risk row, kept lines Applied, the rest Rejected); the
-- refusals (another person's or another org's request, a request that drafted no list, a foreign, repeated, expired or
-- non-Proposed line, too many lines, a list filled since the draft, a line the database refuses, named by its line with
-- the rule kept); the transition guard on drafted lines, with extraction unchanged; and privileges.
-- World: 0300_domain_world (org_a Northwind Live on Team, prj_a with dave, erin and frank as members, prj_a2 without).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select * from no_plan();

-- A completed drafting request about a list, made by whoever is signed in.
create function pg_temp.drafted_request(p_key text, p_table text, p_subject text) returns uuid
language plpgsql as $$
declare v uuid;
begin
  v := app.ai_begin_request(pg_temp.id('org_a'), 'drafting', 'claude-sonnet-5-5', p_table, pg_temp.id(p_subject));
  perform app.ai_complete_request(v, 'Answered', 'Draft the list.', 'Drafted.', 100, 40);
  insert into world values (p_key, v);
  return v;
end $$;

create function pg_temp.cue_line(p_key text, p_request text, p_label text, p_at text) returns uuid
language plpgsql as $$
declare v uuid;
begin
  v := app.ai_propose_suggestion(pg_temp.id(p_request), 'cues.create', null, 'Add cue: ' || p_label, jsonb_build_array(
    jsonb_build_object('field_path', 'label', 'value', p_label, 'confidence', 0.8),
    case when p_at is null
      then jsonb_build_object('field_path', 'planned_at', 'refusal', 'NO_ANSWER', 'missing', 'The context gives no time.')
      else jsonb_build_object('field_path', 'planned_at', 'value', p_at, 'confidence', 0.7) end,
    jsonb_build_object('field_path', 'duration', 'value', '00:30:00', 'confidence', 0.6),
    jsonb_build_object('field_path', 'segment', 'refusal', 'NO_ANSWER', 'missing', 'No segment was proposed.')));
  insert into world values (p_key, v);
  return v;
end $$;

create function pg_temp.risk_line(p_key text, p_request text, p_title text, p_subtype text) returns uuid
language plpgsql as $$
declare v uuid;
begin
  v := app.ai_propose_suggestion(pg_temp.id(p_request), 'records.create', null, 'Add risk: ' || p_title, jsonb_build_array(
    jsonb_build_object('field_path', 'record_kind', 'value', 'Risk', 'confidence', 1),
    jsonb_build_object('field_path', 'record_subtype', 'value', p_subtype, 'confidence', 0.7),
    jsonb_build_object('field_path', 'title', 'value', p_title, 'confidence', 0.8),
    jsonb_build_object('field_path', 'risk.likelihood', 'value', 3, 'confidence', 0.5),
    jsonb_build_object('field_path', 'risk.impact', 'refusal', 'NO_ANSWER', 'missing', 'The context does not support a rating.'),
    jsonb_build_object('field_path', 'risk.mitigation', 'value', 'Brief the crew before doors.', 'confidence', 0.6)));
  insert into world values (p_key, v);
  return v;
end $$;

create function pg_temp.item(p_suggestion text, p_values jsonb default '{}') returns jsonb
language sql stable as $$ select jsonb_build_object('suggestion_id', pg_temp.id(p_suggestion), 'values', p_values) $$;

-- The hint a statement raises, to show that a refusal keeps its rule.
create function pg_temp.hint_of(p_sql text) returns text
language plpgsql as $$
declare v text;
begin
  execute p_sql;
  return null;
exception when others then
  get stacked diagnostics v = pg_exception_hint;
  return v;
end $$;

select pg_temp.as_user('bob');
insert into app.ai_settings (org_id, drafting_enabled, extraction_enabled) values (pg_temp.id('org_a'), true, true);

select pg_temp.as_user('dave');
with x as (insert into app.run_of_show (project_id, scope_node_id, name, show_date)
  values (pg_temp.id('prj_a'), pg_temp.id('show_a'), 'Opening Night Running Order', '2027-06-05') returning id)
  insert into world select 'ros', id from x;
with x as (insert into app.run_of_show (project_id, scope_node_id, name, show_date)
  values (pg_temp.id('prj_a'), pg_temp.id('show_a'), 'Closing Night Running Order', '2027-06-06') returning id)
  insert into world select 'ros2', id from x;

-- Emptiness -------------------------------------------------------------------------------------------------------------
select is(app.drafted_list_is_empty('run_of_show', pg_temp.id('ros')), true, 'a running order without cues is empty');
with x as (insert into app.cues (run_of_show_id, position, label) values (pg_temp.id('ros'), 1, 'House to Half') returning id)
  insert into world select 'cue_live', id from x;
select is(app.drafted_list_is_empty('run_of_show', pg_temp.id('ros')), false, 'a live cue fills the running order');
select pg_temp.as_platform();
update app.cues set deleted_at = now() where id = pg_temp.id('cue_live');
select pg_temp.as_user('dave');
select is(app.drafted_list_is_empty('run_of_show', pg_temp.id('ros')), true, 'a trashed cue does not count');
select is(app.drafted_list_is_empty('risk_assessment', pg_temp.id('prj_a')), true, 'a project without Risk records has an empty risk list');
select throws_ok($$select app.drafted_list_is_empty('budget', (select id from world where key = 'prj_a'))$$,
  'XR001', 'aurora_draft_kind: Aurora drafts only a run of show or a risk assessment into a list.', 'only the two list kinds are drafted');
select pg_temp.as_user('gina');
select throws_ok($$select app.drafted_list_is_empty('run_of_show', (select id from world where key = 'ros'))$$,
  '42501', null, 'a Viewer without show.run_of_show.write is refused');
select throws_ok($$select app.drafted_list_is_empty('risk_assessment', (select id from world where key = 'prj_a'))$$,
  '42501', null, 'a Viewer without work.record.write is refused');
select pg_temp.as_user('xavier');
select throws_ok($$select app.drafted_list_is_empty('run_of_show', (select id from world where key = 'ros'))$$,
  '42501', null, 'another org is refused');

-- A Risk record the caller cannot see still fills the list: erin may write prj_a2's records by a project grant, not read them.
select pg_temp.as_platform();
insert into app.user_capability_grants (org_id, membership_id, capability_code, scope_kind, scope_id, reason)
values (pg_temp.id('org_a'), pg_temp.id('erin@org_a'), 'work.record.write', 'project', pg_temp.id('prj_a2'), 'Drafts the gala risk list.');
select pg_temp.as_user('erin');
select is(app.drafted_list_is_empty('risk_assessment', pg_temp.id('prj_a2')), true, 'a project-scoped grant lets erin check the gala risk list');
select pg_temp.as_user('alice');
with x as (insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis)
  values (pg_temp.id('prj_a2'), 'Risk', 'Safety', 'Icy Loading Ramp', 'Z', 'Declared') returning id)
  insert into world select 'gala_risk', id from x;
select pg_temp.as_user('erin');
select is((select count(*)::int from app.records where project_id = pg_temp.id('prj_a2')), 0, 'erin cannot see the gala''s Risk record');
select is(app.drafted_list_is_empty('risk_assessment', pg_temp.id('prj_a2')), false, 'the Risk record erin cannot see still fills the list');

-- The transition guard ------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select pg_temp.drafted_request('req_ros', 'app.run_of_show', 'ros');
select pg_temp.cue_line('s1', 'req_ros', 'Doors', '2027-06-05T23:00:00Z');
select pg_temp.cue_line('s2', 'req_ros', 'Headliner Walk-On', null);
select pg_temp.cue_line('s3', 'req_ros', 'House Lights Up', '2027-06-06T03:00:00Z');
select pg_temp.cue_line('s4', 'req_ros', 'Encore', '2027-06-06T02:30:00Z');
select throws_ok($$select app.transition_ai_suggestion((select id from world where key = 's1'), 'Proposed', 'Confirmed', 'One at a time.')$$,
  'XR001', 'ai_suggestion_drafted_list: Confirm a drafted list as a whole so it only fills an empty list.',
  'a drafted line cannot be confirmed one at a time');
select lives_ok($$select app.transition_ai_suggestion((select id from world where key = 's4'), 'Proposed', 'Rejected', 'Not this one.')$$,
  'a drafted line can still be rejected one at a time');

-- An extraction suggestion still confirms and applies as before.
select lives_ok($$insert into world select 'req_ext', app.ai_begin_request((select id from world where key = 'org_a'), 'extraction', 'claude-sonnet-5-5')$$,
  'an extraction request starts');
select lives_ok($$select app.ai_complete_request((select id from world where key = 'req_ext'), 'Answered', 'q', 'a')$$, 'and answers');
select lives_ok($$insert into world select 's_ext', app.ai_propose_suggestion((select id from world where key = 'req_ext'), 'insuranceCertificates.create', null,
  'Add the certificate.', '[{"field_path": "insurer", "value": "Atlantic Mutual", "confidence": 0.9}]')$$, 'and proposes a change');
select lives_ok($$select app.transition_ai_suggestion((select id from world where key = 's_ext'), 'Proposed', 'Confirmed', 'Checked.')$$,
  'an extraction suggestion is confirmed on its own');
select lives_ok($$select app.transition_ai_suggestion((select id from world where key = 's_ext'), 'Confirmed', 'Applied', 'Written.',
  (select id from world where key = 'ros'))$$, 'and applied with the record written');
select is((select applied_id from app.ai_suggestions where id = pg_temp.id('s_ext')), pg_temp.id('ros'), 'the applied id is recorded as before');

-- Refusals before anything is written -----------------------------------------------------------------------------------------
select pg_temp.as_user('erin');
select throws_ok($$select app.apply_drafted_list((select id from world where key = 'req_ros'), jsonb_build_array(pg_temp.item('s1')))$$,
  '42501', null, 'another person''s request is refused');
select pg_temp.as_user('dave');
select throws_ok($$select app.apply_drafted_list((select id from world where key = 'req_ext'), jsonb_build_array(pg_temp.item('s1')))$$,
  'XR001', 'aurora_draft_request_invalid: This request did not draft a run of show or a risk assessment.', 'a request that drafted no list is refused');
select lives_ok($$insert into world select 'req_plain', app.ai_begin_request((select id from world where key = 'org_a'), 'drafting', 'claude-sonnet-5-5')$$,
  'a drafting request without a list starts');
select lives_ok($$select app.ai_complete_request((select id from world where key = 'req_plain'), 'Answered', 'q', 'a')$$, 'and answers');
select throws_ok($$select app.apply_drafted_list((select id from world where key = 'req_plain'), jsonb_build_array(pg_temp.item('s1')))$$,
  'XR001', 'aurora_draft_request_invalid: This request did not draft a run of show or a risk assessment.', 'a draft with no list subject is refused');
select lives_ok($$insert into world select 'req_pending', app.ai_begin_request((select id from world where key = 'org_a'), 'drafting', 'claude-sonnet-5-5',
  'app.run_of_show', (select id from world where key = 'ros'))$$, 'a drafted list still Pending');
select throws_ok($$select app.apply_drafted_list((select id from world where key = 'req_pending'), jsonb_build_array(pg_temp.item('s1')))$$,
  'XR001', 'aurora_draft_request_invalid: This request did not draft a run of show or a risk assessment.', 'an unanswered request is refused');
select throws_ok($$select app.apply_drafted_list((select id from world where key = 'req_ros'), jsonb_build_array(pg_temp.item('s_ext')))$$,
  'XR001', 'aurora_draft_item_invalid: Line 1 is not part of this draft.', 'a suggestion of another request is refused');
select throws_ok($$select app.apply_drafted_list((select id from world where key = 'req_ros'), jsonb_build_array(pg_temp.item('s1'), pg_temp.item('s1')))$$,
  'XR001', 'aurora_draft_item_invalid: Line 2 is listed twice.', 'a line listed twice is refused');
select throws_ok($$select app.apply_drafted_list((select id from world where key = 'req_ros'), jsonb_build_array(pg_temp.item('s4')))$$,
  'XR001', 'aurora_draft_item_invalid: Line 1 is no longer proposed.', 'a rejected line is refused');
select throws_ok($$select app.apply_drafted_list((select id from world where key = 'req_ros'), jsonb_build_array(pg_temp.item('s1', '{"position": 9}')))$$,
  'XR001', 'aurora_draft_item_invalid: Line 1 cannot set position.', 'values set only the list''s own fields, never the position');
select throws_ok($$select app.apply_drafted_list((select id from world where key = 'req_ros'), jsonb_build_array(pg_temp.item('s1', '{"duration": "30 minutes"}')))$$,
  'XR001', 'aurora_draft_item_invalid: Line 1: a duration is HH:MM:SS, up to 24 hours.', 'a duration that is not HH:MM:SS is refused');
select throws_ok($$select app.apply_drafted_list((select id from world where key = 'req_ros'), '[]')$$,
  'XR001', 'aurora_draft_item_invalid: Add between 1 and 60 lines.', 'an empty list of lines is refused');
select throws_ok($$select app.apply_drafted_list((select id from world where key = 'req_ros'),
  (select jsonb_agg(jsonb_build_object('suggestion_id', gen_random_uuid())) from generate_series(1, 61)))$$,
  'XR001', 'aurora_draft_item_invalid: Add between 1 and 60 lines.', 'more than 60 cues are refused');
select throws_like($$select app.apply_drafted_list((select id from world where key = 'req_ros'),
  jsonb_build_array(pg_temp.item('s1'), pg_temp.item('s3', jsonb_build_object('label', repeat('x', 201)))))$$,
  'Line 2: %', 'a label the database refuses names its line');
select is((select count(*)::int from app.cues where run_of_show_id = pg_temp.id('ros') and deleted_at is null), 0,
  'the refused line rolled back the whole call');

-- The list filled between the draft and the apply
with x as (insert into app.cues (run_of_show_id, position, label) values (pg_temp.id('ros'), 1, 'Added by hand') returning id)
  insert into world select 'cue_hand', id from x;
select throws_ok($$select app.apply_drafted_list((select id from world where key = 'req_ros'), jsonb_build_array(pg_temp.item('s1')))$$,
  'XR001', 'aurora_draft_list_not_empty: This running order already has cues. Aurora only drafts into an empty list.',
  'a running order that gained a cue since the draft is refused');
select is((select count(*)::int from app.cues where run_of_show_id = pg_temp.id('ros') and deleted_at is null), 1, 'nothing was written');
select is((select count(*)::int from app.ai_suggestions where request_id = pg_temp.id('req_ros') and suggestion_state = 'Proposed'), 3,
  'every line of the draft is still Proposed');
select pg_temp.as_platform();
update app.cues set deleted_at = now() where id = pg_temp.id('cue_hand');

-- Another org's request about this org's list: metered in one org, written into another.
with x as (insert into app.ai_requests (org_id, person_id, feature, model, subject_table, subject_id, outcome, completed_at)
  values (pg_temp.id('org_b'), pg_temp.id('dave'), 'drafting', 'claude-sonnet-5-5', 'app.run_of_show', pg_temp.id('ros'), 'Answered', now())
  returning id)
  insert into world select 'req_cross', id from x;
select pg_temp.as_user('dave');
select throws_ok($$select app.apply_drafted_list((select id from world where key = 'req_cross'), jsonb_build_array(pg_temp.item('s1')))$$,
  'XR001', 'aurora_draft_request_invalid: This request was made in another org than the list it drafted.',
  'a request of another org than the list is refused');

-- An expired line
select pg_temp.drafted_request('req_ros2', 'app.run_of_show', 'ros2');
select pg_temp.cue_line('s_old', 'req_ros2', 'Soundcheck', '2027-06-06T20:00:00Z');
select pg_temp.as_platform();
update app.ai_suggestions set expires_at = now() - interval '1 minute' where id = pg_temp.id('s_old');
select pg_temp.as_user('dave');
select throws_ok($$select app.apply_drafted_list((select id from world where key = 'req_ros2'), jsonb_build_array(pg_temp.item('s_old')))$$,
  'XR001', 'aurora_draft_item_invalid: Line 1 has expired. Ask Aurora for a fresh draft.', 'an expired line is refused');

-- Applying a running order ---------------------------------------------------------------------------------------------------
select is(app.apply_drafted_list(pg_temp.id('req_ros'), jsonb_build_array(
    pg_temp.item('s2', '{"label": "Headliner On", "planned_at": "2027-06-06T01:00:00Z"}'),
    pg_temp.item('s1'))) -> 'rejected', '1'::jsonb,
  'the drafted running order is applied and the line left out is rejected');
select results_eq($$select position, label, planned_at, duration, segment from app.cues
    where run_of_show_id = (select id from world where key = 'ros') and deleted_at is null order by position$$,
  $$values (1, 'Headliner On'::text, '2027-06-06T01:00:00Z'::timestamptz, interval '30 minutes', null::text),
           (2, 'Doors'::text, '2027-06-05T23:00:00Z'::timestamptz, interval '30 minutes', null::text)$$,
  'cues are numbered in the given order with the edited values, and a NO_ANSWER field stays empty');
select results_eq($$select suggestion_state::text, applied_id is not null from app.ai_suggestions
    where id in ((select id from world where key = 's1'), (select id from world where key = 's2')) order by 1$$,
  $$values ('Applied', true), ('Applied', true)$$, 'each kept line is Applied with the cue it wrote');
select is((select applied_id from app.ai_suggestions where id = pg_temp.id('s2')),
  (select id from app.cues where run_of_show_id = pg_temp.id('ros') and position = 1 and deleted_at is null), 'the applied id is the cue written');
select is((select suggestion_state::text from app.ai_suggestions where id = pg_temp.id('s3')), 'Rejected', 'the line left out is Rejected');
select ok(exists (select 1 from app.ai_suggestion_state_transitions t where t.suggestion_id = pg_temp.id('s3')
  and t.reason = 'Left out when the drafted list was confirmed.'), 'with the reason it was left out');
select ok(exists (select 1 from app.ai_suggestion_state_transitions t where t.suggestion_id = pg_temp.id('s1') and t.to_state = 'Confirmed'),
  'the confirmation is in the ledger');
select is(app.drafted_list_is_empty('run_of_show', pg_temp.id('ros')), false, 'the running order is no longer empty');
select throws_ok($$select app.apply_drafted_list((select id from world where key = 'req_ros'), jsonb_build_array(pg_temp.item('s3')))$$,
  'XR001', 'aurora_draft_list_not_empty: This running order already has cues. Aurora only drafts into an empty list.',
  'a drafted list is applied once');

-- Applying a risk assessment ----------------------------------------------------------------------------------------------------
select pg_temp.drafted_request('req_risk', 'app.projects', 'prj_a');
select pg_temp.risk_line('r1', 'req_risk', 'Crowd Surge at the Barricade', 'Safety');
select pg_temp.risk_line('r2', 'req_risk', 'Afternoon Thunderstorm', 'Operational');
select pg_temp.risk_line('r3', 'req_risk', 'Sponsor Banner Delay', 'Commercial');
select throws_ok($$select app.apply_drafted_list((select id from world where key = 'req_risk'), jsonb_build_array(pg_temp.item('r1', '{"record_subtype": "Weather"}')))$$,
  'XR001', 'aurora_draft_item_invalid: Line 1: the category is not a Risk category.', 'a category outside the canon Risk subtypes is refused');
select throws_ok($$select app.apply_drafted_list((select id from world where key = 'req_risk'), jsonb_build_array(pg_temp.item('r1', '{"risk.mitigation": " "}')))$$,
  'XR001', 'aurora_draft_item_invalid: Line 1 needs a mitigation of 1 to 2,000 characters.', 'a blank mitigation is refused');
select throws_like($$select app.apply_drafted_list((select id from world where key = 'req_risk'),
  jsonb_build_array(pg_temp.item('r2'), pg_temp.item('r1', '{"risk.likelihood": 7}')))$$,
  'Line 2: %', 'a rating outside 1 to 5 names its line');
select throws_like($$select app.apply_drafted_list((select id from world where key = 'req_risk'),
  jsonb_build_array(pg_temp.item('r1', '{"title": "The crowd is too large"}')))$$,
  'record_title_grammar: Line 1: %', 'a title the grammar refuses names its line after the rule');
select is(pg_temp.hint_of($$select app.apply_drafted_list((select id from world where key = 'req_risk'),
  jsonb_build_array(pg_temp.item('r1', '{"title": "The crowd is too large"}')))$$), 'record_title_grammar',
  'the refusal keeps its rule in the hint');
select is((select count(*)::int from app.records where project_id = pg_temp.id('prj_a') and record_kind = 'Risk'), 0,
  'the refused calls wrote no Risk record');
select is((app.apply_drafted_list(pg_temp.id('req_risk'), jsonb_build_array(
    pg_temp.item('r1', '{"risk.impact": 5}'),
    pg_temp.item('r2', '{"record_subtype": "Schedule", "risk.likelihood": null}'))) -> 'written') -> 1 ->> 'suggestion_id',
  pg_temp.id('r2')::text, 'the drafted risk assessment is applied in the given order');
select results_eq($$select r.record_subtype::text, r.title, r.xyz::text, r.xyz_basis::text, r.record_state, k.likelihood, k.impact, k.score, k.mitigation
    from app.records r join app.record_risk k on k.record_id = r.id
    where r.project_id = (select id from world where key = 'prj_a') and r.record_kind = 'Risk' order by r.record_number$$,
  $$values ('Safety'::text, 'Crowd Surge at the Barricade'::text, 'Z'::text, 'Declared'::text, 'Proposed'::text, 3::smallint, 5::smallint, 15::smallint, 'Brief the crew before doors.'::text),
           ('Schedule'::text, 'Afternoon Thunderstorm'::text, 'Z'::text, 'Declared'::text, 'Proposed'::text, null::smallint, null::smallint, null::smallint, 'Brief the crew before doors.'::text)$$,
  'Risk records carry the chosen category, xyz Z Declared, state Proposed and their likelihood, impact and mitigation');
select is((select suggestion_state::text from app.ai_suggestions where id = pg_temp.id('r3')), 'Rejected', 'the risk left out is Rejected');
select is(app.drafted_list_is_empty('risk_assessment', pg_temp.id('prj_a')), false, 'the project''s risk list is no longer empty');
select throws_ok($$select app.apply_drafted_list((select id from world where key = 'req_risk'), jsonb_build_array(pg_temp.item('r3')))$$,
  'XR001', 'aurora_draft_list_not_empty: This list already has entries, including archived or canceled ones. Aurora only drafts into an empty list.',
  'a risk list with entries refuses with both causes named');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'ai_suggestion.applied' and subject_id in
  (pg_temp.id('r1'), pg_temp.id('r2'), pg_temp.id('s1'), pg_temp.id('s2'))), 4, 'each applied line emits ai_suggestion.applied');

-- Privileges --------------------------------------------------------------------------------------------------------------------
select ok(not has_function_privilege('anon', 'app.drafted_list_is_empty(text, uuid)', 'execute'), 'anon cannot check a list');
select ok(not has_function_privilege('anon', 'app.apply_drafted_list(uuid, jsonb)', 'execute'), 'anon cannot apply a list');
select ok(has_function_privilege('authenticated', 'app.drafted_list_is_empty(text, uuid)', 'execute')
  and has_function_privilege('authenticated', 'app.apply_drafted_list(uuid, jsonb)', 'execute'), 'signed-in callers can');
select ok(not has_function_privilege('anon', 'app.transition_ai_suggestion(uuid, app.ai_suggestion_state, app.ai_suggestion_state, text, uuid)', 'execute'),
  'anon still cannot move a suggestion');
select is((select count(*)::int from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and p.proname in ('drafted_list_is_empty', 'apply_drafted_list', 'transition_ai_suggestion')
      and p.prosecdef and 'search_path=""' = any (coalesce(p.proconfig, '{}'))), 3,
  'the three functions are definers with an empty search_path');
select pg_temp.as_anon();
select throws_ok($$select app.apply_drafted_list((select id from world where key = 'req_risk'), '[]')$$, '42501', null, 'anon is refused');

select * from finish();
rollback;

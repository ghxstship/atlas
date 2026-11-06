-- pgTAP: migration 2992 (B10, G-129), crew registrations. Submitting and every refusal, deciding with per-row results and
-- separation of duties, inviting with its skips, the two reads, and account deletion.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select no_plan();

create function pg_temp.refusal(p_sql text) returns text
language plpgsql as $$
declare
  v_hint text;
begin
  execute p_sql;
  return null;
exception when sqlstate 'XR001' then
  get stacked diagnostics v_hint = pg_exception_hint;
  return v_hint;
end $$;
grant execute on function pg_temp.refusal(text) to public;

create function pg_temp.submit(p_page text, p_answers jsonb, p_confirm boolean default true, p_share uuid default null) returns uuid
language sql as $$ select app.submit_crew_registration('northwind-live', p_page, p_answers, p_confirm, p_share) $$;
grant execute on function pg_temp.submit(text, jsonb, boolean, uuid) to public;

create function pg_temp.answers() returns jsonb
language sql as $$ select jsonb_build_array(jsonb_build_object('question_id', pg_temp.id('q1'), 'answer', 'Rigging')) $$;
grant execute on function pg_temp.answers() to public;

select pg_temp.as_platform();
select pg_temp.new_user('rae', 'rae@freelance.test', 'Rae Sandoval');
select pg_temp.new_user('liam', 'liam@freelance.test', 'Liam Porter');
create function pg_temp.confirm_age(p_key text) returns void
language plpgsql as $$
begin
  perform pg_temp.as_user(p_key);
  perform app.confirm_minimum_age('Gateway');
  perform pg_temp.as_platform();
end $$;
select pg_temp.confirm_age(k) from unnest(array['ivy', 'quinn', 'rae', 'carol', 'sam']) k;

select pg_temp.as_user('carol');
with p as (insert into app.talent_pools (org_id, name, pool_kind) values (pg_temp.id('org_a'), 'Stagehands', 'Talent') returning id) insert into world select 'pool', id from p;
with p as (insert into app.registration_pages (org_id, slug, title, talent_pool_id, minimum_age) values (pg_temp.id('org_a'), 'summer-crew', 'Summer Crew', pg_temp.id('pool'), 18) returning id) insert into world select 'page', id from p;
with q as (insert into app.registration_page_questions (registration_page_id, prompt, sort_order, is_required) values (pg_temp.id('page'), 'Which skills do you bring?', 1, true) returning id) insert into world select 'q1', id from q;
with q as (insert into app.registration_page_questions (registration_page_id, prompt, sort_order, is_required) values (pg_temp.id('page'), 'Anything else?', 2, false) returning id) insert into world select 'q2', id from q;
select app.transition_registration_page(pg_temp.id('page'), 'Draft', 'Open');
with p as (insert into app.registration_pages (org_id, slug, title, talent_pool_id) values (pg_temp.id('org_a'), 'volunteers', 'Volunteers', pg_temp.id('pool')) returning id) insert into world select 'page16', id from p;
select app.transition_registration_page(pg_temp.id('page16'), 'Draft', 'Open');

-- Submitting ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('rae');
select is(pg_temp.refusal($$select pg_temp.submit('summer-crew', pg_temp.answers(), false)$$), 'registration_age_unconfirmed', 'minimum 18 needs the confirmation');
select is(pg_temp.refusal($$select pg_temp.submit('summer-crew', '[]')$$), 'registration_answer_required', 'a required question must be answered');
select is(pg_temp.refusal(format($$select pg_temp.submit('summer-crew', '[{"question_id": "%s", "answer": "x"}]')$$, gen_random_uuid())), 'registration_answer_unknown', 'an answer names a question of the page');
select is(pg_temp.refusal($$select pg_temp.submit('summer-crew', jsonb_build_array(jsonb_build_object('question_id', pg_temp.id('q1'), 'answer', repeat('x', 4001))))$$), 'registration_answer_length', 'an answer has at most 4000 characters');
select is(pg_temp.refusal($$select pg_temp.submit('no-such-page', pg_temp.answers())$$), 'registration_page_closed', 'a missing page reads closed');

-- A share must be the person's own, for this org.
select pg_temp.as_user('ivy');
insert into world select 'share_ivy', app.share_profile(pg_temp.id('org_a'), array['skills'], array['Rigging']);
select pg_temp.as_user('rae');
select is(pg_temp.refusal($$select pg_temp.submit('summer-crew', pg_temp.answers(), true, pg_temp.id('share_ivy'))$$), 'profile_share_not_yours', 'someone else''s profile share is refused');

insert into world select 'reg_rae', pg_temp.submit('summer-crew', pg_temp.answers());
select pg_temp.as_platform();
select is((select g.confirmed_minimum_age::int from app.crew_registrations g where g.id = pg_temp.id('reg_rae')), 18, 'the minimum age at submission is recorded');
select is((select a.answer from app.crew_registration_answers a where a.crew_registration_id = pg_temp.id('reg_rae')), 'Rigging', 'and the answer');
select pg_temp.as_user('rae');
select is(pg_temp.refusal($$select pg_temp.submit('summer-crew', pg_temp.answers())$$), 'registration_duplicate', 'a second live registration on the page is refused');
select ok(pg_temp.submit('volunteers', '[]', false) is not null, 'a page at the account minimum needs no separate confirmation');

select pg_temp.as_user('liam');
select is(pg_temp.refusal($$select pg_temp.submit('volunteers', '[]')$$), 'registration_age_unconfirmed', 'someone who never confirmed 16+ is refused');
select pg_temp.confirm_age('liam');

-- The rate limit counts successes: register and withdraw ten times, then the eleventh is refused.
select pg_temp.as_user('liam');
select app.withdraw_crew_registration(pg_temp.submit('volunteers', '[]')) from generate_series(1, 10);
select is(pg_temp.refusal($$select pg_temp.submit('volunteers', '[]')$$), 'registration_rate_limited', 'the 11th in an hour is refused');

-- Do Not Engage ----------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into app.pool_members (talent_pool_id, person_id, standing, reason, review_on)
values (pg_temp.id('pool'), pg_temp.id('quinn'), 'Do Not Engage', 'Missed two calls without notice.', '2027-12-31');
select pg_temp.as_user('quinn');
select is(pg_temp.refusal($$select pg_temp.submit('volunteers', '[]')$$), 'registration_page_closed', 'a Do Not Engage person reads the page closed');

-- Deciding ----------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
insert into world select 'reg_ivy', pg_temp.submit('summer-crew', pg_temp.answers());
select pg_temp.as_user('sam');
insert into world select 'reg_sam', pg_temp.submit('summer-crew', pg_temp.answers());
select pg_temp.as_user('carol');
insert into world select 'reg_carol', pg_temp.submit('summer-crew', pg_temp.answers());
select pg_temp.as_user('gina');
select throws_ok(format($$select app.decide_crew_registrations(array['%s']::uuid[], true)$$, pg_temp.id('reg_ivy')), '42501', null, 'deciding needs opportunities.pool.write');
select pg_temp.as_user('carol');
select is(pg_temp.refusal($$select app.decide_crew_registrations('{}'::uuid[], true)$$), 'registration_decide_batch', 'an empty batch is refused');
-- A pool manager's own row is refused and the others are decided.
select is((select r ->> 'code' from jsonb_array_elements(app.decide_crew_registrations(array[pg_temp.id('reg_carol'), pg_temp.id('reg_ivy')], true)) r where r ->> 'id' = pg_temp.id('reg_carol')::text),
  'sod_registration_self', 'deciding one''s own is refused and does not fail the batch');
select pg_temp.as_platform();
select is((select g.registration_state::text from app.crew_registrations g where g.id = pg_temp.id('reg_ivy')), 'Approved', 'the other row was approved');
select is((select m.standing::text from app.pool_members m where m.talent_pool_id = pg_temp.id('pool') and m.person_id = pg_temp.id('ivy') and m.deleted_at is null), 'Approved', 'and made an Approved member');
select ok(exists (select 1 from app.notifications n where n.recipient_person_id = pg_temp.id('ivy') and n.kind = 'crew_registration.decided'), 'the registrant hears the decision');
select ok(exists (select 1 from private.separation_of_duties_rules r where r.code = 'sod_registration_self'), 'sod_registration_self is registered');
select pg_temp.as_user('carol');
select is((select r ->> 'code' from jsonb_array_elements(app.decide_crew_registrations(array[pg_temp.id('reg_ivy')], true)) r), 'registration_not_submitted', 'a decided row is refused');
-- An existing standing is kept.
insert into app.pool_members (talent_pool_id, person_id, standing) values (pg_temp.id('pool'), pg_temp.id('rae'), 'Preferred');
select is((select r ->> 'outcome' from jsonb_array_elements(app.decide_crew_registrations(array[pg_temp.id('reg_rae')], true)) r), 'applied', 'approving a member');
select pg_temp.as_platform();
select is((select m.standing::text from app.pool_members m where m.talent_pool_id = pg_temp.id('pool') and m.person_id = pg_temp.id('rae') and m.deleted_at is null), 'Preferred', 'keeps their standing');
-- Flagged after registering.
select pg_temp.as_user('carol');
insert into app.pool_members (talent_pool_id, person_id, standing, reason, review_on)
values (pg_temp.id('pool'), pg_temp.id('sam'), 'Do Not Engage', 'Fixture.', '2027-12-31');
select is((select r ->> 'code' from jsonb_array_elements(app.decide_crew_registrations(array[pg_temp.id('reg_sam')], true)) r), 'registration_person_excluded', 'a person flagged Do Not Engage is refused');
select pg_temp.as_platform();
update app.pool_members set deleted_at = now() where person_id = pg_temp.id('sam') and talent_pool_id = pg_temp.id('pool');
update app.talent_pools set deleted_at = now() where id = pg_temp.id('pool');
select pg_temp.as_user('carol');
select is((select r ->> 'code' from jsonb_array_elements(app.decide_crew_registrations(array[pg_temp.id('reg_sam')], true)) r), 'registration_page_pool', 'a deleted pool is refused');
select pg_temp.as_platform();
update app.talent_pools set deleted_at = null where id = pg_temp.id('pool');
select pg_temp.as_user('carol');
select is((select r ->> 'outcome' from jsonb_array_elements(app.decide_crew_registrations(array[pg_temp.id('reg_sam')], false, 'Not this season.')) r), 'applied', 'a decline');
select pg_temp.as_platform();
select throws_ok(format($$select private.transition_lifecycle('crew_registration', 'app.crew_registrations', 'registration_state', 'app.crew_registration_state_transitions', 'crew_registration_id', '%s', 'Declined', 'Approved', 'Not a move.')$$, pg_temp.id('reg_sam')),
  'XR001', 'crew_registration_transition_not_allowed: A crew registration cannot move from Declined to Approved.', 'Declined never moves to Approved');

-- Withdrawing --------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('sam');
select is(pg_temp.refusal(format($$select app.withdraw_crew_registration('%s')$$, pg_temp.id('reg_sam'))), 'registration_not_withdrawable', 'a Declined registration cannot be withdrawn');
select throws_ok(format($$select app.withdraw_crew_registration('%s')$$, pg_temp.id('reg_ivy')), '42501', null, 'only the registrant withdraws');

-- Reads ------------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
select results_eq($$select page_title, page_slug, registration_state::text from api_external.my_crew_registrations$$,
  $$values ('Summer Crew'::text, 'summer-crew'::text, 'Approved'::text)$$, 'the registrant reads only their own rows');
select is((select count(*)::int from information_schema.columns c where c.table_schema = 'api_external' and c.table_name = 'my_crew_registrations' and (c.column_name like '%pool%' or c.column_name like '%reason%')), 0, 'with no pool and no reason');
select pg_temp.as_user('carol');
select ok(exists (select 1 from app.crew_registration_list l where l.id = pg_temp.id('reg_ivy') and l.full_name = 'Ivy Marchetti' and l.confirmed_minimum_age = 18), 'a reader reads the queue with the name');
select pg_temp.as_platform();
select ok(not has_table_privilege('xos_backup', 'app.crew_registration_list', 'select'), 'xos_backup cannot select the queue');
select pg_temp.as_user('nina');
select is((select count(*)::int from app.crew_registration_list), 0, 'a reader without opportunities.application.read reads nothing');

-- Inviting -----------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into app.pool_members (talent_pool_id, person_id, standing) values (pg_temp.id('pool'), pg_temp.id('frank'), 'Approved'), (pg_temp.id('pool'), pg_temp.id('gina'), 'Approved'), (pg_temp.id('pool'), pg_temp.id('nina'), 'Approved');
select pg_temp.as_user('gina');
select throws_ok(format($$select app.invite_to_registration_page('%s')$$, pg_temp.id('page')), '42501', null, 'inviting needs opportunities.pool.write');
select pg_temp.as_user('carol');
-- frank and gina are members of the org and reachable; nina has no tie to the org, so private.notify skips her; rae is already registered.
select is(app.invite_to_registration_page(pg_temp.id('page')), 2, 'live members are invited; registered people and people private.notify cannot reach are not');
select pg_temp.as_platform();
select ok(exists (select 1 from app.notifications n where n.recipient_person_id = pg_temp.id('frank') and n.kind = 'crew_registration.invited'), 'the member receives crew_registration.invited');
select ok(not exists (select 1 from app.notifications n where n.recipient_person_id = pg_temp.id('rae') and n.kind = 'crew_registration.invited'), 'a registered person does not');
select ok(not exists (select 1 from app.notifications n where n.recipient_person_id = pg_temp.id('quinn') and n.kind = 'crew_registration.invited'), 'nor a Do Not Engage person');
select pg_temp.as_user('carol');
select is(app.invite_to_registration_page(pg_temp.id('page')), 0, 'people invited in the last 7 days are skipped');
-- Past crew on request: art's engagement is Complete.
select pg_temp.move_engagement('eng_art_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_art_a', 'Active', 'Closing');
select pg_temp.move_engagement('eng_art_a', 'Closing', 'Complete');
select pg_temp.as_user('carol');
select is(app.invite_to_registration_page(pg_temp.id('page')), 0, 'without the flag past crew stay out');
select is(app.invite_to_registration_page(pg_temp.id('page'), true), 1, 'with it, a Complete engagement in the last 24 months is invited');

-- A closed page cannot invite.
select app.transition_registration_page(pg_temp.id('page16'), 'Open', 'Closed');
select is(pg_temp.refusal(format($$select app.invite_to_registration_page('%s')$$, pg_temp.id('page16'))), 'registration_page_closed', 'inviting needs an Open page');

-- The limit: more than 1000 candidates.
select pg_temp.as_platform();
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
select gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'bulk' || g || '@bulk.test', now(),
  jsonb_build_object('full_name', 'Bulk ' || g), now(), now() from generate_series(1, 1001) g;
insert into app.pool_members (talent_pool_id, person_id, standing)
select pg_temp.id('pool'), p.id, 'Approved' from app.people p join auth.users u on u.id = p.user_id where u.email like '%@bulk.test';
select pg_temp.as_user('carol');
select is(pg_temp.refusal(format($$select app.invite_to_registration_page('%s')$$, pg_temp.id('page'))), 'registration_invite_limit', 'more than 1000 people is refused');

-- Account deletion -----------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
select app.delete_my_account('ivy@freelance.test');
select pg_temp.as_platform();
select is((select g.registration_state::text from app.crew_registrations g where g.id = pg_temp.id('reg_ivy')), 'Withdrawn', 'deleting the account withdraws an Approved registration');
select is((select t.reason from app.crew_registration_state_transitions t where t.crew_registration_id = pg_temp.id('reg_ivy') and t.to_state = 'Withdrawn'), 'Account deleted.', 'with the reason');
select is((select count(*)::int from app.crew_registration_answers a where a.crew_registration_id = pg_temp.id('reg_ivy')), 0, 'and removes their answers');
select is((select count(*)::int from app.pool_members m where m.person_id = pg_temp.id('ivy') and m.talent_pool_id = pg_temp.id('pool') and m.deleted_at is null), 1, 'pool membership stays');

-- Someone whose only tie is a registration still records an erasure in the org.
select pg_temp.as_user('rae');
select app.delete_my_account('rae@freelance.test');
select pg_temp.as_platform();
select ok(exists (select 1 from app.dsar_requests d where d.org_id = pg_temp.id('org_a') and d.subject_person_id = pg_temp.id('rae') and d.request_type = 'Erasure'), 'a person whose only tie is a registration gets an Erasure row');

select * from finish();
rollback;

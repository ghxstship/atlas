-- pgTAP: migration 2752 (R12), training before positions and placing agency staff. What is due follows role type,
-- blocking and jurisdiction; only the person acknowledges and the verifier is never the person (sod_roster_training);
-- every refusal of app.assign_roster_shift is reached; the agency's lead and a crew.shift.write holder both place;
-- reassigning and unassigning move the shift's state; slate seeding creates Draft entries idempotently, for a slate
-- person only once they confirm their membership, and skips an engagement whose names lock has passed.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2750_agency_world.psql

select no_plan();

create function pg_temp.due(p_entry text) returns text[]
language sql security definer as $$
  select coalesce(array_agg(q.name order by q.name), '{}') from private.roster_training_due(pg_temp.id(p_entry)) d (id)
  join app.onboarding_requirements q on q.id = d.id
$$;
grant execute on function pg_temp.due(text) to public;

create function pg_temp.entries_of(p_person text) returns text
language sql security definer as $$
  select coalesce(string_agg(r.entry_state || '/' || r.person_response, ','), '') from app.engagement_roster_entries r
  where r.engagement_id = pg_temp.id('eng_agency') and r.person_id = pg_temp.id(p_person) and r.deleted_at is null
$$;
grant execute on function pg_temp.entries_of(text) to public;

-- Slate seeding ---------------------------------------------------------------------------------------------------------------------
select is(pg_temp.entries_of('stella') || ' ' || pg_temp.entries_of('theo'), 'Accepted/Accepted Accepted/Accepted',
  'the award seeded Stella''s and Theo''s entries, which the world then took through review');
select is(pg_temp.entries_of('uma'), '', 'Uma has not confirmed her membership, so she has no entry');
select is(private.seed_slate_entries(pg_temp.id('eng_agency')), 0, 'seeding again adds nobody');

select pg_temp.as_user('carol');
select app.set_roster_lock(pg_temp.id('eng_agency'), now() - interval '1 minute');
select pg_temp.as_user('uma');
select lives_ok($$select app.accept_account_membership(pg_temp.membership('acct_s', 'uma'))$$,
  'Uma confirms after the names lock passed, without an error');
select is(pg_temp.entries_of('uma'), '', 'and gets no entry');
select pg_temp.as_user('carol');
select app.set_roster_lock(pg_temp.id('eng_agency'), null);
select pg_temp.as_user('uma');
select app.accept_account_membership(pg_temp.membership('acct_s', 'uma'));
select is(pg_temp.entries_of('uma'), 'Draft/Pending', 'once the lock is lifted, confirming seeds her Draft entry; she still accepts');
select app.accept_account_membership(pg_temp.membership('acct_s', 'uma'));
select is(pg_temp.entries_of('uma'), 'Draft/Pending', 'confirming again seeds nothing more');
select pg_temp.as_platform();
insert into world select 'e_uma', r.id from app.engagement_roster_entries r
where r.engagement_id = pg_temp.id('eng_agency') and r.person_id = pg_temp.id('uma');
select is((select role_code from app.engagement_roster_entries where id = pg_temp.id('e_uma')), '5000.51.02', 'with the engagement''s role');

-- What is due --------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into app.onboarding_requirements (org_id, name, item_kind, role_type, jurisdiction_id, verification_method, is_blocking) values
  (pg_temp.id('org_a'), 'Crowd Safety Training', 'Training', 'Staff', 'US-FL', 'Reviewer', true),
  (pg_temp.id('org_a'), 'Code of Conduct', 'Acknowledgment', null, null, 'Automatic', true),
  (pg_temp.id('org_a'), 'Optional Radio Course', 'Training', 'Staff', null, 'Reviewer', false),
  (pg_temp.id('org_a'), 'Vendor Load-In Briefing', 'Training', 'Vendor', null, 'Reviewer', true),
  (pg_temp.id('org_a'), 'Dubai Site Induction', 'Training', 'Staff', 'AE', 'Reviewer', true),
  (pg_temp.id('org_a'), 'Staff W-9', 'Tax Form', 'Staff', null, 'Reviewer', true);
select pg_temp.as_platform();
insert into world select 'req_' || split_part(lower(name), ' ', 1), id from app.onboarding_requirements
where org_id = pg_temp.id('org_a') and name in ('Crowd Safety Training', 'Code of Conduct', 'Staff W-9');
select is(pg_temp.due('e_stella'), array['Code of Conduct', 'Crowd Safety Training'],
  'blocking Staff and every-role training and acknowledgments in the project''s jurisdiction are due; optional, other-role, other-place and non-training ones are not');

-- Placing before training ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('olga');
select is(pg_temp.refusal($$select app.assign_roster_shift(pg_temp.id('slot_1'), pg_temp.id('e_stella'))$$), 'roster_training_incomplete',
  'Stella cannot be placed before her training');
select pg_temp.as_user('stella');
select is((select array_agg(name || ':' || is_satisfied order by name) from api_external.my_roster_training),
  array['Code of Conduct:false', 'Crowd Safety Training:false'], 'Stella reads what is due on her entry');

-- Acknowledging ---------------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('theo');
select throws_ok($$select app.acknowledge_roster_training(pg_temp.id('e_stella'), pg_temp.id('req_crowd'))$$, '42501', null,
  'Theo cannot acknowledge for Stella');
select pg_temp.as_user('olga');
select throws_ok($$select app.acknowledge_roster_training(pg_temp.id('e_stella'), pg_temp.id('req_crowd'))$$, '42501', null,
  'nor can the agency');
select pg_temp.as_user('stella');
select is(pg_temp.refusal($$select app.acknowledge_roster_training(pg_temp.id('e_stella'), pg_temp.id('req_staff'))$$), 'roster_training_not_due',
  'a tax form is not training');
insert into world select 'tr_crowd', app.acknowledge_roster_training(pg_temp.id('e_stella'), pg_temp.id('req_crowd'));
select app.acknowledge_roster_training(pg_temp.id('e_stella'), pg_temp.id('req_code'));
select is(pg_temp.due('e_stella'), array['Crowd Safety Training'], 'an automatic acknowledgment is satisfied at once; a reviewed one waits');
select pg_temp.as_user('carol');
select is((select due_count || '/' || awaiting_verification from app.roster_training_summary(array[pg_temp.id('e_stella')])), '1/1',
  'the production sees one requirement due, waiting only on its verification');
select pg_temp.as_user('victor');
select is((select count(*)::int from app.roster_training_summary(array[pg_temp.id('e_stella')])), 0, 'another party sees nothing');
select pg_temp.as_user('stella');
select is(pg_temp.refusal($$select app.acknowledge_roster_training(pg_temp.id('e_stella'), pg_temp.id('req_code'))$$), 'roster_training_not_due',
  'and is not due again');

-- Verifying --------------------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('stella');
select throws_ok($$select app.verify_roster_training(pg_temp.id('tr_crowd'), 'Passed')$$, '42501', null, 'the person cannot verify');
select pg_temp.producer('trainer', 'opportunities.onboarding.write');
select pg_temp.as_user('olga');
select app.add_account_member(pg_temp.id('acct_s'), pg_temp.id('trainer'), 'Account Member');
select pg_temp.as_user('trainer');
select app.accept_account_membership(pg_temp.membership('acct_s', 'trainer'));
select pg_temp.as_user('olga');
insert into world select 'e_trainer', app.add_roster_entry(pg_temp.id('eng_agency'), pg_temp.id('trainer'), '5000.51.02');
select pg_temp.as_user('trainer');
select app.respond_roster_entry(pg_temp.id('e_trainer'), 'Accepted');
insert into world select 'tr_self', app.acknowledge_roster_training(pg_temp.id('e_trainer'), pg_temp.id('req_crowd'));
select is(pg_temp.refusal($$select app.verify_roster_training(pg_temp.id('tr_self'), 'Passed')$$), 'sod_roster_training',
  'a verifier who is on the entry cannot verify their own training');
select pg_temp.as_user('carol');
select app.verify_roster_training(pg_temp.id('tr_crowd'), 'Failed');
select is(pg_temp.due('e_stella'), array['Crowd Safety Training'], 'a failed verification leaves it due');
select pg_temp.as_user('stella');
select app.acknowledge_roster_training(pg_temp.id('e_stella'), pg_temp.id('req_crowd'));
select pg_temp.as_platform();
select is((select num_nulls(verified_by, verified_at, verification_outcome) from app.roster_training_records where id = pg_temp.id('tr_crowd')), 3,
  'acknowledging again clears the failed verification');
select pg_temp.as_user('carol');
select app.verify_roster_training(pg_temp.id('tr_crowd'), 'Passed');
select is(pg_temp.due('e_stella'), '{}'::text[], 'nothing is due once it passes');

-- Placing: crew.shift.write and the lead ------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is(app.assign_roster_shift(pg_temp.id('slot_1'), pg_temp.id('e_stella')), pg_temp.id('slot_1'), 'a crew.shift.write holder places Stella');
select pg_temp.as_user('theo');
select app.acknowledge_roster_training(pg_temp.id('e_theo'), r) from unnest(array[pg_temp.id('req_crowd'), pg_temp.id('req_code')]) r;
select pg_temp.as_user('carol');
select app.verify_roster_training(t.id, 'Passed') from app.roster_training_records t
where t.roster_entry_id = pg_temp.id('e_theo') and t.onboarding_requirement_id = pg_temp.id('req_crowd');
select pg_temp.as_user('olga');
select is(app.assign_roster_shift(pg_temp.id('slot_2'), pg_temp.id('e_theo')), pg_temp.id('slot_2'), 'the agency''s lead places Theo');
select is((select array_agg(roster_entry_id || ':' || name order by roster_entry_id = pg_temp.id('e_theo'), name) from api_external.my_roster_training where is_satisfied),
  array[pg_temp.id('e_stella') || ':Code of Conduct', pg_temp.id('e_stella') || ':Crowd Safety Training',
        pg_temp.id('e_theo') || ':Code of Conduct', pg_temp.id('e_theo') || ':Crowd Safety Training'],
  'the lead reads the training of the whole roster');
select pg_temp.as_user('dave');
select throws_ok($$select app.assign_roster_shift(pg_temp.id('slot_1'), pg_temp.id('e_theo'))$$, '42501', null,
  'someone who is neither places nobody');

-- Every refusal -----------------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with e as (insert into app.engagements (project_id, counterparty_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('cp_s_a'), 'Staff', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', '2027-06-01') returning id)
  insert into world select 'eng_agency_2', id from e;
select pg_temp.shift('slot_other', 'engagement_id', pg_temp.id('eng_agency_2'), 20, 23);
select pg_temp.shift('slot_3', 'engagement_id', pg_temp.id('eng_agency'), 19, 23);
select pg_temp.shift('slot_past', 'engagement_id', pg_temp.id('eng_agency'), -30, -26);
select app.publish_shifts(array[pg_temp.id('slot_other'), pg_temp.id('slot_3'), pg_temp.id('slot_past')]);
select pg_temp.as_user('olga');
select is(pg_temp.refusal($$select app.assign_roster_shift(pg_temp.id('sh_open'), pg_temp.id('e_stella'))$$), 'roster_shift_not_agency_slot',
  'an open shift is no agency slot');
select is(pg_temp.refusal($$select app.assign_roster_shift(pg_temp.id('sh_frank_day'), pg_temp.id('e_stella'))$$), 'roster_shift_not_agency_slot',
  'nor is a member''s shift');
select is(pg_temp.refusal($$select app.assign_roster_shift(pg_temp.id('slot_other'), pg_temp.id('e_stella'))$$), 'roster_entry_other_engagement',
  'a slot of another engagement takes only that engagement''s roster');
select is(pg_temp.refusal($$select app.assign_roster_shift(pg_temp.id('slot_past'), pg_temp.id('e_stella'))$$), 'roster_shift_closed',
  'a shift that is over takes nobody');
select is(pg_temp.refusal($$select app.assign_roster_shift(pg_temp.id('slot_3'), pg_temp.id('e_uma'))$$), 'roster_entry_not_accepted',
  'an entry still in Draft is not placed');
select is(pg_temp.refusal($$select app.assign_roster_shift(pg_temp.id('slot_2'), pg_temp.id('e_stella'))$$), 'roster_shift_overlap',
  'nor a person on an overlapping shift');
select pg_temp.as_user('carol');
select app.transition_shift(pg_temp.id('slot_other'), 'Published', 'Canceled', 'Not needed.');
select pg_temp.as_user('olga');

-- Reassigning and unassigning ------------------------------------------------------------------------------------------------------------------------
select app.assign_roster_shift(pg_temp.id('slot_3'), pg_temp.id('e_stella'));
select pg_temp.as_user('stella');
select app.accept_engaged_shift(pg_temp.id('slot_3'));
select pg_temp.as_user('olga');
select app.assign_roster_shift(pg_temp.id('slot_3'), pg_temp.id('e_theo'));
select pg_temp.as_platform();
select is((select shift_state || ':' || roster_entry_id from app.shifts where id = pg_temp.id('slot_3')), 'Published:' || pg_temp.id('e_theo'),
  'reassigning an Accepted shift to Theo returns it to Published for him to accept');
select pg_temp.as_user('theo');
select app.accept_engaged_shift(pg_temp.id('slot_3'));
select pg_temp.as_user('olga');
select app.unassign_roster_shift(pg_temp.id('slot_3'), 'Theo is needed at the gate.');
select pg_temp.as_platform();
select is((select shift_state || ':' || engagement_id || ':' || coalesce(roster_entry_id::text, '-') from app.shifts where id = pg_temp.id('slot_3')),
  'Published:' || pg_temp.id('eng_agency') || ':-', 'unassigning makes it the agency''s slot again, Published');
select is((select reason from app.shift_state_transitions where shift_id = pg_temp.id('slot_3') order by created_at desc, id desc limit 1),
  'Theo is needed at the gate.', 'with the reason');
select pg_temp.as_user('olga');
select is(pg_temp.refusal($$select app.unassign_roster_shift(pg_temp.id('slot_3'), 'Again.')$$), 'roster_shift_not_assigned',
  'an unassigned slot has nobody to take off');

select * from finish();
rollback;

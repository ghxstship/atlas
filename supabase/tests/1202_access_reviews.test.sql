-- pgTAP: migration 1202, access review campaigns and items (A52, ADR 0032 amendment). Opening a campaign takes one item per
-- live role assignment; reviewers confirm or remove each once; Removed ends the role at once; nobody reviews their own access
-- or a role above their band; the campaign completes when every item is decided and deleting it cancels it. The nightly
-- sweep flags access left unreviewed past the grace period and, when the campaign says so, removes it, except the sole
-- Owner, whose item stays flagged. A Manager cannot run reviews; cross-tenant and anon denied.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(27);

create function pg_temp.role_of(p_person text, p_code text) returns uuid language sql stable as $$
  select mr.id from app.membership_roles mr join app.memberships m on m.id = mr.membership_id join app.roles r on r.id = mr.role_id
  where m.person_id = pg_temp.id(p_person) and m.org_id = pg_temp.id('org_a') and r.code = p_code
  order by mr.created_at desc limit 1 $$;
create function pg_temp.item_of(p_campaign text, p_person text, p_code text) returns uuid language sql stable as $$
  select i.id from app.access_review_items i where i.access_review_campaign_id = pg_temp.id(p_campaign)
    and i.membership_role_id = pg_temp.role_of(p_person, p_code) $$;

select has_table('app', 'access_review_campaigns', 'app.access_review_campaigns exists');
select has_table('app', 'access_review_items', 'app.access_review_items exists');

select pg_temp.as_user('carol');
select throws_ok($$insert into app.access_review_campaigns (org_id, name, due_on) values ((select id from world where key = 'org_a'), 'Manager Review', current_date + 14)$$,
  '42501', null, 'a Manager cannot open a campaign');

select pg_temp.as_user('bob');
select throws_ok($$insert into app.access_review_campaigns (org_id, name, due_on) values ((select id from world where key = 'org_a'), 'Old Review', current_date - 1)$$,
  'XR001', 'access_review_due_past: Choose a due date from today on.', 'a due date in the past is refused');
with c as (insert into app.access_review_campaigns (org_id, name, due_on) values (pg_temp.id('org_a'), 'Q4 Access Review', current_date + 14) returning id)
insert into world select 'camp1', id from c;
select is((select campaign_state from app.access_review_campaigns where id = pg_temp.id('camp1')), 'Active', 'an Admin opens a campaign, Active');
select is((select count(*)::int from app.access_review_items where access_review_campaign_id = pg_temp.id('camp1')),
  (select count(*)::int from app.membership_roles mr join app.memberships m on m.id = mr.membership_id
   where mr.org_id = pg_temp.id('org_a') and mr.deleted_at is null and m.deleted_at is null and (m.valid_to is null or m.valid_to > now())),
  'it takes one item for every live role assignment in the org');
select throws_ok($$insert into app.access_review_campaigns (org_id, name, due_on) values ((select id from world where key = 'org_a'), 'Second Review', current_date + 7)$$,
  '23505', null, 'an org runs one Active campaign at a time');

select throws_ok($$update app.access_review_items set decision = 'Confirmed' where id = pg_temp.item_of('camp1', 'bob', 'admin')$$,
  'XR001', 'sod_self_review: A person cannot review their own access; another reviewer decides it.', 'a reviewer cannot review their own access');
select throws_ok($$update app.access_review_items set decision = 'Removed' where id = pg_temp.item_of('camp1', 'alice', 'owner')$$,
  'XR001', 'role_band: A reviewer can decide only roles at or below their own band.', 'nor a role above their band');
select lives_ok($$update app.access_review_items set decision = 'Removed' where id = pg_temp.item_of('camp1', 'gina', 'viewer')$$,
  'an Admin removes a Viewer''s role');
select isnt((select deleted_at from app.membership_roles where id = pg_temp.role_of('gina', 'viewer')), null, 'the removal ends the role at once');
select is((select decided_by from app.access_review_items where id = pg_temp.item_of('camp1', 'gina', 'viewer')), pg_temp.id('bob'),
  'the item names the reviewer');
select throws_ok($$update app.access_review_items set decision = 'Confirmed' where id = pg_temp.item_of('camp1', 'gina', 'viewer')$$,
  'XR001', 'access_review_decided: This access was already reviewed; the decision is final.', 'a decision is final');
select lives_ok($$update app.access_review_items set decision = 'Confirmed' where id = pg_temp.item_of('camp1', 'dave', 'member')$$,
  'an Admin confirms a Member''s role');
select is((select deleted_at from app.membership_roles where id = pg_temp.role_of('dave', 'member')), null, 'a confirmed role stays');
select throws_ok($$update app.access_review_campaigns set campaign_state = 'Complete' where id = (select id from world where key = 'camp1')$$,
  '42501', null, 'the state is never written directly');

select pg_temp.as_user('alice');
select lives_ok($$update app.access_review_items set decision = 'Confirmed' where id = pg_temp.item_of('camp1', 'bob', 'admin')$$,
  'the Owner confirms the Admin');

select pg_temp.as_user('carol');
update app.access_review_items set decision = 'Confirmed' where id = pg_temp.item_of('camp1', 'frank', 'field');
select is((select decision from app.access_review_items where id = pg_temp.item_of('camp1', 'frank', 'field')), null,
  'a Manager cannot decide items: row level security leaves them untouched');

-- Cancel by deleting, then a campaign that removes unreviewed access.
select pg_temp.as_user('bob');
update app.access_review_campaigns set deleted_at = now() where id = pg_temp.id('camp1');
select pg_temp.as_platform();
select is((select campaign_state from app.access_review_campaigns where id = pg_temp.id('camp1')), 'Canceled', 'deleting an Active campaign cancels it');

select pg_temp.as_user('bob');
with c as (insert into app.access_review_campaigns (org_id, name, due_on, auto_remove_unreviewed)
  values (pg_temp.id('org_a'), 'Q1 Access Review', current_date + 14, true) returning id)
insert into world select 'camp2', id from c;
update app.access_review_items set decision = 'Confirmed' where id = pg_temp.item_of('camp2', 'dave', 'member');

select pg_temp.as_platform();
select is(private.sweep_access_reviews(), 0, 'the sweep leaves a campaign inside its grace period alone');
select private.begin_trusted_operation('access_review_close');
update app.access_review_campaigns set opened_at = now() - interval '15 days' where id = pg_temp.id('camp2');
select private.end_trusted_operation('access_review_close');
select ok(private.sweep_access_reviews() > 0, 'after 14 days the sweep removes unreviewed roles');
select isnt((select deleted_at from app.membership_roles where id = pg_temp.role_of('frank', 'field')), null, 'an unreviewed Field role is gone');
select is((select deleted_at from app.membership_roles where id = pg_temp.role_of('dave', 'member')), null, 'a confirmed role stays');
select results_eq($$select decision, flagged_at is not null from app.access_review_items where id = pg_temp.item_of('camp2', 'alice', 'owner')$$,
  $$values (null::text, true)$$, 'the sole Owner is never removed; the item stays flagged for a reviewer');
select is((select count(*)::int from app.audit_events where action = 'access_review_items.removed_unreviewed' and org_id = pg_temp.id('org_a')) > 0, true,
  'each automatic removal is in the audit ledger');

select pg_temp.as_user('xavier');
select is((select count(*)::int from app.access_review_items), 0, 'cross-tenant: another org reads no items');

select pg_temp.as_anon();
select throws_ok('select 1 from app.access_review_campaigns', '42501', null, 'anon reads no campaigns');

select * from finish();
rollback;

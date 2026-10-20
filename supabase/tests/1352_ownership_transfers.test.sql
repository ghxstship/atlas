-- pgTAP: ownership transfer (1352, A79, finding A65-015, Section 14.7). An Owner offers the org with step-up; the member
-- accepts with step-up (MFA) and becomes an Owner; the old Owner becomes an Admin or leaves; the org keeps an Owner at
-- every step (invariant 4); offers can be declined, withdrawn or lapse; everything is audited.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(30);

create function pg_temp.as_stepped_up(p_key text) returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(p_key || '_user'), 'role', 'authenticated',
    'aal', 'aal2', 'amr', json_build_array(json_build_object('method', 'password', 'timestamp', extract(epoch from now())::bigint - 60),
      json_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint)))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create function pg_temp.owners(p_org text) returns text
language sql as $$
  select coalesce(string_agg(w.key, ',' order by w.key), '')
  from app.memberships m
  join app.membership_roles mr on mr.membership_id = m.id and mr.deleted_at is null
  join app.roles r on r.id = mr.role_id and r.org_id is null and r.code = 'owner'
  join world w on w.id = m.person_id
  where m.org_id = pg_temp.id(p_org) and m.deleted_at is null and m.valid_to is null
$$;

-- Offering --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select throws_like($$select app.offer_ownership_transfer((select id from world where key = 'org_a'), (select id from world where key = 'dave'))$$,
  'step_up_required:%', 'offering the org needs step-up');
select pg_temp.as_stepped_up('bob');
select throws_ok($$select app.offer_ownership_transfer((select id from world where key = 'org_a'), (select id from world where key = 'dave'))$$,
  '42501', null, 'an Admin cannot offer the org');
select pg_temp.as_stepped_up('alice');
select throws_like($$select app.offer_ownership_transfer((select id from world where key = 'org_a'), (select id from world where key = 'nina'))$$,
  'ownership_transfer_not_member:%', 'ownership goes only to an active member');
select throws_like($$select app.offer_ownership_transfer((select id from world where key = 'org_a'), (select id from world where key = 'alice'))$$,
  'ownership_transfer_self:%', 'not to the Owner herself');
insert into world select 'tr1', app.offer_ownership_transfer(pg_temp.id('org_a'), pg_temp.id('dave'), 'admin');
select ok(pg_temp.id('tr1') is not null, 'the Owner offers the org to a member with step-up');
select throws_like($$select app.offer_ownership_transfer((select id from world where key = 'org_a'), (select id from world where key = 'carol'))$$,
  'ownership_transfer_open:%', 'one open offer at a time');
select pg_temp.as_platform();
select is((select count(*)::int from app.notifications where kind = 'organization.ownership_offered' and recipient_person_id = pg_temp.id('dave')),
  1, 'the member is told');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.ownership_transfers), 1, 'the member reads the offer');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.ownership_transfers), 0, 'another org reads nothing');

-- Accepting -------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_like($$select app.accept_ownership_transfer((select id from world where key = 'tr1'))$$,
  'step_up_required:%', 'accepting needs step-up: the new Owner passes MFA');
select pg_temp.as_stepped_up('carol');
select throws_ok($$select app.accept_ownership_transfer((select id from world where key = 'tr1'))$$,
  '42501', null, 'only the member offered the org accepts');
select pg_temp.as_stepped_up('dave');
select is(app.accept_ownership_transfer(pg_temp.id('tr1')), pg_temp.id('tr1'), 'the member accepts with step-up');
select pg_temp.as_platform();
select is(pg_temp.owners('org_a'), 'dave', 'inv_04_sole_owner: the member is the Owner and the old Owner is not, and the org never lacked one');
select ok(exists (select 1 from app.membership_roles mr join app.roles r on r.id = mr.role_id
  where mr.membership_id = pg_temp.id('alice@org_a') and r.code = 'admin' and mr.deleted_at is null),
  'the old Owner becomes an Admin');
select is((select count(*)::int from app.notifications where kind = 'organization.ownership_accepted' and recipient_person_id = pg_temp.id('alice')),
  1, 'the old Owner is told');
select ok((select count(*) from app.audit_events where org_id = pg_temp.id('org_a') and subject_table = 'app.ownership_transfers') >= 2
  and exists (select 1 from app.audit_events where org_id = pg_temp.id('org_a') and action = 'membership_roles.update'),
  'the offer, its answer and the role changes are in the audit ledger');
select pg_temp.as_stepped_up('dave');
select throws_like($$select app.accept_ownership_transfer((select id from world where key = 'tr1'))$$,
  'ownership_transfer_closed:%', 'an offer is answered once');

-- Declining, withdrawing, leaving ---------------------------------------------------------------------------------
insert into world select 'tr2', app.offer_ownership_transfer(pg_temp.id('org_a'), pg_temp.id('gina'), 'leave');
select pg_temp.as_user('gina');
select is(app.decline_ownership_transfer(pg_temp.id('tr2')), pg_temp.id('tr2'), 'the member may decline');
select pg_temp.as_platform();
select is((select count(*)::int from app.notifications where kind = 'organization.ownership_declined' and recipient_person_id = pg_temp.id('dave')),
  1, 'and the Owner is told');
select pg_temp.as_stepped_up('dave');
insert into world select 'tr3', app.offer_ownership_transfer(pg_temp.id('org_a'), pg_temp.id('erin'), 'leave');
select is(app.cancel_ownership_transfer(pg_temp.id('tr3')), pg_temp.id('tr3'), 'the Owner may withdraw an offer');
select pg_temp.as_stepped_up('erin');
select throws_like($$select app.accept_ownership_transfer((select id from world where key = 'tr3'))$$,
  'ownership_transfer_closed:%', 'a withdrawn offer cannot be accepted');
select pg_temp.as_stepped_up('dave');
insert into world select 'tr4', app.offer_ownership_transfer(pg_temp.id('org_a'), pg_temp.id('alice'), 'leave');
select pg_temp.as_stepped_up('alice');
select is(app.accept_ownership_transfer(pg_temp.id('tr4')), pg_temp.id('tr4'), 'an Admin can take the org back');
select pg_temp.as_platform();
select is(pg_temp.owners('org_a'), 'alice', 'she is the Owner again');
select ok((select valid_to is not null from app.memberships where id = pg_temp.id('dave@org_a')),
  'the Owner who chose to leave left the org');

-- Lapsing and stale offers ---------------------------------------------------------------------------------------------
select pg_temp.as_stepped_up('alice');
insert into world select 'tr5', app.offer_ownership_transfer(pg_temp.id('org_a'), pg_temp.id('bob'), 'admin');
select pg_temp.as_platform();
select is(private.expire_ownership_transfers(now() + interval '6 days'), 0, 'an offer is open for 7 days');
select is(private.expire_ownership_transfers(now() + interval '7 days 1 hour'), 1, 'then the lifecycle job lapses it');
select pg_temp.as_stepped_up('bob');
select throws_like($$select app.accept_ownership_transfer((select id from world where key = 'tr5'))$$,
  'ownership_transfer_closed:%', 'a lapsed offer cannot be accepted');

-- The sole Owner rule still stands outside a transfer ----------------------------------------------------------------
select pg_temp.as_user('alice');
select throws_like($$update app.membership_roles set deleted_at = now()
  where membership_id = (select id from world where key = 'alice@org_a') and role_id = (select id from app.roles where org_id is null and code = 'owner')$$,
  'sole_owner:%', 'inv_04_sole_owner: the sole Owner still cannot drop the role without a transfer');
select pg_temp.as_platform();
select ok(not has_function_privilege('anon', 'app.accept_ownership_transfer(uuid)', 'execute'), 'anon cannot accept an offer');
select ok(not has_table_privilege('authenticated', 'app.ownership_transfers', 'insert')
  and not has_table_privilege('authenticated', 'app.ownership_transfers', 'update'),
  'transfers are written only through the RPCs');

select * from finish();
rollback;

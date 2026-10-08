-- pgTAP: the signup and org creation path (Wave 2 exit test) and the invite RPCs:
-- hashed tokens, expiry, rate limiting and token lock (Section 7.5 invariant 8), and
-- separation of duties on invitations (Section 8.2).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(50);

create temporary table tokens (key text primary key, token text);
grant select, insert on tokens to public;

-- Sign up --------------------------------------------------------------------------------------
select pg_temp.new_user('olive', 'olive@marigold.test', 'Olive Marchetti');
select is((select full_name from app.people where id = pg_temp.id('olive')), 'Olive Marchetti',
  'signing up creates the person with the name given at sign-up');
select is((select user_id from app.people where id = pg_temp.id('olive')), pg_temp.id('olive_user'),
  'the person is linked to the sign-in');

-- Create an org (Wave 2 exit: sign up, create an org, invite, see an empty Home) ---------------
select pg_temp.as_anon();
select throws_ok($$select app.create_organization('Nobody', 'nobody')$$, '42501', null, 'anon cannot create an org');
select pg_temp.as_user('olive');
select throws_like($$select app.create_organization('Partner Clash', 'partner')$$, 'slug_reserved:%',
  'route segments cannot be org slugs');
select throws_like($$select app.create_organization('Clash', 'northwind-live')$$, 'slug_taken:%',
  'slugs are unique across the platform');
select throws_ok($$select app.create_organization('Bad Slug', 'Bad Slug')$$, '23514', null, 'slugs are lowercase and hyphenated');
insert into world values ('org_m', app.create_organization('Marigold Stages', 'marigold-stages'));
select results_eq('select id from app.organizations', array[pg_temp.id('org_m')], 'the creator sees their new org');
select results_eq(
  $$select r.code from app.membership_roles mr join app.roles r on r.id = mr.role_id$$,
  array['owner'], 'the creator is the Owner');
select is((select granted_by from app.membership_roles), null::uuid, 'the first Owner is granted by the platform');
select results_eq(
  $$select plan_code, subscription_state from app.subscriptions$$,
  $$values ('access'::text, 'active'::app.subscription_state)$$,
  'a new org starts on the Access plan');
select is((select count(*)::integer from app.subscription_state_transitions), 1, 'the subscription creation is in the ledger');
select is_empty('select 1 from app.workspaces', 'Home starts empty: no workspaces');
select is_empty('select 1 from app.teams', 'Home starts empty: no teams');
select is_empty('select 1 from app.invites', 'Home starts empty: no invites');
select pg_temp.as_platform();
select ok(
  not exists (select 1 from private.trusted_operations),
  'no trusted operation marker outlives the RPC');

-- Invite ------------------------------------------------------------------------------------------
select pg_temp.as_platform();
update app.subscriptions set plan_code = 'core' where org_id = pg_temp.id('org_m');
select pg_temp.as_user('olive');
insert into tokens
  select 'pete', i.invite_token from app.invite_member(pg_temp.id('org_m'), '  Pete@Marigold.TEST ', pg_temp.system_role('manager')) i;
select matches((select token from tokens where key = 'pete'), '^xinv_[0-9a-f]{64}$', 'the token is 256 random bits, returned once');
select pg_temp.as_platform();
select is((select email from app.invites where org_id = pg_temp.id('org_m')), 'pete@marigold.test', 'the invite email is normalized');
select is((select token_hash from app.invites where org_id = pg_temp.id('org_m')),
  sha256(convert_to((select token from tokens where key = 'pete'), 'UTF8')), 'only the SHA-256 of the token is stored');
select ok(
  (select expires_at from app.invites where org_id = pg_temp.id('org_m')) = now() + interval '14 days',
  'invites expire after 14 days by default');
select pg_temp.as_user('olive');
select throws_like(
  $$select * from app.invite_member(pg_temp.id('org_m'), 'pete@marigold.test', pg_temp.system_role('viewer'), interval '31 days')$$,
  'invite_expiry_range:%', 'an invite cannot last more than 30 days');
select throws_like(
  $$select * from app.invite_member(pg_temp.id('org_m'), 'olive@marigold.test', pg_temp.system_role('admin'))$$,
  'sod_self_grant:%', 'a person cannot invite themselves to a role');
select throws_like(
  $$select * from app.invite_member(pg_temp.id('org_m'), 'pete@marigold.test', (select id from app.roles where code = 'stage_manager'))$$,
  'role_unknown:%', 'a role the org does not have cannot be offered');
select pg_temp.as_user('bob');
select throws_like(
  $$select * from app.invite_member(pg_temp.id('org_a'), 'pete@marigold.test', pg_temp.system_role('owner'))$$,
  'role_band:%', 'an admin cannot invite an Owner');
select pg_temp.as_user('carol');
select throws_ok(
  $$select * from app.invite_member(pg_temp.id('org_a'), 'pete@marigold.test', pg_temp.system_role('viewer'))$$,
  '42501', null, 'a manager cannot invite');
select pg_temp.as_user('xavier');
select throws_ok(
  $$select * from app.invite_member(pg_temp.id('org_m'), 'pete@marigold.test', pg_temp.system_role('viewer'))$$,
  '42501', null, 'nobody invites into an org they do not belong to');

-- Accept ------------------------------------------------------------------------------------------
select pg_temp.new_user('pete', 'pete@marigold.test', 'Pete Okonkwo');
select pg_temp.new_user('sam', 'sam@marigold.test', 'Sam Ferreira');
select pg_temp.as_user('sam');
select results_eq(
  $$select refusal, reason from app.accept_invite((select token from tokens where key = 'pete'))$$,
  $$values ('REFUSE'::text, 'invite_invalid'::text)$$,
  'a token presented by the wrong sign-in is refused without saying why');
select results_eq(
  $$select refusal, reason from app.preview_invite((select token from tokens where key = 'pete'))$$,
  $$values ('REFUSE'::text, 'invite_invalid'::text)$$,
  'the wrong sign-in cannot preview the invite either');
select pg_temp.as_platform();
select is((select failed_attempts from app.invites where email = 'pete@marigold.test' and revoked_at is null), 2::smallint,
  'mismatched attempts are counted on the invite');
select pg_temp.as_user('pete');
select results_eq(
  $$select org_name, role_code, refusal from app.preview_invite((select token from tokens where key = 'pete'))$$,
  $$values ('Marigold Stages'::text, 'manager'::text, null::text)$$,
  'the invitee previews the org and role');
insert into world select 'pete@org_m', a.membership_id from app.accept_invite((select token from tokens where key = 'pete')) a;
select isnt(pg_temp.id('pete@org_m'), null, 'the invitee accepts and joins');
select results_eq(
  $$select r.code from app.membership_roles mr join app.roles r on r.id = mr.role_id where mr.membership_id = pg_temp.id('pete@org_m')$$,
  array['manager'], 'the invitee holds the invited role');
select is(
  (select granted_by from app.membership_roles where membership_id = pg_temp.id('pete@org_m')),
  pg_temp.id('olive'), 'the inviter is accountable for the grant');
select results_eq(
  $$select refusal, reason from app.accept_invite((select token from tokens where key = 'pete'))$$,
  $$values ('REFUSE'::text, 'invite_invalid'::text)$$,
  'an accepted invite cannot be used again');
select pg_temp.as_platform();
select is((select accepted_person_id from app.invites where email = 'pete@marigold.test' and accepted_at is not null),
  pg_temp.id('pete'), 'the invite records who accepted it');

-- Expired, revoked, unconfirmed, locked and inactive-inviter invites ------------------------------
select pg_temp.as_user('olive');
insert into tokens select 'sam', i.invite_token from app.invite_member(pg_temp.id('org_m'), 'sam@marigold.test', pg_temp.system_role('viewer')) i;
insert into tokens select 'sam2', i.invite_token from app.invite_member(pg_temp.id('org_m'), 'sam@marigold.test', pg_temp.system_role('viewer')) i;
select pg_temp.as_user('sam');
select results_eq(
  $$select reason from app.accept_invite((select token from tokens where key = 'sam'))$$,
  array['invite_invalid'], 'a newer invite to the same email revokes the older one');
select pg_temp.as_platform();
update app.invites set expires_at = now() - interval '1 second', created_at = created_at
where token_hash = sha256(convert_to((select token from tokens where key = 'sam2'), 'UTF8'));
select pg_temp.as_user('sam');
select results_eq(
  $$select reason from app.accept_invite((select token from tokens where key = 'sam2'))$$,
  array['invite_invalid'], 'an expired invite is refused');
select pg_temp.as_user('olive');
insert into tokens select 'sam3', i.invite_token from app.invite_member(pg_temp.id('org_m'), 'sam@marigold.test', pg_temp.system_role('viewer')) i;
select pg_temp.as_platform();
update auth.users set email_confirmed_at = null where id = pg_temp.id('sam_user');
select pg_temp.as_user('sam');
select results_eq(
  $$select reason from app.accept_invite((select token from tokens where key = 'sam3'))$$,
  array['invite_invalid'], 'an unconfirmed email cannot accept');
select pg_temp.as_platform();
update auth.users set email_confirmed_at = now() where id = pg_temp.id('sam_user');
update app.invites set failed_attempts = 5
where token_hash = sha256(convert_to((select token from tokens where key = 'sam3'), 'UTF8'));
select pg_temp.as_user('sam');
select results_eq(
  $$select reason from app.accept_invite((select token from tokens where key = 'sam3'))$$,
  array['invite_invalid'], 'a token locked after 5 mismatches is refused even for its owner');

select pg_temp.as_user('bob');
insert into tokens select 'quinn', i.invite_token from app.invite_member(pg_temp.id('org_a'), 'quinn@northwind.test', pg_temp.system_role('viewer')) i;
select pg_temp.as_user('alice');
insert into app.membership_roles (membership_id, role_id) values (pg_temp.id('carol@org_a'), pg_temp.system_role('admin'));
update app.membership_roles set deleted_at = now()
where membership_id = pg_temp.id('bob@org_a') and role_id = pg_temp.system_role('admin');
select pg_temp.new_user('quinn', 'quinn@northwind.test', 'Quinn Abara');
select pg_temp.as_user('quinn');
select results_eq(
  $$select reason from app.accept_invite((select token from tokens where key = 'quinn'))$$,
  array['invite_inviter_inactive'], 'an invite dies with its inviter''s authority to invite');

-- Rate limit -------------------------------------------------------------------------------------
select pg_temp.as_user('nina');
select results_eq(
  $$select count(*)::integer from generate_series(1, 10) g, lateral app.accept_invite('xinv_guess_' || g) a where a.reason = 'invite_invalid'$$,
  array[10], 'guessed tokens are refused');
select results_eq(
  $$select reason from app.accept_invite('xinv_guess_11')$$,
  array['invite_rate_limited'], 'after 10 failures in 15 minutes the sign-in is rate-limited');
select pg_temp.as_platform();
select is((select count(*)::integer from private.invite_accept_failures where user_id = pg_temp.id('nina_user')), 10,
  'failures persist although the RPC returns normally');

-- Leaving --------------------------------------------------------------------------------------
select pg_temp.as_user('pete');
select lives_ok($$select app.leave_organization(pg_temp.id('org_m'))$$, 'a member leaves');
select throws_like($$select app.leave_organization(pg_temp.id('org_m'))$$, 'not_member:%', 'leaving twice is refused');
select is_empty('select 1 from app.organizations where id = pg_temp.id(''org_m'')', 'a former member no longer sees the org');

-- Partner client orgs (Section 4.6.1) -----------------------------------------------------------
select pg_temp.as_user('alice');
select throws_ok(
  $$select * from app.create_client_organization(pg_temp.id('org_b'), 'Stolen', 'stolen-client', 'x@stolen.test')$$,
  '42501', null, 'only partner staff create client orgs under a partner');
select pg_temp.as_platform();
select ok((select partner_bootstrap from app.invites where org_id = pg_temp.id('org_c')), 'the client Owner invite is marked as a partner bootstrap');
select is((select plan_code from app.subscriptions where org_id = pg_temp.id('org_c')), 'core', 'the partner sets the client''s plan');
select ok(
  not exists (select 1 from app.memberships where org_id = pg_temp.id('org_c') and person_id = pg_temp.id('paul')),
  'creating a client org gives partner staff no membership in it');
select results_eq(
  $$select r.code from app.membership_roles mr join app.roles r on r.id = mr.role_id where mr.membership_id = pg_temp.id('cora@org_c')$$,
  array['owner'], 'the client accepts and becomes its Owner');

select * from finish();
rollback;

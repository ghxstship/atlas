-- pgTAP: migration 2630 (R4), account membership acceptance and account invitations. The account creator is accepted at
-- once; a membership app.add_account_member creates stays unconfirmed but keeps today's access; only the person confirms
-- it. An Owner or Admin invites an address (only an Owner offers Owner, never their own address, 1 hour to 30 days), a
-- second invitation to the address replaces the first, and each queues one platform email, in the language of the person
-- the address belongs to, else of the inviter. The invitee accepts only with
-- the confirmed matching email, which confirms a new membership with the role; expired, revoked and declined invitations
-- are closed.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select no_plan();

create function pg_temp.n(p_who text, p_sql text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  execute 'select count(*)::int from (' || p_sql || ') x' into v;
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.membership(p_account text, p_person text) returns app.account_memberships
language sql as $$
  select m.* from app.account_memberships m
  where m.org_id = pg_temp.id(p_account) and m.person_id = pg_temp.id(p_person) and m.deleted_at is null
    and (m.valid_to is null or m.valid_to > now())
$$;

select pg_temp.new_user('kai', 'kai@bayside-audio.test', 'Kai Morgan');
select pg_temp.new_user('ada', 'ada@bayside-audio.test', 'Ada Brennan');
select pg_temp.new_user('noor', 'noor@stagehands.test', 'Noor Haddad');
select pg_temp.new_user('lee', 'lee@stagehands.test', 'Lee Park');
-- Lee signed up but never confirmed the address.
update auth.users set email_confirmed_at = null where id = pg_temp.id('lee_user');

-- Acceptance -----------------------------------------------------------------------------------------------------------------
select ok((pg_temp.membership('acct_v', 'victor')).accepted_at is not null, 'create_external_account accepts the creator''s membership');

select pg_temp.as_user('victor');
select lives_ok(format($$select app.add_account_member(%L, %L, 'Account Member')$$, pg_temp.id('acct_v'), pg_temp.id('kai')),
  'an Account Owner adds a member');
select lives_ok(format($$select app.add_account_member(%L, %L, 'Account Admin')$$, pg_temp.id('acct_v'), pg_temp.id('ada')),
  'and an Admin');
select pg_temp.as_platform();
select ok((pg_temp.membership('acct_v', 'kai')).accepted_at is null, 'add_account_member leaves the membership unconfirmed');
select is(pg_temp.n('kai', format('select 1 from api_external.my_accounts where account_id = %L', pg_temp.id('acct_v'))), 1,
  'an unconfirmed member keeps today''s account access');
select is(pg_temp.n('victor', format('select 1 from api_external.account_members where account_membership_id = %L and accepted_at is null',
  (pg_temp.membership('acct_v', 'kai')).id)), 1, 'api_external.account_members shows the member as not confirmed');

select pg_temp.as_user('victor');
select throws_like(format($$select app.accept_account_membership(%L)$$, (pg_temp.membership('acct_v', 'kai')).id),
  'account_membership_not_yours:%', 'only the person confirms their membership');
select pg_temp.as_user('kai');
select lives_ok(format($$select app.accept_account_membership(%L)$$, (pg_temp.membership('acct_v', 'kai')).id), 'the person confirms');
select lives_ok(format($$select app.accept_account_membership(%L)$$, (pg_temp.membership('acct_v', 'kai')).id), 'confirming again changes nothing');
select pg_temp.as_platform();
select ok((pg_temp.membership('acct_v', 'kai')).accepted_at is not null, 'the membership is confirmed');

-- Inviting -----------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('fiona');
select throws_ok(format($$select app.invite_account_member(%L, 'noor@stagehands.test', 'Account Member')$$, pg_temp.id('acct_v')),
  '42501', null, 'Account Finance does not invite');
select pg_temp.as_user('ada');
select throws_like(format($$select app.invite_account_member(%L, 'noor@stagehands.test', 'Account Owner')$$, pg_temp.id('acct_v')),
  'account_role_band:%', 'only an Account Owner offers Account Owner');
select throws_like(format($$select app.invite_account_member(%L, 'ADA@bayside-audio.test', 'Account Member')$$, pg_temp.id('acct_v')),
  'sod_self_grant:%', 'nobody invites their own address');
select throws_like(format($$select app.invite_account_member(%L, 'noor@stagehands.test', 'Account Member', interval '30 minutes')$$, pg_temp.id('acct_v')),
  'invite_expiry_range:%', 'an invitation stays open at least an hour');
select throws_like(format($$select app.invite_account_member(%L, 'noor@stagehands.test', 'Account Member', interval '31 days')$$, pg_temp.id('acct_v')),
  'invite_expiry_range:%', 'and at most 30 days');
select throws_like(format($$select app.invite_account_member(%L, 'not an address', 'Account Member')$$, pg_temp.id('acct_v')),
  'invitation_email:%', 'an invitation needs one address');
select lives_ok(format($$insert into world select 'inv1', app.invite_account_member(%L, ' Noor@Stagehands.test ', 'Account Member')$$, pg_temp.id('acct_v')),
  'an Account Admin invites an address');
select pg_temp.as_user('victor');
select lives_ok(format($$insert into world select 'inv2', app.invite_account_member(%L, 'noor@stagehands.test', 'Account Admin')$$, pg_temp.id('acct_v')),
  'the Owner invites the same address again');
select pg_temp.as_platform();
select ok((select revoked_at is not null from app.account_invitations where id = pg_temp.id('inv1')), 'the second invitation replaces the first');
select is((select count(*)::int from app.account_invitations where email = 'noor@stagehands.test' and revoked_at is null), 1,
  'one invitation stays pending');
select is((select count(*)::int from private.platform_emails where template = 'party_invitation' and to_email = 'noor@stagehands.test'), 2,
  'each invitation queues one email to the address');
select is((select args ->> 'kind' from private.platform_emails where template = 'party_invitation' and to_email = 'noor@stagehands.test' limit 1),
  'account', 'as an account invitation');
select is(pg_temp.n('victor', 'select 1 from api_external.account_invitations'), 1, 'the Owner lists the pending invitation');
select is(pg_temp.n('fiona', 'select 1 from api_external.account_invitations'), 0, 'Account Finance lists none');
select is(pg_temp.n('noor', 'select 1 from app.my_pending_invitations()'), 1, 'the invitee sees it by their confirmed email');
select is(pg_temp.n('lee', 'select 1 from app.my_pending_invitations()'), 0, 'an unconfirmed address sees nothing');

-- Answering ----------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
select throws_like(format($$select app.respond_party_invitation('account', %L, true)$$, pg_temp.id('inv2')),
  'invitation_not_yours:%', 'another address does not answer it');
select pg_temp.as_user('noor');
select throws_like(format($$select app.respond_party_invitation('account', %L, true)$$, pg_temp.id('inv1')),
  'invitation_closed:%', 'a replaced invitation is closed');
select lives_ok(format($$insert into world select 'noor_membership', app.respond_party_invitation('account', %L, true)$$, pg_temp.id('inv2')),
  'the invitee accepts');
select pg_temp.as_platform();
select ok((pg_temp.membership('acct_v', 'noor')).accepted_at is not null, 'accepting creates a confirmed membership');
select is((pg_temp.membership('acct_v', 'noor')).id, pg_temp.id('noor_membership'), 'and returns its id');
select is((select array_agg(account_role order by account_role)::text from app.account_membership_roles
  where account_membership_id = pg_temp.id('noor_membership') and deleted_at is null), '{"Account Admin"}', 'with the role offered');
select pg_temp.as_user('noor');
select throws_like(format($$select app.respond_party_invitation('account', %L, true)$$, pg_temp.id('inv2')),
  'invitation_closed:%', 'an accepted invitation is closed');

-- An invitation to an unconfirmed member confirms their existing membership.
select pg_temp.as_user('victor');
select lives_ok(format($$select app.add_account_member(%L, %L, 'Account Member')$$, pg_temp.id('acct_v'), pg_temp.id('lee')),
  'an unconfirmed member is added');
select lives_ok(format($$insert into world select 'inv_lee', app.invite_account_member(%L, 'lee@stagehands.test', 'Account Finance')$$, pg_temp.id('acct_v')),
  'and invited');
select pg_temp.as_user('lee');
select throws_like(format($$select app.respond_party_invitation('account', %L, true)$$, pg_temp.id('inv_lee')),
  'invitation_not_yours:%', 'an unconfirmed email does not answer');
select pg_temp.as_platform();
update auth.users set email_confirmed_at = now() where id = pg_temp.id('lee_user');
select pg_temp.as_user('lee');
select lives_ok(format($$select app.respond_party_invitation('account', %L, true)$$, pg_temp.id('inv_lee')), 'once confirmed, it accepts');
select pg_temp.as_platform();
select ok((pg_temp.membership('acct_v', 'lee')).accepted_at is not null, 'the existing membership is confirmed');
select is((select count(*)::int from app.account_membership_roles where account_membership_id = (pg_temp.membership('acct_v', 'lee')).id
  and deleted_at is null), 2, 'and gains the offered role');

-- Closed invitations
select pg_temp.as_user('victor');
select lives_ok(format($$insert into world select 'inv_exp', app.invite_account_member(%L, 'quinn@freelance.test', 'Account Member')$$, pg_temp.id('acct_v')),
  'an invitation to expire');
select pg_temp.as_platform();
update app.account_invitations set expires_at = now() - interval '1 minute' where id = pg_temp.id('inv_exp');
select pg_temp.as_user('quinn');
select throws_like(format($$select app.respond_party_invitation('account', %L, true)$$, pg_temp.id('inv_exp')),
  'invitation_closed:%', 'an expired invitation is closed');
select pg_temp.as_user('victor');
select lives_ok(format($$insert into world select 'inv_rev', app.invite_account_member(%L, 'quinn@freelance.test', 'Account Member')$$, pg_temp.id('acct_v')),
  'a fresh invitation');
select lives_ok(format($$select app.revoke_account_invitation(%L)$$, pg_temp.id('inv_rev')), 'the Owner revokes it');
select pg_temp.as_user('quinn');
select throws_like(format($$select app.respond_party_invitation('account', %L, true)$$, pg_temp.id('inv_rev')),
  'invitation_closed:%', 'a revoked invitation is closed');
select pg_temp.as_user('victor');
select lives_ok(format($$insert into world select 'inv_dec', app.invite_account_member(%L, 'quinn@freelance.test', 'Account Member')$$, pg_temp.id('acct_v')),
  'another invitation');
select pg_temp.as_user('quinn');
select lives_ok(format($$select app.respond_party_invitation('account', %L, false)$$, pg_temp.id('inv_dec')), 'the invitee declines');
select throws_like(format($$select app.respond_party_invitation('account', %L, true)$$, pg_temp.id('inv_dec')),
  'invitation_closed:%', 'a declined invitation is closed');
select pg_temp.as_platform();
select is((pg_temp.membership('acct_v', 'quinn')).id, null, 'declining creates no membership');

-- The email's language -------------------------------------------------------------------------------------------------------------
create function pg_temp.email_locales(p_email text) returns text
language sql as $$
  select string_agg(distinct e.locale, ',' order by e.locale) from private.platform_emails e
  where e.template = 'party_invitation' and e.to_email = p_email
$$;
select pg_temp.as_user('quinn');
select app.set_personal_setting('locale.language', null, 'es-US');
select pg_temp.as_user('victor');
select app.invite_account_member(pg_temp.id('acct_v'), 'quinn@freelance.test', 'Account Member');
select app.invite_account_member(pg_temp.id('acct_v'), 'newcomer@freelance.test', 'Account Member');
select pg_temp.as_platform();
select is(pg_temp.email_locales('quinn@freelance.test'), 'en-US,es-US', 'someone on the platform reads the invitation in their own language');
select is(pg_temp.email_locales('newcomer@freelance.test'), 'en-US', 'anyone else in the inviter''s, en-US by default');
select pg_temp.as_user('victor');
select app.set_personal_setting('locale.language', null, 'es-US');
select app.invite_account_member(pg_temp.id('acct_v'), 'newcomer@freelance.test', 'Account Member');
select pg_temp.as_platform();
select is(pg_temp.email_locales('newcomer@freelance.test'), 'en-US,es-US', 'and in Spanish when the inviter reads Spanish');

select * from finish();
rollback;

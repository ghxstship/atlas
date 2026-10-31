-- pgTAP: migration 2861, signed-out approval links (P9, G-31, ADR 0138; Section 7.5 invariant 8). An outside approver
-- on an engagement step that allows it decides from the email without signing in, with the link token and a 6-digit
-- code emailed on demand: the token-only read returns only the fields the page renders before the code, the code is
-- stored only as a hash and expires, code requests are rate-limited, wrong codes count across the notification's links
-- and lock them at 5, and every rule of the decision still decides. A member's link still needs a sign-in.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(55);

create temporary table k (key text primary key, token text, code text);
grant select, insert, update, delete on k to public;

create function pg_temp.request_note(p_person text, p_approval uuid) returns uuid language sql as $$
  select n.id from app.notifications n
  where n.recipient_person_id = pg_temp.id(p_person) and n.kind = 'approval.requested' and n.subject_id = p_approval
  order by n.created_at desc, n.id desc limit 1
$$;
create function pg_temp.mint(p_key text, p_notification uuid) returns integer language plpgsql as $$
declare
  v record;
  v_count integer := 0;
begin
  for v in select * from app.mint_notification_action_tokens(
      (select d.id from app.notification_deliveries d where d.notification_id = p_notification and d.channel = 'Email')) loop
    insert into k (key, token) values (p_key || '_' || v.action, v.token) on conflict (key) do update set token = excluded.token;
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;
create function pg_temp.token(p_key text) returns text language sql as $$ select token from k where key = p_key $$;
create function pg_temp.token_row(p_key text) returns private.notification_action_tokens language sql as $$
  select * from private.notification_action_tokens t where t.token_hash = extensions.digest(pg_temp.token(p_key), 'sha256')
$$;
-- Requests a code as anon and mints it as the dispatcher does, keeping the code under p_key.
create function pg_temp.code_for(p_key text) returns text language plpgsql as $$
declare
  v_code text;
begin
  perform pg_temp.as_anon();
  perform api_public.request_approval_link_code(pg_temp.token(p_key));
  perform pg_temp.as_platform();
  select app.mint_approval_link_code(d.id) into v_code
  from app.notifications n join app.notification_deliveries d on d.notification_id = n.id and d.channel = 'Email'
  where n.kind = 'approval.link_code' and n.subject_id = (pg_temp.token_row(p_key)).id
  order by n.created_at desc, n.id desc limit 1;
  update k set code = v_code where key = p_key;
  return v_code;
end $$;
create function pg_temp.use(p_key text, p_code text, p_comment text default null) returns text language plpgsql as $$
declare
  v record;
begin
  perform pg_temp.as_anon();
  select * into v from api_public.use_approval_link(pg_temp.token(p_key), p_code, p_comment);
  perform pg_temp.as_platform();
  return v.outcome || coalesce(' ' || v.attempts_left, '');
end $$;
create function pg_temp.issue(p_key text, p_holder text) returns uuid language plpgsql as $$
declare
  v_id uuid;
begin
  perform pg_temp.as_user('carol');
  insert into app.credentials (credential_category_id, holder_person_id) values (pg_temp.id('cat_all'), pg_temp.id(p_holder))
  returning id into v_id;
  insert into world values (p_key, v_id);
  perform pg_temp.as_platform();
  insert into world select 'appr_' || p_key, a.id from app.subject_approvals a where a.credential_id = v_id;
  return pg_temp.id('appr_' || p_key);
end $$;

-- Fixture: an All Access rule on prj_a whose step 1 is ivy's engagement, decided from email, and step 2 bob -------------------
select pg_temp.as_user('alice');
with x as (insert into app.zones (venue_id, code, name) values (pg_temp.id('venue_a'), 'FOH', 'Front of House') returning id) insert into world select 'zone', id from x;
with x as (insert into app.credential_categories (project_id, code, name) values (pg_temp.id('prj_a'), 'ALL', 'All Access') returning id) insert into world select 'cat_all', id from x;
insert into app.access_grid (credential_category_id, zone_id, access_level_enum_id, window_starts_at, window_ends_at)
values (pg_temp.id('cat_all'), pg_temp.id('zone'), 'ENM-036', now() - interval '1 day', now() + interval '1 day');
with x as (insert into app.approval_rules (project_id, subject, name, credential_category_id)
           values (pg_temp.id('prj_a'), 'Pass', 'All Access passes', pg_temp.id('cat_all')) returning id) insert into world select 'rule', id from x;
insert into app.approval_rule_steps (approval_rule_id, step_order, name, approver_engagement_id, signed_out_links)
values (pg_temp.id('rule'), 1, 'Crew chief', pg_temp.id('eng_ivy_a'), true);
insert into app.approval_rule_steps (approval_rule_id, step_order, name, approver_membership_id)
values (pg_temp.id('rule'), 2, 'Production manager', pg_temp.id('bob@org_a'));
select app.transition_approval_rule(pg_temp.id('rule'), 'Draft', 'Active', 'Gate All Access.');
select pg_temp.issue('p1', 'frank');

-- 5. Who gets which link -------------------------------------------------------------------------------------------------------
select is((select count(*)::integer from app.notifications where kind = 'approval.requested' and subject_id = pg_temp.id('appr_p1')), 1,
  'only the engaged person is asked at the engagement step');
select is(pg_temp.mint('ivy', pg_temp.request_note('ivy', pg_temp.id('appr_p1'))), 2, 'her email carries an Approve and a Reject link');
select is((select string_agg(action || ' ' || audience || ' ' || sign_in_required::text, ', ' order by action) from private.notification_action_tokens
           where notification_id = pg_temp.request_note('ivy', pg_temp.id('appr_p1'))),
  'approve Gateway false, reject Gateway false', 'both confirmed in Gateway, without a sign-in');

-- 6. The token-only read ---------------------------------------------------------------------------------------------------------
select is(pg_get_function_result('api_public.read_approval_link(text)'::regprocedure),
  'TABLE(link_state text, action text, org_name text, masked_email text, expires_at timestamp with time zone)',
  'the token-only read returns exactly the state, action, org, masked email and expiry');
select pg_temp.as_anon();
select is((select link_state || ' ' || action || ' ' || org_name from api_public.read_approval_link(pg_temp.token('ivy_approve'))),
  'ready approve Northwind Live', 'signed out, the link says what it does and for which org');
select is((select masked_email from api_public.read_approval_link(pg_temp.token('ivy_approve'))), 'i***@freelance.test',
  'and to which masked address the code goes');
select is((select link_state from api_public.read_approval_link('xact_nonsense')), 'invalid', 'a malformed token is invalid');
select is((select link_state from api_public.read_approval_link(
  regexp_replace(pg_temp.token('ivy_approve'), '\.[0-9a-f]{32}$', '.' || repeat('0', 32)))), 'invalid', 'so is a forged one');
select is((select concat_ws(' ', link_state, action, org_name, masked_email) from api_public.read_approval_link('xact_nonsense')),
  'invalid', 'and an invalid link says nothing else');

-- 7. Codes --------------------------------------------------------------------------------------------------------------------------
select lives_ok(format($$select api_public.request_approval_link_code(%L)$$, pg_temp.token('ivy_approve')), 'anyone with the link asks for a code');
select pg_temp.as_platform();
select is((select count(*)::integer from app.notifications where kind = 'approval.link_code' and subject_id = (pg_temp.token_row('ivy_approve')).id), 1,
  'one code notice is queued to the link''s recipient');
select is((select array_agg(k order by k) from app.notifications n, jsonb_object_keys(n.message_args) k
           where n.kind = 'approval.link_code' and n.subject_id = (pg_temp.token_row('ivy_approve')).id),
  array['actorName', 'orgName', 'title'], 'its arguments carry the title and org name, never a code');
select is((select (archived_at is not null)::text || ' ' || recipient_person_id::text from app.notifications
           where kind = 'approval.link_code' and subject_id = (pg_temp.token_row('ivy_approve')).id),
  'true ' || pg_temp.id('ivy')::text, 'it is archived at once, so only its email shows');
select is((select count(*)::integer from app.notification_deliveries d join app.notifications n on n.id = d.notification_id
           where n.kind = 'approval.link_code' and n.subject_id = (pg_temp.token_row('ivy_approve')).id and d.channel = 'Email'), 1,
  'and its email is queued');
select pg_temp.as_anon();
select throws_like(format($$select api_public.request_approval_link_code(%L)$$, pg_temp.token('ivy_reject')), 'approval_link_code_too_soon:%',
  'a second request within a minute, even through the other link, is refused');
select pg_temp.as_user('carol');
select throws_ok($$select app.mint_approval_link_code(gen_random_uuid())$$, '42501', null, 'a signed-in caller does not mint codes');
select pg_temp.as_anon();
select throws_ok($$select app.mint_approval_link_code(gen_random_uuid())$$, '42501', null, 'nor does anon');
select pg_temp.as_platform();
select set_config('role', 'service_role', true);
insert into k (key, code) select 'p1_code', app.mint_approval_link_code(d.id)
from app.notifications n join app.notification_deliveries d on d.notification_id = n.id and d.channel = 'Email'
where n.kind = 'approval.link_code' and n.subject_id = (pg_temp.token_row('ivy_approve')).id;
select pg_temp.as_platform();
update k set code = (select code from k where key = 'p1_code') where key in ('ivy_approve', 'ivy_reject');
select ok((select code from k where key = 'p1_code') ~ '^[0-9]{6}$', 'the dispatcher gets a 6-digit code once');
select is((select count(*)::integer from private.notification_action_codes c where c.token_id = (pg_temp.token_row('ivy_approve')).id
           and c.code_hash = extensions.digest((pg_temp.token_row('ivy_approve')).token_hash || convert_to(':' || (select code from k where key = 'p1_code'), 'UTF8'), 'sha256')),
  1, 'only its hash, salted by the token''s stored hash, is stored');
select is((select count(*)::integer from private.notification_action_codes c where position(convert_to((select code from k where key = 'p1_code'), 'UTF8') in c.code_hash) > 0
           and octet_length(c.code_hash) <> 32), 0, 'never the code itself');
select is((select expires_at - created_at from private.notification_action_codes c where c.token_id = (pg_temp.token_row('ivy_approve')).id),
  interval '10 minutes', 'and it lives 10 minutes');

-- The details appear only after the code -----------------------------------------------------------------------------------------
insert into k (key, code) select 'p1_title', message_args ->> 'title' from app.notifications where id = pg_temp.request_note('ivy', pg_temp.id('appr_p1'));
select pg_temp.as_anon();
select is((select outcome || ' ' || attempts_left from api_public.preview_approval_link(pg_temp.token('ivy_approve'), '000000')),
  'approval_link_code_wrong 4', 'a wrong code shows nothing and counts');
select pg_temp.as_platform();
select is((select string_agg(failed_attempts::text, ',') from private.notification_action_tokens
           where notification_id = (pg_temp.token_row('ivy_approve')).notification_id), '1,1',
  'the wrong code is kept, on both links of the notification');
select pg_temp.as_anon();
select is((select outcome || ' ' || title || ' / ' || current_step_name from api_public.preview_approval_link(pg_temp.token('ivy_approve'), (select code from k where key = 'p1_code'))),
  'ok ' || (select code from k where key = 'p1_title') || ' / Crew chief',
  'the right code shows the request and its step');

-- 8. Deciding through the link ----------------------------------------------------------------------------------------------------
select is(pg_temp.use('ivy_reject', (select code from k where key = 'p1_code')), 'notification_action_reason 4',
  'the Reject link asks for a reason');
select is(pg_temp.use('ivy_approve', (select code from k where key = 'p1_code')), 'decided 4', 'the Approve link with the code decides');
select is((select decided_via || ' ' || approver_person_id::text from app.subject_approval_decisions where subject_approval_id = pg_temp.id('appr_p1')),
  'Email link ' || pg_temp.id('ivy')::text, 'as the link''s recipient, through the email link');
select is((select count(*)::integer from private.notification_action_tokens
           where notification_id = (pg_temp.token_row('ivy_approve')).notification_id and used_at is null), 0, 'every link of the notification is used');
select pg_temp.as_anon();
select is((select link_state from api_public.read_approval_link(pg_temp.token('ivy_reject'))), 'used', 'reopened, the link says it was handled');
select pg_temp.as_platform();
select is(pg_temp.use('ivy_approve', (select code from k where key = 'p1_code')), 'approval_link_code_wrong 3', 'a used code no longer works');

-- A member's step needs a sign-in ---------------------------------------------------------------------------------------------------
select is(pg_temp.mint('bob', pg_temp.request_note('bob', pg_temp.id('appr_p1'))), 2, 'step 2 asks bob, a member');
select is((select string_agg(audience || ' ' || sign_in_required::text, ', ') from private.notification_action_tokens
           where notification_id = pg_temp.request_note('bob', pg_temp.id('appr_p1'))), 'Atlas true, Atlas true',
  'his links open Atlas and need a sign-in');
select pg_temp.as_anon();
select is((select concat_ws(' ', link_state, action, org_name) from api_public.read_approval_link(pg_temp.token('bob_approve'))), 'sign_in',
  'signed out, a member''s link only sends him to sign in');
select pg_temp.as_platform();
select is(pg_temp.use('bob_approve', '123456'), 'notification_action_invalid', 'and does nothing without one');
select pg_temp.as_anon();
select throws_like(format($$select api_public.request_approval_link_code(%L)$$, pg_temp.token('bob_approve')), 'notification_action_invalid:%',
  'nor sends him a code');

-- A step decided elsewhere, an expired code, a lock -----------------------------------------------------------------------------------
select pg_temp.as_platform();
select pg_temp.issue('p2', 'dave');
select pg_temp.mint('ivy2', pg_temp.request_note('ivy', pg_temp.id('appr_p2')));
select pg_temp.code_for('ivy2_approve');
update private.notification_action_codes set expires_at = now() - interval '1 minute', created_at = now() - interval '11 minutes'
where token_id = (pg_temp.token_row('ivy2_approve')).id;
select is(pg_temp.use('ivy2_approve', (select code from k where key = 'ivy2_approve')), 'approval_link_code_wrong 4', 'an expired code is a wrong code');
update private.notification_action_codes set expires_at = now() + interval '10 minutes', created_at = now()
where token_id = (pg_temp.token_row('ivy2_approve')).id;
select pg_temp.as_user('ivy');
select lives_ok(format($$select app.act_on_notification(%L, 'approve')$$, pg_temp.request_note('ivy', pg_temp.id('appr_p2'))),
  'the outside approver, signed in, approves from her Inbox instead');
select pg_temp.as_platform();
select is(pg_temp.use('ivy2_approve', (select code from k where key = 'ivy2_approve')), 'notification_action_used 4',
  'the link with a live code then says the step was handled');
select is((select count(*)::integer from app.subject_approval_decisions where subject_approval_id = pg_temp.id('appr_p2')), 1,
  'and decided nothing more');

select pg_temp.issue('p3', 'erin');
select pg_temp.mint('ivy3', pg_temp.request_note('ivy', pg_temp.id('appr_p3')));
select pg_temp.code_for('ivy3_approve');
select is(pg_temp.use('ivy3_reject', '111111', 'Wrong.'), 'approval_link_code_wrong 4', 'a wrong code on the Reject link');
select is(pg_temp.use('ivy3_approve', '222222'), 'approval_link_code_wrong 3', 'counts with the Approve link''s');
select is(pg_temp.use('ivy3_approve', '333333'), 'approval_link_code_wrong 2', 'a third');
select is(pg_temp.use('ivy3_approve', '444444'), 'approval_link_code_wrong 1', 'a fourth');
select is(pg_temp.use('ivy3_approve', '555555'), 'approval_link_locked 0', 'the fifth locks the links');
select is(pg_temp.use('ivy3_approve', (select code from k where key = 'ivy3_approve')), 'approval_link_locked 0',
  'and the right code no longer works');
select is(pg_temp.use('ivy3_reject', (select code from k where key = 'ivy3_approve'), 'Now.'), 'approval_link_locked 0',
  'on either link');
select pg_temp.as_anon();
select is((select link_state from api_public.read_approval_link(pg_temp.token('ivy3_reject'))), 'locked', 'the page says the link is locked');
select throws_like(format($$select api_public.request_approval_link_code(%L)$$, pg_temp.token('ivy3_approve')), 'approval_link_locked:%',
  'and sends no more codes');
select pg_temp.as_platform();
select is((select count(*)::integer from app.subject_approval_decisions where subject_approval_id = pg_temp.id('appr_p3')), 0,
  'none of it decided anything');

-- Five codes an hour -------------------------------------------------------------------------------------------------------------------
select pg_temp.issue('p4', 'gina');
select pg_temp.mint('ivy4', pg_temp.request_note('ivy', pg_temp.id('appr_p4')));
-- Earlier code notices of the last hour, written with the guards off inside this test transaction only.
alter table app.notifications disable trigger user;
insert into app.notifications (org_id, recipient_person_id, kind, subject_table, subject_id, archived_at, created_at)
select pg_temp.id('org_a'), pg_temp.id('ivy'), 'approval.link_code', 'notification_action_tokens', (pg_temp.token_row('ivy4_approve')).id,
  now(), now() - make_interval(mins => m)
from unnest(array[5, 15, 25, 35]) m;
alter table app.notifications enable trigger user;
select pg_temp.as_anon();
select lives_ok(format($$select api_public.request_approval_link_code(%L)$$, pg_temp.token('ivy4_approve')),
  'a fifth code in an hour is sent');
select pg_temp.as_platform();
alter table app.notifications disable trigger user;
insert into app.notifications (org_id, recipient_person_id, kind, subject_table, subject_id, archived_at, created_at)
values (pg_temp.id('org_a'), pg_temp.id('ivy'), 'approval.link_code', 'notification_action_tokens', (pg_temp.token_row('ivy4_reject')).id,
  now(), now() - interval '45 minutes');
delete from app.notification_deliveries d using app.notifications n
where d.notification_id = n.id and n.kind = 'approval.link_code' and n.created_at = now() and n.subject_id = (pg_temp.token_row('ivy4_approve')).id;
delete from app.notifications where kind = 'approval.link_code' and created_at = now() and subject_id = (pg_temp.token_row('ivy4_approve')).id;
alter table app.notifications enable trigger user;
select pg_temp.as_anon();
select throws_like(format($$select api_public.request_approval_link_code(%L)$$, pg_temp.token('ivy4_approve')),
  'approval_link_code_too_soon:%', 'a sixth within the hour, counted across both links, is refused');

-- Approval emails turned off -------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select pg_temp.issue('p5', 'mia');
select pg_temp.mint('ivy5', pg_temp.request_note('ivy', pg_temp.id('appr_p5')));
insert into app.person_notification_preferences (person_id, category_code, channel, enabled)
values (pg_temp.id('ivy'), 'approvals', 'Email', false);
select pg_temp.as_anon();
select throws_like(format($$select api_public.request_approval_link_code(%L)$$, pg_temp.token('ivy5_approve')),
  'approval_link_email_off:%', 'a recipient who turned approval emails off is told to sign in instead');
select pg_temp.as_platform();
select is((select count(*)::integer from app.notifications where kind = 'approval.link_code' and subject_id = (pg_temp.token_row('ivy5_approve')).id), 0,
  'and nothing is queued');

-- 9. The Inbox ------------------------------------------------------------------------------------------------------------------------------
update app.notifications set archived_at = null where kind = 'approval.link_code' and recipient_person_id = pg_temp.id('ivy');
select pg_temp.as_user('ivy');
select is((select count(*)::integer from app.inbox_items where kind = 'approval.link_code'), 0, 'a code notice never shows in the Inbox');
select pg_temp.as_platform();
select ok(not has_table_privilege('xos_backup', 'app.inbox_items', 'SELECT'), 'the backup login does not read the Inbox view');

select * from finish();
rollback;

-- pgTAP: migration 904190902, the writer of support overrides (ADR 0169 D8, RRR-243). Only the holder of the secret
-- key reaches the two functions. A suspension names one control, an operator and a reason, lasts 1 to 24 hours, is
-- written to the organization's audit ledger and tells every Owner, for the platform: the notification names the
-- control, the reason and the end, and never the operator. While it is in force the control reads as off for that
-- organization and the gated helpers admit it again; ended early, the control is back on the next request. A control
-- that is already suspended is not suspended twice.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql
\ir 904180200_session_gate_fixture.psql

select plan(40);

create temporary table made (name text primary key, id uuid);
grant select, insert on made to public;

-- The holder of the secret key, as PostgREST presents it: the service_role and no person.
create function pg_temp.as_secret_key() returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '{"role": "service_role"}', true);
  perform set_config('role', 'service_role', true);
end $$;

create function pg_temp.my_orgs() returns text
language sql as $$
  select pg_temp.private_text($q$select coalesce(string_agg(w.key, ',' order by w.key), '')
    from private.my_org_ids() o join world w on w.id = o and w.key like 'org\_%'$q$)
$$;

-- Who may call ------------------------------------------------------------------------------------------------------------------

select ok(has_function_privilege('service_role', 'app.suspend_session_gate_control(uuid, text, text, text, integer)', 'execute')
  and has_function_privilege('service_role', 'app.end_session_gate_suspension(uuid, text)', 'execute'),
  'the secret key reaches both functions');
select ok(not has_function_privilege('authenticated', 'app.suspend_session_gate_control(uuid, text, text, text, integer)', 'execute')
  and not has_function_privilege('anon', 'app.suspend_session_gate_control(uuid, text, text, text, integer)', 'execute')
  and not has_function_privilege('authenticated', 'app.end_session_gate_suspension(uuid, text)', 'execute')
  and not has_function_privilege('anon', 'app.end_session_gate_suspension(uuid, text)', 'execute'),
  'no session, API key, app or anonymous caller does');
select pg_temp.as_user_stepped_up('alice');
select throws_ok(format($$select app.suspend_session_gate_control(%L, 'mfa', 'Alice Owner', 'An Owner tries to suspend her own organization''s rule.')$$,
  pg_temp.id('org_a')), '42501', null, 'an Owner at a second factor is refused: the override is support''s, not the organization''s');

-- What it refuses -----------------------------------------------------------------------------------------------------------------

select pg_temp.as_secret_key();
select throws_ok(format($$select app.suspend_session_gate_control(%L, 'app_mfa', 'support: pgTAP', 'Every Owner lost their authenticator during the tour.')$$,
  pg_temp.id('org_a')), 'XR001', 'session_gate_control: Name the control to suspend: ended, mfa, lifetime, idle or network.',
  'a control the gate does not have is refused');
select throws_ok(format($$select app.suspend_session_gate_control(%L, null, 'support: pgTAP', 'Every Owner lost their authenticator during the tour.')$$,
  pg_temp.id('org_a')), 'XR001', null, 'and so is no control');
select throws_ok(format($$select app.suspend_session_gate_control(%L, 'mfa', ' x ', 'Every Owner lost their authenticator during the tour.')$$,
  pg_temp.id('org_a')), 'XR001', 'session_gate_actor: Name the operator who suspends the control, in 3 to 200 characters.',
  'the operator is named');
select throws_ok(format($$select app.suspend_session_gate_control(%L, 'mfa', 'support: pgTAP', 'Too short.')$$,
  pg_temp.id('org_a')), 'XR001', 'session_gate_reason: Write why the control is suspended, in 20 to 1,000 characters. The organization''s Owners read it.',
  'the reason is written in at least 20 characters');
select throws_ok(format($$select app.suspend_session_gate_control(%L, 'mfa', 'support: pgTAP', 'Every Owner lost their authenticator during the tour.', 25)$$,
  pg_temp.id('org_a')), 'XR001', 'session_gate_hours: A suspension lasts 1 to 24 hours.', 'a suspension lasts at most 24 hours');
select throws_ok(format($$select app.suspend_session_gate_control(%L, 'mfa', 'support: pgTAP', 'Every Owner lost their authenticator during the tour.', 0)$$,
  pg_temp.id('org_a')), 'XR001', 'session_gate_hours: A suspension lasts 1 to 24 hours.', 'and at least one');
select throws_ok($$select app.suspend_session_gate_control(gen_random_uuid(), 'mfa', 'support: pgTAP', 'Every Owner lost their authenticator during the tour.')$$,
  'XR001', 'session_gate_org: No such organization.', 'the organization exists');
select pg_temp.as_platform();
select is((select count(*)::int from private.session_gate_overrides), 0, 'a refused call writes nothing');
select is((select count(*)::int from app.notifications where kind = 'access.session_rule_suspended'), 0, 'and tells nobody');

-- A suspension ------------------------------------------------------------------------------------------------------------------

-- Northwind Live asks everyone for a second factor, and the control is enforced: Mia's single-factor session is closed.
select pg_temp.rule('org_a', 'alice', 'security.mfa_policy', 'everyone');
select pg_temp.gate('mfa', 'enforce');
select pg_temp.as_session('mia', 'aal1', interval '10 minutes');
select is(pg_temp.my_orgs(), 'org_b', 'before: the organization refuses a single-factor session');

select pg_temp.as_secret_key();
insert into made select 'mfa', app.suspend_session_gate_control(pg_temp.id('org_a'), 'mfa', '  support: pgTAP  ',
  '  Every Owner lost their authenticator during the tour.  ', 2);
select pg_temp.as_platform();
select results_eq(
  $$select o.org_id, o.control, o.actor, o.reason, o.ended_at is null,
           o.starts_at = now(), o.expires_at = now() + interval '2 hours'
    from private.session_gate_overrides o where o.id = (select id from made where name = 'mfa')$$,
  format($$values (%L::uuid, 'mfa', 'support: pgTAP', 'Every Owner lost their authenticator during the tour.', true, true, true)$$, pg_temp.id('org_a')),
  'the override is written for the organization and the control, trimmed, for the hours asked');
select is((select suspensions from private.session_gate_config), true, 'the configuration row knows an override is in force');
select results_eq(
  $$select e.actor_kind::text, e.actor_person_id, e.diff ->> 'control', e.diff ->> 'actor', e.diff ->> 'reason'
    from app.audit_events e
    where e.action = 'session_gate_overrides.started' and e.subject_id = (select id from made where name = 'mfa')$$,
  $$values ('Service', null::uuid, 'mfa', 'support: pgTAP', 'Every Owner lost their authenticator during the tour.')$$,
  'the audit ledger records it as the service''s act, with the control, the operator and the reason');

-- The Owners are told, for the platform.
select set_eq(
  $$select n.recipient_person_id from app.notifications n
    where n.kind = 'access.session_rule_suspended' and n.subject_id = (select id from made where name = 'mfa')$$,
  format($$select private.org_owner_ids(%L)$$, pg_temp.id('org_a')),
  'every Owner of the organization is notified, and nobody else');
select is((select count(*)::int from app.notifications n where n.kind = 'access.session_rule_suspended'
           and n.recipient_person_id = pg_temp.id('alice')), 1, 'the Owner gets one notification');
select is((select count(*)::int from app.notifications n where n.kind = 'access.session_rule_suspended'
           and n.recipient_person_id = pg_temp.id('bob')), 0, 'an Admin gets none');
select results_eq(
  $$select n.org_id, n.subject_table, n.actor_person_id, n.message_args ->> 'control', n.message_args ->> 'reason',
           n.message_args ->> 'orgName', n.message_args ->> 'actorName', n.message_args ? 'actorPlatform',
           (n.message_args ->> 'until')::timestamptz = date_trunc('second', now() + interval '2 hours'),
           n.message_args ->> 'until' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$'
    from app.notifications n where n.kind = 'access.session_rule_suspended' and n.recipient_person_id = pg_temp.id('alice')$$,
  format($$values (%L::uuid, 'session_gate_overrides', null::uuid, 'mfa', 'Every Owner lost their authenticator during the tour.',
                   'Northwind Live', 'GHXSTSHIP', false, true, true)$$, pg_temp.id('org_a')),
  'it names the control, the reason and the end as an instant, comes from the platform, and stores no operator');
select is_empty(
  $$select 1 from app.notifications n where n.kind = 'access.session_rule_suspended' and n.message_args::text ~ 'support: pgTAP'$$,
  'the operator''s name is in the audit ledger and never on the notification');
select ok((select count(*) from private.notification_templates t where t.kind = 'access.session_rule_suspended') > 0
  and (select t.category_code from private.notification_templates t where t.kind = 'access.session_rule_suspended' limit 1) = 'account',
  'the kind is seeded in the account category');

-- While it is in force.
select pg_temp.as_session('mia', 'aal1', interval '10 minutes');
select is(pg_temp.org_reasons('org_a'), null, 'while suspended, the organization does not refuse the single-factor session');
select is(pg_temp.my_orgs(), 'org_a,org_b', 'and the gated helpers admit it again');
select pg_temp.gate('lifetime', 'enforce');
select pg_temp.as_session('mia', 'aal1', interval '400 hours');
select is(pg_temp.org_reasons('org_a'), 'session_expired', 'one override suspends one control: the lifetime rule still refuses');
select pg_temp.as_platform();
select pg_temp.gate('lifetime', 'off');

-- Not twice.
select pg_temp.as_secret_key();
select throws_ok(format($$select app.suspend_session_gate_control(%L, 'mfa', 'support: second operator', 'A second operator suspends the same control again.')$$,
  pg_temp.id('org_a')), 'XR001',
  'session_gate_override_open: This control is already suspended for this organization. End that suspension first, or wait for it to expire.',
  'a control that is already suspended is not suspended twice');
select lives_ok(format($$insert into made select 'network', app.suspend_session_gate_control(%L, 'network', 'support: pgTAP', 'No Owner can reach a listed network from the venue.')$$,
  pg_temp.id('org_a')), 'another control of the same organization can be suspended beside it');
select lives_ok(format($$insert into made select 'mfa_b', app.suspend_session_gate_control(%L, 'mfa', 'support: pgTAP', 'Another organization asked for the same suspension.', 1)$$,
  pg_temp.id('org_b')), 'and the same control of another organization');
select pg_temp.as_platform();
select is((select o.expires_at = now() + interval '24 hours' from private.session_gate_overrides o where o.id = (select id from made where name = 'network')),
  true, 'a suspension lasts 24 hours when no number is given');
select set_eq(
  $$select n.recipient_person_id from app.notifications n
    where n.kind = 'access.session_rule_suspended' and n.subject_id = (select id from made where name = 'mfa_b')$$,
  $$select pg_temp.id('xavier')$$, 'whose own Owner is told, not the first organization''s');

-- Ending it early ---------------------------------------------------------------------------------------------------------------

select pg_temp.as_secret_key();
select throws_ok(format($$select app.end_session_gate_suspension(%L, '')$$, (select id from made where name = 'mfa')), 'XR001',
  'session_gate_actor: Name the operator who ends the suspension, in 3 to 200 characters.', 'ending names its operator too');
select is(app.end_session_gate_suspension((select id from made where name = 'mfa'), 'support: closing operator'), true,
  'the suspension is ended before it expires');
select is(app.end_session_gate_suspension((select id from made where name = 'mfa'), 'support: closing operator'), false,
  'ending it again changes nothing');
select is(app.end_session_gate_suspension(gen_random_uuid(), 'support: closing operator'), false, 'and an override that does not exist is not ended');
select pg_temp.as_platform();
select is((select o.ended_at from private.session_gate_overrides o where o.id = (select id from made where name = 'mfa')), now(),
  'the row records when');
select results_eq(
  $$select e.action, e.diff ->> 'actor' from app.audit_events e
    where e.subject_id = (select id from made where name = 'mfa') and e.action like 'session_gate_overrides.ended%' order by e.action$$,
  $$values ('session_gate_overrides.ended', 'support: pgTAP'), ('session_gate_overrides.ended_by', 'support: closing operator')$$,
  'the audit ledger records the end and who ended it');
select pg_temp.as_session('mia', 'aal1', interval '10 minutes');
select is(pg_temp.my_orgs(), 'org_b', 'the control is in force again on the next request');

-- After an end or an expiry the control can be suspended again.
select pg_temp.as_secret_key();
select lives_ok(format($$select app.suspend_session_gate_control(%L, 'mfa', 'support: pgTAP', 'The Owners need one more hour to enroll again.', 1)$$,
  pg_temp.id('org_a')), 'an ended suspension does not stand in the way of a new one');
select pg_temp.as_platform();
insert into private.session_gate_overrides (org_id, control, actor, reason, starts_at, expires_at)
values (pg_temp.id('org_a'), 'idle', 'support: pgTAP', 'An override that expired by itself an hour ago.', now() - interval '3 hours', now() - interval '1 hour');
insert into made select 'expired', o.id from private.session_gate_overrides o where o.control = 'idle';
select pg_temp.as_secret_key();
select lives_ok(format($$select app.suspend_session_gate_control(%L, 'idle', 'support: pgTAP', 'The idle rule locks the show caller out mid-show.', 4)$$,
  pg_temp.id('org_a')), 'nor does one that expired by itself');
select is(app.end_session_gate_suspension((select id from made where name = 'expired'), 'support: closing operator'), false,
  'and an expired override is not ended again');

select * from finish();
rollback;

-- pgTAP: 6812, billing alerts in the operator console (ADR 0161). Only a live operator with a second factor reads them, only
-- plans.write closes one, closing needs a reason and lands in the console ledger, and an alert outlives the org it names.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(17);

create function pg_temp.as_op(p_key text, p_aal text default 'aal2') returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.id(p_key || '_user'), 'role', 'authenticated', 'aal', p_aal)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

select pg_temp.new_user('olga', 'olga@platform.test', 'Olga Brandt');
select pg_temp.new_user('omar', 'omar@platform.test', 'Omar Haddad');
select pg_temp.new_user('rudi', 'rudi@platform.test', 'Rudi Kask');
select pg_temp.as_platform();
select private.grant_platform_operator('olga@platform.test', 'Administrator', 'First platform administrator.');
select private.grant_platform_operator('omar@platform.test', 'Support', 'Support on call.');
select private.grant_platform_operator('rudi@platform.test', 'Support', 'Support for the summer.');
update app.platform_operators set revoked_at = now(), revoke_reason = 'Summer ended.' where person_id = pg_temp.id('rudi');

-- One alert on a live org, one on an org already purged whose name only its Stripe cancel remembers.
insert into world values ('alert_live', private.raise_billing_alert('charged_after_cancel', 'charged_after_cancel:in_1', pg_temp.id('org_a'), 'sub_N0rth', 'Stripe charged 149.00 USD on invoice in_1.'));
insert into world values ('gone', '00000000-0000-4000-8000-00000000dead');
insert into private.stripe_cancellations (subject_org_id, org_name, stripe_subscription_id, livemode, cancel_mode, source)
values (pg_temp.id('gone'), 'Long Gone Ltd', 'sub_G0ne', false, 'Immediately', 'Reconciliation');
insert into world values ('alert_gone', private.raise_billing_alert('active_on_deleted_org', 'active_on_deleted_org:sub_G0ne', pg_temp.id('gone'), 'sub_G0ne', 'Stripe says sub_G0ne is active, but its org has been deleted.'));
update private.billing_alerts set raised_at = now() - interval '1 hour' where id = pg_temp.id('alert_live');
insert into world values ('alert_closed', private.raise_billing_alert('deletion_blocked', 'deletion_blocked:' || pg_temp.id('org_b'), pg_temp.id('org_b'), null, 'Waiting on Stripe.'));
update private.billing_alerts set resolved_at = now() where id = pg_temp.id('alert_closed');

-- Reading ----------------------------------------------------------------------------------------------------------------
select pg_temp.as_op('nina');
select throws_ok($$select * from app.console_billing_alerts()$$, '42501', 'the operator console is for the platform team', 'a person off the platform team reads no alerts');
select pg_temp.as_user('alice');
select throws_ok($$select * from app.console_billing_alerts()$$, '42501', 'the operator console is for the platform team', 'nor does a tenant''s Owner');
select pg_temp.as_op('rudi');
select throws_ok($$select * from app.console_billing_alerts()$$, '42501', 'the operator console is for the platform team', 'nor a revoked operator');
select pg_temp.as_op('olga', 'aal1');
select throws_ok($$select * from app.console_billing_alerts()$$, 'XR001', null, 'nor an operator without a second factor');
select pg_temp.as_op('omar');
select results_eq($$select alert_id, org_name from app.console_billing_alerts()$$,
  $$values (pg_temp.id('alert_gone'), 'Long Gone Ltd'::text), (pg_temp.id('alert_live'), 'Northwind Live'::text)$$,
  'Support (tenants.read) reads the open alerts, newest first, naming an org the purge has already deleted');
select pg_temp.as_op('olga');
select is((select count(*)::integer from app.console_billing_alerts(1)), 1, 'the limit holds');

-- Closing ----------------------------------------------------------------------------------------------------------------
select pg_temp.as_op('nina');
select throws_ok($$select app.console_resolve_billing_alert(pg_temp.id('alert_live'), 'Refunded.')$$, '42501', 'the operator console is for the platform team', 'a person off the platform team closes nothing');
select pg_temp.as_op('omar');
select throws_ok($$select app.console_resolve_billing_alert(pg_temp.id('alert_live'), 'Refunded.')$$, '42501', null, 'Support cannot close one: closing needs plans.write');
select pg_temp.as_op('olga', 'aal1');
select throws_ok($$select app.console_resolve_billing_alert(pg_temp.id('alert_live'), 'Refunded.')$$, 'XR001', null, 'nor can an Administrator without a second factor');
select pg_temp.as_op('olga');
select throws_ok($$select app.console_resolve_billing_alert(pg_temp.id('alert_live'), '   ')$$, 'XR001', 'billing_alert_reason: Say what was done about it, in up to 500 characters.', 'closing needs a reason');
select throws_ok($$select app.console_resolve_billing_alert(pg_temp.id('alert_live'), repeat('x', 501))$$, 'XR001', 'billing_alert_reason: Say what was done about it, in up to 500 characters.', 'of a sensible length');
select is(app.console_resolve_billing_alert(pg_temp.id('alert_live'), 'Refunded in Stripe and told the Owner.'), pg_temp.id('alert_live'), 'the Administrator closes it with what was done');
select pg_temp.as_platform();
select results_eq($$select operator_person_id, action, target_org_id, subject_table, subject_id, reason, details ->> 'kind' from app.platform_operator_actions where action = 'billing_alert.resolved'$$,
  $$values (pg_temp.id('olga'), 'billing_alert.resolved'::text, pg_temp.id('org_a'), 'private.billing_alerts'::text, pg_temp.id('alert_live'), 'Refunded in Stripe and told the Owner.'::text, 'charged_after_cancel'::text)$$,
  'and it lands in the console ledger');
select ok((select resolved_at is not null from private.billing_alerts where id = pg_temp.id('alert_live')), 'the alert is closed');
select pg_temp.as_op('olga');
select throws_ok($$select app.console_resolve_billing_alert(pg_temp.id('alert_live'), 'Again.')$$, 'XR001', 'billing_alert_unknown: This alert is already closed.', 'closing it twice is refused');
select throws_ok($$select app.console_resolve_billing_alert('00000000-0000-4000-8000-000000000000', 'Nothing.')$$, 'XR001', 'billing_alert_unknown: This alert is already closed.', 'as is an alert that does not exist');
select lives_ok($$select app.console_resolve_billing_alert(pg_temp.id('alert_gone'), 'Checked: no charge.')$$, 'an alert on a purged org can be closed too');

select * from finish();
rollback;

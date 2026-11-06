-- pgTAP: auto-renewal (6141, ADR 0161). An Owner's agreement to the renewal terms is recorded word for word before Checkout,
-- a live Checkout cannot be recorded without it, the purchase is confirmed with the same terms, and an annual plan gets a
-- reminder 30 days before it renews.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(31);

create function pg_temp.as_service() returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('role', 'service_role', true);
end $$;

select pg_temp.as_user('nina');
insert into world values ('org_n', app.create_organization('Nina Lighting', 'nina-lighting'));

create function pg_temp.consent(p_amount bigint, p_interval app.billing_interval, p_initials text default '', p_date date default (now() at time zone 'UTC')::date, p_statement text default 'Core renews automatically.') returns uuid
language sql as $$
  select app.record_renewal_consent(pg_temp.id('org_n'), 'core', p_interval, p_amount, 'USD', p_date, '2026-11-06', 'en-US', p_statement, p_initials, true) $$;

select pg_temp.as_platform();
select ok(not has_table_privilege('authenticated', 'private.billing_renewal_consents', 'select'), 'nobody reads consents directly');

-- What is refused --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$select app.record_renewal_consent(pg_temp.id('org_a'), 'core', 'Monthly', 14900, 'USD', current_date, '2026-11-06', 'en-US', 'x', '', true)$$, '42501', null,
  'only who manages billing agrees');
select pg_temp.as_user('nina');
select throws_ok($$select pg_temp.consent(100, 'Monthly')$$, 'XR001', 'renewal_price_mismatch: The price shown is not the plan''s price. Reload the page and try again.', 'the price must be the plan''s');
select throws_ok($$select pg_temp.consent(14900, 'Annual')$$, 'XR001', 'renewal_price_mismatch: The price shown is not the plan''s price. Reload the page and try again.', 'and the annual one is ten months');
select throws_ok($$select pg_temp.consent(149000, 'Annual')$$, 'XR001', 'renewal_initials_required: Type your initials to agree to an annual renewal.', 'an annual plan needs initials');
select throws_ok($$select pg_temp.consent(14900, 'Monthly', '', (now() at time zone 'UTC')::date + 30)$$, 'XR001', 'renewal_date_range: The first charge is today or when the running trial ends.', 'the first charge is soon');
select throws_ok($$select pg_temp.consent(14900, 'Monthly', '', (now() at time zone 'UTC')::date, '')$$, 'XR001', 'renewal_statement_required: The renewal terms must be shown before you agree to them.', 'the terms must be there');
select throws_ok($$select app.record_renewal_consent(pg_temp.id('org_n'), 'access', 'Monthly', 14900, 'USD', current_date, '2026-11-06', 'en-US', 'x', '', true)$$, 'XR001',
  'plan_not_self_serve: The access plan cannot be bought through Checkout.', 'a plan sold by nobody');

-- A live Checkout needs consent -------------------------------------------------------------------------------------------
select pg_temp.as_user_stepped_up('nina');
select throws_ok($$select app.record_billing_checkout(pg_temp.id('org_n'), 'core', 'Monthly', 'cs_live_N0Consent', true, now() + interval '1 hour')$$, 'XR001',
  'renewal_consent_required: Agree to the renewal terms before you pay.', 'a live Checkout cannot be recorded without consent');
select pg_temp.as_user('nina');
insert into world values ('consent_n', pg_temp.consent(14900, 'Monthly'));
select pg_temp.as_platform();
select results_eq($$select consented_by, plan_code, billing_interval::text, amount_minor, text_version, locale, statement, initials, stripe_checkout_session_id
                    from private.billing_renewal_consents where id = pg_temp.id('consent_n')$$,
  $$values (pg_temp.id('nina'), 'core'::text, 'Monthly'::text, 14900::bigint, '2026-11-06'::text, 'en-US'::text, 'Core renews automatically.'::text, null::text, null::text)$$,
  'consent records what was agreed, word for word, with its version');
select ok((select consented_by_email is not null and subject_org_id = pg_temp.id('org_n') from private.billing_renewal_consents where id = pg_temp.id('consent_n')), 'and who, with an address that outlasts the account');
select throws_ok($$update private.billing_renewal_consents set statement = 'Something else.' where id = pg_temp.id('consent_n')$$, 'XR001',
  'renewal_consent_immutable: A renewal consent is evidence and cannot be changed.', 'consent cannot be rewritten');
select throws_ok($$delete from private.billing_renewal_consents where id = pg_temp.id('consent_n')$$, 'XR001',
  'renewal_consent_immutable: A renewal consent is evidence and cannot be deleted.', 'or deleted');
select pg_temp.as_user_stepped_up('nina');
select lives_ok($$select app.record_billing_checkout(pg_temp.id('org_n'), 'core', 'Monthly', 'cs_live_W1thConsent', true, now() + interval '1 hour')$$, 'with consent the Checkout is recorded');
select pg_temp.as_platform();
select is((select stripe_checkout_session_id from private.billing_renewal_consents where id = pg_temp.id('consent_n')), 'cs_live_W1thConsent', 'and tied to it');

-- After purchase ---------------------------------------------------------------------------------------------------------
select pg_temp.as_service();
select ok(app.finish_billing_checkout_from_stripe('cs_live_W1thConsent', 'Completed'), 'Stripe reports the Checkout completed');
select pg_temp.as_platform();
select results_eq($$select message_args ->> 'plan', message_args ->> 'term', message_args ->> 'price' from app.notifications where kind = 'billing.purchase_confirmed' and org_id = pg_temp.id('org_n')$$,
  $$values ('Core'::text, 'Monthly'::text, '149.00 USD'::text)$$, 'the confirmation gives the same terms');
select pg_temp.as_service();
select app.finish_billing_checkout_from_stripe('cs_live_W1thConsent', 'Completed');
select pg_temp.as_platform();
select is((select count(*)::integer from app.notifications where kind = 'billing.purchase_confirmed' and org_id = pg_temp.id('org_n')), 1, 'once');

-- Before an annual renewal -------------------------------------------------------------------------------------------------
select pg_temp.as_service();
select app.sync_subscription_from_stripe(pg_temp.id('org_b'), 'cus_H4rb', 'sub_H4rb', 'team', 'Annual', 'active', now() + interval '29 days', false);
select app.sync_subscription_from_stripe(pg_temp.id('org_a'), 'cus_N0rth', 'sub_N0rth', 'team', 'Monthly', 'active', now() + interval '29 days', false);
select app.note_stripe_subscription_terms('sub_H4rb', null, 149000, 'usd', now());
select pg_temp.as_platform();
select is(private.run_billing_renewal_reminders(now()), 0, 'a subscription bought within the month has its purchase confirmation');
select is(private.run_billing_renewal_reminders(now() + interval '31 days' - interval '29 days' * 0), 0, 'and nothing past its renewal date is reminded');
update app.stripe_subscription_links set created_at = now() - interval '335 days' where stripe_subscription_id in ('sub_H4rb', 'sub_N0rth');
select is(private.run_billing_renewal_reminders(now()), 1, 'only the annual plan is reminded, 30 days ahead');
select results_eq($$select message_args ->> 'plan', message_args ->> 'price', (message_args ->> 'renewsOn') is not null from app.notifications where kind = 'billing.renewal_reminder' and org_id = pg_temp.id('org_b') limit 1$$,
  $$values ('Team'::text, '1,490.00 USD'::text, true)$$, 'with the plan, the amount Stripe charges and the date');
select is((select count(*)::integer from app.notifications where kind = 'billing.renewal_reminder' and org_id = pg_temp.id('org_a')), 0, 'never a monthly plan');
select is(private.run_billing_renewal_reminders(now()), 0, 'and once per term');
select ok(exists (select 1 from private.billing_renewal_reminders where stripe_subscription_id = 'sub_H4rb' and amount_text = '1,490.00 USD'), 'with proof of notice');
delete from private.billing_renewal_reminders;
select pg_temp.as_service();
select app.note_stripe_subscription_terms('sub_H4rb', now() + interval '29 days', null, null, now() + interval '1 minute');
select pg_temp.as_platform();
select is(private.run_billing_renewal_reminders(now()), 0, 'a plan already ending gets no reminder');

-- Retention -----------------------------------------------------------------------------------------------------------
select is(private.run_billing_evidence_retention(now() + interval '6 years'), 0, 'evidence is kept for 7 years');
select ok(private.run_billing_evidence_retention(now() + interval '7 years 1 day') >= 1, 'and swept after');
select is((select count(*)::integer from private.billing_renewal_consents where id = pg_temp.id('consent_n')), 0, 'consents included');

select * from finish();
rollback;

-- pgTAP: account support requests (A70, Section 11.16). Anyone signed in, member or not, asks platform
-- support about their own account and reads only their own requests; nobody reads the table through
-- the API; only account matters are taken; diagnostics need consent and the person's own screenshot;
-- five requests a day at most; a request keeps what was asked while the platform team moves its state.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(19);


select has_table('private', 'account_support_requests', 'the requests live in private');
select is((select relrowsecurity from pg_class where oid = 'private.account_support_requests'::regclass), true,
  'row level security is on');

-- nina signed up with no org: an external party asks about her own account.
select pg_temp.as_user('nina');
select matches(app.open_account_support_request('Access', 'Email link never arrives', 'I asked for a sign-in link twice.'),
  '^ACC-[0-9]{6}$', 'a person with no org sends a request and gets its number');
select is((select count(*)::int from app.my_account_support_requests()), 1, 'and reads it back');
select is((select request_state::text from app.my_account_support_requests()), 'Open', 'it starts Open');
select throws_ok($$select count(*) from private.account_support_requests$$, '42501', null,
  'the table itself is not readable through the API');

select throws_ok($$select app.open_account_support_request('Billing', 'Invoice', 'Where is my payment?')$$,
  'XR001', 'account_support_category: Platform support helps only with your own account; ask the organization about anything else in Messages.',
  'billing goes to the organization, not platform support');
select throws_ok($$select app.open_account_support_request('Account', '   ', 'Body')$$,
  'XR001', null, 'a blank subject is refused');
select throws_ok($$select app.open_account_support_request('Account', 'Delete', 'Please help.', '{"route": "/settings/account"}'::jsonb)$$,
  'XR001', 'support_diagnostics_consent: Diagnostics are attached only when you agree to send them.',
  'diagnostics without consent are refused');
select throws_ok(format($$select app.open_account_support_request('Problem', 'Borrowed', 'Someone else''s screen.',
  jsonb_build_object('consent', 'true', 'screenshot_path', %L))$$, pg_temp.id('dave')::text || '/screen.png'),
  'XR001', 'support_screenshot_owner: A screenshot is attached only from the requester''s own uploads.',
  'never someone else''s screenshot');
select lives_ok(format($$select app.open_account_support_request('Problem', 'Settings will not save', 'The page spins.',
  jsonb_build_object('consent', 'true', 'route', '/settings/account', 'app_version', '4.0.0', 'device', 'Safari 19',
    'screenshot_path', %L))$$, pg_temp.id('nina')::text || '/screen-1.png'),
  'diagnostics with consent and her own screenshot are kept');

-- dave is a member of Northwind Live; he sees only his own requests.
select pg_temp.as_user('dave');
select lives_ok($$select app.open_account_support_request('Account', 'Change my sign-in email', 'I moved to a new address.')$$,
  'a member may ask about his own account too');
select is((select count(*)::int from app.my_account_support_requests()), 1, 'and sees only his own request');

select pg_temp.as_user('nina');
select lives_ok($$select app.open_account_support_request('Question', 'Third', 'Third request.')$$, 'a third request');
select lives_ok($$select app.open_account_support_request('Question', 'Fourth', 'Fourth request.')$$, 'a fourth request');
select lives_ok($$select app.open_account_support_request('Question', 'Fifth', 'Fifth request.')$$, 'a fifth request');
select throws_ok($$select app.open_account_support_request('Question', 'Sixth', 'Sixth request.')$$,
  'XR001', 'account_support_limit: You sent five requests in the last day. Platform support answers each by email; wait for those answers first.',
  'the sixth in a day is refused');

-- The platform team works the queue with the service role.
select pg_temp.as_platform();
update private.account_support_requests set request_state = 'Resolved'
where subject = 'Email link never arrives';
select is((select request_state::text from private.account_support_requests where subject = 'Email link never arrives'),
  'Resolved', 'the platform team moves a request''s state');
select throws_ok($$update private.account_support_requests set body = 'Rewritten' where subject = 'Email link never arrives'$$,
  'XR001', 'account_support_immutable: An account support request keeps what was asked; only its state changes.',
  'but never rewrites what was asked');

select * from finish();
rollback;

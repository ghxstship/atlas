-- pgTAP: migration 1201, the org IP allow-list (A52, ADR 0032 amendment). Enforcement is off by default, so every address
-- reaches an org until it lists a network and turns the switch on. The switch refuses an empty list and a plan without the
-- feature; the last entry stays while enforcing; an address outside the list is refused once on and an unknown address
-- fails closed. app.network_access answers only for the caller's own orgs. A Member cannot write entries; cross-tenant and
-- anon denied.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(23);

select has_table('app', 'org_ip_allowlist', 'app.org_ip_allowlist exists');
select is((select value_type::text || ':' || default_boolean::text from app.setting_definitions where setting_key = 'security.ip_allowlist'),
  'Boolean:false', 'security.ip_allowlist is the enforcement switch and defaults to off');

-- Off by default: every address passes, with or without a list.
select pg_temp.as_user('dave');
select results_eq($$select enforced, allowed from app.network_access((select id from world where key = 'org_a'), '198.51.100.7')$$,
  $$values (false, true)$$, 'an org that never turned the allow-list on admits every address');
select results_eq($$select enforced, allowed from app.network_access((select id from world where key = 'org_a'), null)$$,
  $$values (false, true)$$, 'and an unknown address too');
select is((select count(*)::int from app.network_access((select id from world where key = 'org_b'), '198.51.100.7')), 0,
  'app.network_access answers only for the caller''s own orgs');

select pg_temp.as_user('bob');
select throws_ok($$select app.set_setting((select id from world where key = 'org_a'), 'security.ip_allowlist', 'Organization', null, null, true)$$,
  'XR001', 'ip_allowlist_empty: List at least one network before turning the allow-list on.', 'the switch cannot turn on with an empty list');
select lives_ok($$insert into app.org_ip_allowlist (org_id, cidr, label) values ((select id from world where key = 'org_a'), '203.0.113.0/24', 'Office')$$,
  'an Admin lists the office network');
select throws_ok($$insert into app.org_ip_allowlist (org_id, cidr, label) values ((select id from world where key = 'org_a'), '0.0.0.0/0', 'Everything')$$,
  '23514', null, 'a block covering every address is refused');
select throws_ok($$insert into app.org_ip_allowlist (org_id, cidr, label) values ((select id from world where key = 'org_a'), '203.0.113.0/24', 'Again')$$,
  '23505', null, 'a network appears once per org');
select results_eq($$select enforced, allowed, covered from app.network_access((select id from world where key = 'org_a'), '198.51.100.7')$$,
  $$values (false, true, false)$$, 'listing a network does not enforce it; covered says the address is outside the list');
select lives_ok($$select app.set_setting((select id from world where key = 'org_a'), 'security.ip_allowlist', 'Organization', null, null, true)$$,
  'an Admin turns the allow-list on');

select pg_temp.as_user('dave');
select results_eq($$select enforced, allowed from app.network_access((select id from world where key = 'org_a'), '203.0.113.40')$$,
  $$values (true, true)$$, 'an address inside the office network passes');
select results_eq($$select enforced, allowed from app.network_access((select id from world where key = 'org_a'), '198.51.100.7')$$,
  $$values (true, false)$$, 'an address outside every listed network is refused');
select results_eq($$select enforced, allowed from app.network_access((select id from world where key = 'org_a'), '::ffff:203.0.113.40')$$,
  $$values (true, true)$$, 'an IPv4 address written as IPv4-mapped IPv6 is compared as IPv4');
select results_eq($$select enforced, allowed from app.network_access((select id from world where key = 'org_a'), 'not-an-address')$$,
  $$values (true, false)$$, 'an unknown address fails closed while enforcing');
select throws_ok($$insert into app.org_ip_allowlist (org_id, cidr, label) values ((select id from world where key = 'org_a'), '198.51.100.0/24', 'Home')$$,
  '42501', null, 'a Member cannot add a network');

select pg_temp.as_user('bob');
select throws_ok($$update app.org_ip_allowlist set deleted_at = now() where label = 'Office'$$,
  'XR001', 'ip_allowlist_last_entry: Turn the allow-list off before removing its last network.', 'the last network stays while enforcing');
select lives_ok($$select app.set_setting((select id from world where key = 'org_a'), 'security.ip_allowlist', 'Organization', null, null, false)$$,
  'an Admin turns the allow-list off');
select lives_ok($$update app.org_ip_allowlist set deleted_at = now() where label = 'Office'$$, 'then removes the last network');

-- The plan gate: Harbor Lights is on Access.
select pg_temp.as_user('xavier');
select throws_ok($$insert into app.org_ip_allowlist (org_id, cidr, label) values ((select id from world where key = 'org_b'), '203.0.113.0/24', 'Office')$$,
  'XR001', 'plan_feature_ip_allowlist: The IP allow-list is part of the Team and Enterprise plans.', 'a plan without the feature cannot list networks');
select throws_ok($$select app.set_setting((select id from world where key = 'org_b'), 'security.ip_allowlist', 'Organization', null, null, true)$$,
  'XR001', null, 'nor turn the switch on');
select is((select count(*)::int from app.org_ip_allowlist), 0, 'cross-tenant: another org reads no entries');

select pg_temp.as_anon();
select throws_ok('select 1 from app.org_ip_allowlist', '42501', null, 'anon reads no allow-list');

select * from finish();
rollback;

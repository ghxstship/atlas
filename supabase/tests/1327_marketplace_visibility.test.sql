-- pgTAP: migration 1327, gateway.marketplace_visibility caps how widely an org's opportunities reach (A76, RRR-121,
-- A65-001). Under the default (network) a Public opportunity is not published; under private a Network one is not
-- either, while Invited and Pool still are. Lowering the setting hides wider listings already published, except to
-- the people invited by name.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(10);

create function pg_temp.sees(p_who text, p_opportunity text) returns boolean
language plpgsql as $$
declare v boolean;
begin
  perform pg_temp.claims(p_who);
  v := exists (select 1 from private.visible_opportunity_ids() x where x = pg_temp.id(p_opportunity));
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.opp(p_key text, p_visibility text) returns uuid
language plpgsql as $$
declare v uuid;
begin
  insert into app.opportunities (project_id, role_type, title, visibility, rate_type, deadline_at, starts_on, ends_on)
  values (pg_temp.id('prj_a'), 'Vendor', 'Summer Series ' || p_key, p_visibility::app.opportunity_visibility, 'Bid',
    now() + interval '7 days', '2027-06-01', '2027-06-03')
  returning id into v;
  insert into world values (p_key, v);
  return v;
end $$;
grant execute on function pg_temp.opp(text, text) to public;

create function pg_temp.publish(p_key text) returns void
language plpgsql as $$
begin
  perform app.transition_opportunity(pg_temp.id(p_key), 'Draft', 'Pending Approval', 'Ready for approval.');
  perform app.transition_opportunity(pg_temp.id(p_key), 'Pending Approval', 'Published', 'Approved.');
end $$;
grant execute on function pg_temp.publish(text) to public;

-- An external with a completed engagement with org_a (Network) and an invitee.
select pg_temp.move_engagement('eng_vendor_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_vendor_a', 'Active', 'Closing');
select pg_temp.move_engagement('eng_vendor_a', 'Closing', 'Complete');

select pg_temp.as_user('carol');
select pg_temp.opp('opp_public', 'Public');
select throws_ok($$select pg_temp.publish('opp_public')$$, 'XR001',
  'opportunity_visibility_above_org: Your organization''s marketplace visibility is network; publish to a narrower audience or change it in Settings.',
  'under the default (network), a Public opportunity is not published');
select pg_temp.opp('opp_net', 'Network');
select lives_ok($$select pg_temp.publish('opp_net')$$, 'a Network opportunity is');
select ok(pg_temp.sees('victor', 'opp_net'), 'and reaches an account with a completed engagement');

select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'gateway.marketplace_visibility', 'Organization', pg_temp.id('org_a'), p_value_text => 'public');
select pg_temp.as_user('carol');
select lives_ok($$select pg_temp.publish('opp_public')$$, 'listing publicly lets the Public opportunity through');
select ok(pg_temp.sees('quinn', 'opp_public'), 'and everyone sees it');

select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'gateway.marketplace_visibility', 'Organization', pg_temp.id('org_a'), p_value_text => 'private');
select pg_temp.as_platform();
select ok(not pg_temp.sees('quinn', 'opp_public'), 'turning the org private hides its Public listing at once');
select ok(not pg_temp.sees('victor', 'opp_net'), 'and its Network listing');
select pg_temp.as_user('carol');
insert into app.opportunity_invitations (opportunity_id, person_id) values (pg_temp.id('opp_net'), pg_temp.id('quinn'));
select ok(pg_temp.sees('quinn', 'opp_net'), 'people invited by name still see it');
select pg_temp.as_user('carol');
select pg_temp.opp('opp_net2', 'Network');
select throws_ok($$select pg_temp.publish('opp_net2')$$, 'XR001', null, 'a private org cannot publish to its network');
select pg_temp.opp('opp_inv', 'Invited');
select lives_ok($$select pg_temp.publish('opp_inv')$$, 'but still publishes to invitees');

select * from finish();
rollback;

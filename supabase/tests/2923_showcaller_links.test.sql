-- pgTAP: migration 2923, B3 (RRR-227, ADR 0142). Showcaller links: only a member holding show.run_of_show.write and
-- show.cue.call makes one, with a caller name, an expiry within 14 days and at most 5 per running order; tokens and codes
-- are stored only as hashes the signed-in roles cannot select; rows change only through the RPCs; regenerating and
-- revoking retire the token and drop the grants; a read-only org makes and regenerates none but still revokes; a cue
-- called through a link names the link and no person, and the link is never sent or changed by a caller; links stay out
-- of Trash and keep the default retention.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select * from no_plan();

create temporary table k (key text primary key, id uuid, val text);
grant select, insert, update, delete on k to public;

create function pg_temp.k(p_key text) returns uuid
language sql stable as $$ select id from k where key = p_key $$;
create function pg_temp.val(p_key text) returns text
language sql stable as $$ select val from k where key = p_key $$;

-- Makes a link as a person and keeps its id, token and code; answers the refusal rule or the SQLSTATE.
create function pg_temp.link(p_user text, p_key text, p_run text, p_name text default 'Sam Okafor', p_expires timestamptz default null) returns text
language plpgsql as $$
declare
  v_row record;
begin
  perform pg_temp.as_user(p_user);
  begin
    select * into v_row from app.create_showcaller_link(pg_temp.id(p_run), p_name, p_expires, 'Guest caller for night one') limit 1;
  exception when sqlstate 'XR001' then
    perform pg_temp.as_platform();
    return split_part(sqlerrm, ':', 1);
  when insufficient_privilege then
    perform pg_temp.as_platform();
    return '42501';
  end;
  perform pg_temp.as_platform();
  insert into k values (p_key, v_row.showcaller_link_id, v_row.token), (p_key || ':code', null, v_row.access_code)
  on conflict (key) do update set id = excluded.id, val = excluded.val;
  return 'ok';
end $$;

create function pg_temp.try(p_who text, p_sql text) returns text
language plpgsql as $$
begin
  if p_who = 'platform' then
    perform pg_temp.as_platform();
  else
    perform pg_temp.as_user(p_who);
  end if;
  begin
    execute p_sql;
  exception
    when sqlstate 'XR001' then
      perform pg_temp.as_platform();
      return split_part(sqlerrm, ':', 1);
    when insufficient_privilege then
      perform pg_temp.as_platform();
      return '42501';
    when check_violation then
      perform pg_temp.as_platform();
      return '23514';
  end;
  perform pg_temp.as_platform();
  return 'ok';
end $$;

select pg_temp.as_user('dave');
with x as (insert into app.run_of_show (project_id, scope_node_id, name, show_date)
  values (pg_temp.id('prj_a'), pg_temp.id('show_a'), 'Opening Night', current_date + 5) returning id)
  insert into world select 'ros', id from x;
with x as (insert into app.run_of_show (project_id, name, show_date) values (pg_temp.id('prj_a'), 'Second Night', current_date + 6) returning id)
  insert into world select 'ros2', id from x;
insert into app.cues (run_of_show_id, position, label) values (pg_temp.id('ros'), 1, 'House to Half'), (pg_temp.id('ros'), 2, 'Host Welcome');
insert into world select 'q' || c.position, c.id from app.cues c where c.run_of_show_id = pg_temp.id('ros');
select pg_temp.as_platform();

-- People with half the capabilities: mia edits without calling, gina calls without editing.
select pg_temp.as_user('alice');
insert into app.user_capability_grants (membership_id, capability_code, scope_kind, scope_id, reason) values
  (pg_temp.id('mia@org_a'), 'show.run_of_show.write', 'project', pg_temp.id('prj_a'), 'Script supervisor for the run.'),
  (pg_temp.id('mia@org_a'), 'show.run_of_show.read', 'project', pg_temp.id('prj_a'), 'Script supervisor for the run.'),
  (pg_temp.id('gina@org_a'), 'show.cue.call', 'project', pg_temp.id('prj_a'), 'Calls the show from the booth.');
select pg_temp.as_platform();

-- Making links -------------------------------------------------------------------------------------------------------------------
select is(pg_temp.link('dave', 'l1', 'ros'), 'ok', 'a member who edits and calls the running order makes a showcaller link');
select matches(pg_temp.val('l1'), '^xscl_[0-9a-f]{64}$', 'the token is xscl_ and 256 random bits');
select matches(pg_temp.val('l1:code'), '^[0-9]{6}$', 'with a 6-digit access code');
select results_eq(format($$select token_hash = private.share_token_hash(%L), access_code_hash = private.share_code_hash(%L, %L),
    token_hint = right(%L, 4), caller_name, note, project_id = %L from app.showcaller_links where id = %L$$,
    pg_temp.val('l1'), pg_temp.val('l1'), pg_temp.val('l1:code'), pg_temp.val('l1'), pg_temp.id('prj_a'), pg_temp.k('l1')),
  $$values (true, true, true, 'Sam Okafor'::text, 'Guest caller for night one'::text, true)$$,
  'only the hashes are stored, with the hint, the caller, the note and the project stamped from the running order');
select ok((select expires_at > now() and expires_at <= now() + interval '14 days' from app.showcaller_links where id = pg_temp.k('l1')),
  'by default it expires within 14 days');
select ok((select expires_at = private.showcaller_link_default_expiry(pg_temp.id('ros')) from app.showcaller_links where id = pg_temp.k('l1')),
  'at the end of the day after the show');
select ok(exists (select 1 from private.showcaller_link_channels where showcaller_link_id = pg_temp.k('l1') and channel_key ~ '^xcch_[0-9a-f]{64}$'),
  'with its own channel key');
select ok(exists (select 1 from app.domain_events where event_type = 'showcaller_link.created' and subject_id = pg_temp.k('l1')), 'making it is an event');

select is(pg_temp.link('mia', 'x', 'ros'), 'showcaller_link_capability', 'editing without show.cue.call is not enough');
select is(pg_temp.link('gina', 'x', 'ros'), 'showcaller_link_capability', 'nor calling without show.run_of_show.write');
select is(pg_temp.link('xavier', 'x', 'ros'), '42501', 'another org is told the running order does not exist');
select is(pg_temp.link('dave', 'x', 'ros', '   '), 'showcaller_link_caller_name', 'the caller needs a name');
select is(pg_temp.link('dave', 'x', 'ros', 'Sam', now() + interval '15 days'), 'showcaller_link_expiry_range', 'and the link at most 14 days');
select is(pg_temp.link('dave', 'x', 'ros', 'Sam', now() - interval '1 minute'), 'showcaller_link_expiry_range', 'after now');
select is(pg_temp.link('dave', 'l2', 'ros'), 'ok', 'a second link');
select is(pg_temp.link('dave', 'l3', 'ros'), 'ok', 'a third');
select is(pg_temp.link('dave', 'l4', 'ros'), 'ok', 'a fourth');
select is(pg_temp.link('dave', 'l5', 'ros'), 'ok', 'a fifth');
select is(pg_temp.link('dave', 'x', 'ros'), 'showcaller_link_limit', 'a running order holds at most 5 live links');
select is(pg_temp.link('dave', 'l6', 'ros2'), 'ok', 'which is per running order');

-- Privileges -------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$select token_hash from app.showcaller_links$$, '42501', null, 'signed-in callers never select a token hash');
select throws_ok($$select access_code_hash from app.showcaller_links$$, '42501', null, 'nor an access code hash');
select is((select count(*)::int from app.showcaller_links where run_of_show_id = (select id from world where key = 'ros')), 5,
  'they read the links of running orders they can read');
select throws_ok(format($$update app.showcaller_links set caller_name = 'X' where id = %L$$, pg_temp.k('l1')), '42501', null,
  'and never write one');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.showcaller_links), 0, 'another org reads none');
select pg_temp.as_platform();
select is(pg_temp.try('platform', format($$update app.showcaller_links set caller_name = 'X' where id = %L$$, pg_temp.k('l1'))),
  'showcaller_link_immutable', 'even the platform changes a link only through the RPCs');
select is((select link_state from app.showcaller_link_states where id = pg_temp.k('l1')), 'Active', 'a new link is Active');
select ok(not has_table_privilege('xos_backup', 'app.showcaller_link_states', 'select'), 'the backup login reads no computed link state');
select is(pg_temp.try('frank', format('select app.showcaller_link_devices(%L)', pg_temp.k('l1'))), '42501',
  'only a manager of the link reads its device count');
select pg_temp.as_user('dave');
select is(app.showcaller_link_devices(pg_temp.k('l1')), 0, 'which starts at none');
select pg_temp.as_platform();

-- Regenerating, signing out and revoking ---------------------------------------------------------------------------------------
insert into private.showcaller_link_grants (grant_hash, showcaller_link_id, expires_at)
values (private.share_token_hash('xcgr_' || repeat('a', 64)), pg_temp.k('l1'), now() + interval '1 hour');
select pg_temp.as_user('dave');
insert into k select 'l1:new', null, r.token from app.regenerate_showcaller_link(pg_temp.k('l1')) r;
select pg_temp.as_platform();
select ok(pg_temp.val('l1:new') <> pg_temp.val('l1'), 'regenerating draws a new token');
select ok(exists (select 1 from private.retired_showcaller_link_tokens where token_hash = private.share_token_hash(pg_temp.val('l1'))),
  'and retires the old one');
select is((select count(*)::int from private.showcaller_link_grants where showcaller_link_id = pg_temp.k('l1')), 0, 'and drops every grant');
select ok((select rotated_at is not null and failed_attempts = 0 from app.showcaller_links where id = pg_temp.k('l1')), 'and says when');
insert into private.showcaller_link_grants (grant_hash, showcaller_link_id, expires_at)
values (private.share_token_hash('xcgr_' || repeat('b', 64)), pg_temp.k('l1'), now() + interval '1 hour');
select pg_temp.as_user('dave');
select is(app.sign_out_showcaller_devices(pg_temp.k('l1')), 1, 'signing devices out drops their grants');
select pg_temp.as_platform();
select ok(exists (select 1 from app.audit_events where action = 'showcaller_link.signed_out' and subject_id = pg_temp.k('l1')), 'and is audited');
select is(pg_temp.try('frank', format('select app.revoke_showcaller_link(%L)', pg_temp.k('l2'))), '42501',
  'a member without show.run_of_show.write who did not make it cannot revoke it');
select is(pg_temp.try('carol', format('select app.revoke_showcaller_link(%L)', pg_temp.k('l2'))), 'ok',
  'an editor of the running order may');
select pg_temp.as_user('dave');
select ok(app.revoke_showcaller_link(pg_temp.k('l2')) = (select revoked_at from app.showcaller_links where id = pg_temp.k('l2')),
  'revoking again answers the first revocation');
select pg_temp.as_platform();
select is((select link_state from app.showcaller_link_states where id = pg_temp.k('l2')), 'Revoked', 'the link reads Revoked');
select is(pg_temp.try('dave', format('select * from app.regenerate_showcaller_link(%L)', pg_temp.k('l2'))), 'showcaller_link_revoked',
  'a revoked link stays revoked');

-- Cues called through a link -------------------------------------------------------------------------------------------------
select has_column('app', 'cues', 'called_via_link_id', 'a cue records the showcaller link it was called through');
select is(pg_temp.try('dave', format($$insert into app.cues (run_of_show_id, position, label, called_via_link_id) values (%L, 9, 'Sneaky', %L)$$,
  pg_temp.id('ros'), pg_temp.k('l1'))), 'cue_called_via_link', 'a caller never sends the link');
select pg_temp.as_user('dave');
select app.call_cue(pg_temp.id('q1'));
select pg_temp.as_platform();
select results_eq(format('select called_by = %L, called_via_link_id is null from app.cues where id = %L', pg_temp.id('dave'), pg_temp.id('q1')),
  $$values (true, true)$$, 'a signed-in call still names the person');
update app.cues set called_via_link_id = pg_temp.k('l1') where id = pg_temp.id('q1');
select is((select called_via_link_id from app.cues where id = pg_temp.id('q1')), null::uuid, 'and the link is never added to it afterwards');
select pg_temp.as_platform();
select private.begin_trusted_operation('showcaller_link');
select set_config('xos.showcaller_link_id', pg_temp.k('l1')::text, true);
update app.cues set called_at = now() where id = pg_temp.id('q2');
select private.end_trusted_operation('showcaller_link');
select results_eq(format('select called_by is null, called_via_link_id = %L, called_at is not null from app.cues where id = %L',
  pg_temp.k('l1'), pg_temp.id('q2')), $$values (true, true, true)$$, 'a call through a link names the link and no person');
select ok(exists (select 1 from app.domain_events where event_type = 'cue.called' and subject_id = pg_temp.id('q2')
  and data ->> 'called_via_link_id' = pg_temp.k('l1')::text), 'and the cue.called event carries the link');
alter table app.cues disable trigger t40_guard_cue;
select throws_ok(format('update app.cues set called_by = %L where id = %L', pg_temp.id('dave'), pg_temp.id('q2')), '23514', null,
  'a call never names both a person and a link (cues_called_pair, even past the guard)');
select throws_ok(format('update app.cues set called_via_link_id = null where id = %L', pg_temp.id('q2')), '23514', null,
  'and a called cue names one of them');
alter table app.cues enable trigger t40_guard_cue;

-- A read-only org: nothing new, but revocation still works -------------------------------------------------------------------
select ok(exists (select 1 from private.read_only_exempt_tables where table_name = 'app.showcaller_links'), 'revocation is exempt from the read-only guard');
select pg_temp.as_user('alice');
select app.cancel_organization(pg_temp.id('org_a'), 'Northwind Live', 'Season over; moving to another tool.');
select pg_temp.as_platform();
select is(pg_temp.link('dave', 'x', 'ros2'), 'org_read_only', 'a read-only org makes no new link');
select is(pg_temp.try('dave', format('select * from app.regenerate_showcaller_link(%L)', pg_temp.k('l3'))), 'org_read_only', 'nor regenerates one');
select is(pg_temp.try('dave', format('select app.revoke_showcaller_link(%L)', pg_temp.k('l3'))), 'ok', 'but revoking still withdraws access');

-- Trash and retention -------------------------------------------------------------------------------------------------------------
select ok(exists (select 1 from private.trash_excluded_tables where table_name = 'showcaller_links'), 'showcaller links are kept out of Trash');
select ok(not exists (select 1 from private.trash_tables where table_name = 'showcaller_links'), 'and sync_trash_tables leaves them out');
select is((select retention from private.retention_policies where table_name = 'app.showcaller_links'), interval '7 years',
  'they keep the default retention, so no link is purged before the cues that name it');

select * from finish();
rollback;

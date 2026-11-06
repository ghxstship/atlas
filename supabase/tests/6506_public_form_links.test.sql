-- pgTAP: migration 6506, B2 (RRR-226, ADR 0141). Public form links: only knowledge.sop.publish holders make them and only
-- for a Published form with no photo, signature or GPS; the open applies invariant 8; the read answers only what the page
-- renders; the spam controls hold; a response is filed Submitted with no record until approved; and app.submit_form keeps
-- its signature, codes and scores, as private.check_form_answers does on the same answers.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(40);

create temporary table k (key text primary key, id uuid, val text);
grant select, insert, update, delete on k to public;

create function pg_temp.k(p_key text) returns uuid language sql stable as $$ select id from k where key = p_key $$;
create function pg_temp.v(p_key text) returns text language sql stable as $$ select val from k where key = p_key $$;
create function pg_temp.put(p_key text, p_id uuid, p_val text) returns void language sql as $$
  insert into k values (p_key, p_id, p_val) on conflict (key) do update set id = excluded.id, val = excluded.val $$;
grant execute on function pg_temp.k(text), pg_temp.v(text) to public;

create function pg_temp.try(p_user text, p_sql text) returns text
language plpgsql as $$
begin
  perform pg_temp.as_user(p_user);
  begin
    execute p_sql;
  exception when sqlstate 'XR001' then
    perform pg_temp.as_platform();
    return split_part(sqlerrm, ':', 1);
  when others then
    perform pg_temp.as_platform();
    return sqlstate;
  end;
  perform pg_temp.as_platform();
  return 'ok';
end $$;

create function pg_temp.anon() returns void
language plpgsql as $$
begin
  perform pg_temp.as_anon();
  perform set_config('request.headers', json_build_object('x-forwarded-for', '192.0.2.10')::text, true);
end $$;

create function pg_temp.template(p_key text, p_fields jsonb, p_approver boolean default false, p_signature boolean default false, p_location boolean default false, p_publish boolean default true) returns uuid
language plpgsql as $$
declare v_id uuid;
begin
  perform pg_temp.as_user('carol');
  insert into app.form_templates (org_id, name, description, record_kind, record_subtype, fields, requires_signature, requires_location, pass_score, approver_role_id)
  values (pg_temp.id('org_a'), p_key, 'For suppliers.', 'Inspection', 'Safety', p_fields, p_signature, p_location, case when p_key = 'check' then 2 end,
    case when p_approver then pg_temp.system_role('manager') end)
  returning id into v_id;
  if p_publish then
    perform pg_temp.as_user('dave');
    perform app.publish_form_template(v_id);
  end if;
  perform pg_temp.as_platform();
  perform pg_temp.put(p_key, v_id, null);
  return v_id;
end $$;

-- A link and a grant whose fill time has passed.
create function pg_temp.link(p_key text, p_template text, p_project uuid default null, p_daily integer default 200, p_max integer default null, p_one boolean default true) returns void
language plpgsql as $$
declare
  v record;
  v_grant text;
begin
  perform pg_temp.as_user('dave');
  select * into v from app.create_form_link(pg_temp.k(p_template), now() + interval '30 days', p_project, p_daily, p_max, p_one, 'Team note');
  perform pg_temp.put(p_key, v.form_link_id, v.token);
  perform pg_temp.put(p_key || ':code', null, v.access_code);
  perform pg_temp.anon();
  v_grant := api_public.open_form_link(v.token, v.access_code, '198.51.100.80') ->> 'grant';
  perform pg_temp.as_platform();
  perform pg_temp.put(p_key || ':grant', null, v_grant);
  update private.form_link_grants set issued_at = now() - interval '1 minute' where form_link_id = v.form_link_id;
end $$;

create function pg_temp.submit(p_key text, p_email text, p_answers jsonb, p_client text, p_website text default null) returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.anon();
  v := api_public.submit_public_form(pg_temp.v(p_key), pg_temp.v(p_key || ':grant'), 'Rae Ortiz', p_email, p_answers, p_website, p_client);
  perform pg_temp.as_platform();
  return v;
end $$;

select pg_temp.template('check', '[
  {"key": "ok", "label": "Harness checked", "kind": "yes_no", "required": true, "points": {"true": 2}},
  {"key": "why", "label": "Why not", "kind": "text", "required": true, "show_if": {"key": "ok", "equals": false}},
  {"key": "load", "label": "Load class", "kind": "choice", "choices": ["Light", "Heavy"], "points": {"Light": 1, "Heavy": 0}},
  {"key": "on", "label": "On", "kind": "date"}
]', true);
select pg_temp.template('photo_form', '[{"key": "p", "label": "Photo", "kind": "photo"}]');
select pg_temp.template('signed_form', '[{"key": "a", "label": "A", "kind": "text"}]', false, true);
select pg_temp.template('gps_form', '[{"key": "a", "label": "A", "kind": "text"}]', false, false, true);
select pg_temp.template('draft_form', '[{"key": "a", "label": "A", "kind": "text"}]', false, false, false, false);
select pg_temp.template('plain', '[{"key": "a", "label": "A", "kind": "text"}]');

-- Making ---------------------------------------------------------------------------------------------------------------
select is(pg_temp.try('frank', format($$select * from app.create_form_link(%L, now() + interval '30 days')$$, pg_temp.k('plain'))), '42501',
  'a member without knowledge.sop.publish makes no link');
select is(pg_temp.try('xavier', format($$select * from app.create_form_link(%L, now() + interval '30 days')$$, pg_temp.k('plain'))), '42501',
  'a member of another org makes no link');
select is(pg_temp.try('dave', format($$select * from app.create_form_link(%L, now() + interval '30 days')$$, pg_temp.k('draft_form'))), 'form_not_published',
  'a Draft form is refused');
select is(pg_temp.try('dave', format($$select * from app.create_form_link(%L, now() + interval '30 days')$$, pg_temp.k('photo_form'))), 'form_link_unsupported', 'a photo field is refused');
select is(pg_temp.try('dave', format($$select * from app.create_form_link(%L, now() + interval '30 days')$$, pg_temp.k('signed_form'))), 'form_link_unsupported', 'a signature is refused');
select is(pg_temp.try('dave', format($$select * from app.create_form_link(%L, now() + interval '30 days')$$, pg_temp.k('gps_form'))), 'form_link_unsupported', 'a GPS stamp is refused');
select is(pg_temp.try('dave', format($$select * from app.create_form_link(%L, now() + interval '91 days')$$, pg_temp.k('plain'))), 'form_link_expiry_range', 'an expiry past 90 days is refused');

select pg_temp.link('a', 'check', pg_temp.id('prj_a'));
select ok(pg_temp.v('a') ~ '^xfrm_[0-9a-f]{64}$' and pg_temp.v('a:code') ~ '^[0-9]{6}$' and pg_temp.v('a:grant') ~ '^xfrg_[0-9a-f]{64}$',
  'the token and a 6-digit code come back once, and the code earns a grant');
select is(pg_temp.try('dave', format($$select token_hash from app.form_links where id = %L$$, pg_temp.k('a'))), '42501',
  'inv_08_token_rpcs_hashed_secrets: signed-in callers cannot select the token hash');

-- Opening --------------------------------------------------------------------------------------------------------------
create function pg_temp.read_only(p_sql text) returns text
language plpgsql as $$
begin
  begin
    perform set_config('transaction_read_only', 'on', true);
    execute p_sql;
  exception when others then
    perform set_config('transaction_read_only', 'off', true);
    return sqlstate;
  end;
  perform set_config('transaction_read_only', 'off', true);
  return 'ran';
end $$;
select pg_temp.anon();
select is(pg_temp.read_only(format($$select api_public.open_form_link(%L, '000000', null)$$, pg_temp.v('a'))), '25006', 'a read-only open is refused');
select is(pg_temp.read_only(format($$select api_public.public_form(%L, %L, null)$$, pg_temp.v('a'), pg_temp.v('a:grant'))), '25006', 'a read-only read is refused');
select pg_temp.as_platform();

-- Reading --------------------------------------------------------------------------------------------------------------
select pg_temp.anon();
select pg_temp.put('read', null, api_public.public_form(pg_temp.v('a'), pg_temp.v('a:grant'), '198.51.100.80')::text);
select pg_temp.as_platform();
select is((select array_agg(x order by x) from jsonb_object_keys(pg_temp.v('read')::jsonb) x), array['description','fields','meta','name','status'], 'the read answers its key set');
select is((select array_agg(distinct x order by x) from jsonb_array_elements(pg_temp.v('read')::jsonb -> 'fields') f, jsonb_object_keys(f) x),
  array['choices','key','kind','label','required','show_if'], 'fields answer only key, label, kind, required, choices and show_if');
select ok(pg_temp.v('read') not like '%points%' and pg_temp.v('read') not like '%pass_score%' and pg_temp.v('read') not like '%Inspection%' and pg_temp.v('read') not like '%Team note%',
  'never points, the passing score, the record kind or the note');

-- Spam controls --------------------------------------------------------------------------------------------------------
select is(pg_temp.submit('a', 'one@guest.test', '{"ok": true}', '198.51.100.81', 'https://spam.test') ->> 'status', 'ok', 'a filled honeypot answers ok');
select is((select count(*)::int from app.form_submissions where form_link_id = pg_temp.k('a')), 0, 'and stores nothing');
-- now() is frozen in this transaction, so the grant is backdated above; a fresh grant is under 3 seconds old.
update private.form_link_grants set issued_at = now() where form_link_id = pg_temp.k('a');
select is(pg_temp.submit('a', 'one@guest.test', '{"ok": true}', '198.51.100.82') ->> 'reason', 'form_link_too_fast', 'a submit under 3 seconds after the grant is refused');
update private.form_link_grants set issued_at = now() - interval '1 minute' where form_link_id = pg_temp.k('a');

-- Answers: the same codes app.submit_form gives
select is(pg_temp.submit('a', 'one@guest.test', '{}', '198.51.100.83') ->> 'reason', 'form_answer_required', 'a required answer is required');
select is(pg_temp.submit('a', 'one@guest.test', '{"ok": true, "why": "No"}', '198.51.100.84') ->> 'reason', 'form_answer_hidden', 'a hidden field stays empty');
select is(pg_temp.submit('a', 'one@guest.test', '{"ok": true, "load": "Huge"}', '198.51.100.85') ->> 'reason', 'form_answer_choice', 'a choice must be listed');
select is(pg_temp.submit('a', 'one@guest.test', jsonb_build_object('ok', true, 'on', repeat('x', 33000)), '198.51.100.86') ->> 'reason', 'form_answers_too_large', 'answers over 32 KB are refused');

-- A response ------------------------------------------------------------------------------------------------------------
select is(pg_temp.submit('a', 'One@Guest.test', '{"ok": true, "load": "Light"}', '198.51.100.87') ->> 'status', 'ok', 'a valid response is filed');
select pg_temp.put('resp', (select s.id from app.form_submissions s where s.form_link_id = pg_temp.k('a')), null);
select is((select submission_state::text || '/' || coalesce(submitted_by_membership_id::text, 'no member') || '/' || respondent_name || '/' || respondent_email || '/' || score::text
  from app.form_submissions where id = pg_temp.k('resp')), 'Submitted/no member/Rae Ortiz/one@guest.test/3', 'stored Submitted with no member, the respondent''s name and lower-case email, and its score');
select is((select record_id from app.form_submissions where id = pg_temp.k('resp')), null, 'it creates no record');
select is((select count(*)::int from app.form_submission_state_transitions where form_submission_id = pg_temp.k('resp') and reason = 'Submitted via public link' and to_state = 'Submitted'), 1, 'the ledger says how it came');
select is(pg_temp.submit('a', 'one@guest.test', '{"ok": true}', '198.51.100.88') ->> 'reason', 'form_link_already_answered', 'one response per email');
select is(pg_temp.try('carol', format($$update app.form_submissions set respondent_email = 'x@y.test' where id = %L$$, pg_temp.k('resp'))), '42501',
  'a member cannot change a response''s submitter fields');
select throws_like(format($$update app.form_submissions set form_link_id = null, respondent_name = null, respondent_email = null, submitted_by_membership_id = %L where id = %L$$,
    (select m.id from app.memberships m where m.person_id = pg_temp.id('dave') and m.org_id = pg_temp.id('org_a')), pg_temp.k('resp')), 'form_submission_fixed:%', 'the guard refuses any later change to its submitter');

-- Deciding makes the record ---------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select lives_ok(format($$select app.decide_form_submission(%L, true)$$, pg_temp.k('resp')), 'a holder of the approver role approves');
select pg_temp.as_platform();
select is((select r.record_kind::text || '/' || r.record_subtype || '/' || r.project_id::text from app.records r join app.form_submissions s on s.record_id = r.id where s.id = pg_temp.k('resp')),
  'Inspection/Safety/' || pg_temp.id('prj_a')::text, 'approving makes the project record of the form''s kind and subtype');

-- The caps --------------------------------------------------------------------------------------------------------------
select pg_temp.link('capped', 'plain', null, 2, null, false);
select is(pg_temp.submit('capped', 'c1@guest.test', '{"a": "x"}', '198.51.100.90') ->> 'status', 'ok', 'the first in the window goes');
select is(pg_temp.submit('capped', 'c2@guest.test', '{"a": "x"}', '198.51.100.91') ->> 'status', 'ok', 'and the second');
select is(pg_temp.submit('capped', 'c3@guest.test', '{"a": "x"}', '198.51.100.92') ->> 'reason', 'form_link_rate_limited', 'past the cap in any 24 hours is refused');
alter table app.form_submissions disable trigger user;
update app.form_submissions set created_at = now() - interval '25 hours' where form_link_id = pg_temp.k('capped');
alter table app.form_submissions enable trigger user;
select is(pg_temp.submit('capped', 'c3@guest.test', '{"a": "x"}', '198.51.100.93') ->> 'status', 'ok', 'a response 25 hours old no longer counts');

select pg_temp.link('total', 'plain', null, 200, 1, false);
select is(pg_temp.submit('total', 't1@guest.test', '{"a": "x"}', '198.51.100.94') ->> 'status', 'ok', 'the only response allowed goes');
select is(pg_temp.submit('total', 't2@guest.test', '{"a": "x"}', '198.51.100.95') ->> 'reason', 'form_link_rate_limited', 'past max_responses is refused');

select pg_temp.link('addr', 'plain', null, 1000, null, false);
select pg_temp.submit('addr', 'x' || n || '@guest.test', '{"a": "x"}', '198.51.100.96') from generate_series(1, 10) n;
select is(pg_temp.submit('addr', 'x11@guest.test', '{"a": "x"}', '198.51.100.96') ->> 'reason', 'form_link_rate_limited', 'the 11th from one relayed address in an hour is refused');

-- A form no longer Published ---------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select app.retire_form_template(pg_temp.k('plain'), 'Replaced.');
select pg_temp.as_platform();
select pg_temp.anon();
select is(api_public.public_form(pg_temp.v('addr'), pg_temp.v('addr:grant'), '198.51.100.97') ->> 'reason', 'form_not_published', 'a form no longer Published is refused');
select pg_temp.as_platform();

-- app.submit_form is unchanged: same codes and scores as private.check_form_answers ---------------------------------------
select pg_temp.as_user('frank');
select pg_temp.put('member', app.submit_form(pg_temp.k('check'), '{"ok": true, "load": "Heavy"}'::jsonb, pg_temp.id('prj_a')), null);
select throws_like(format($$select app.submit_form(%L, '{}'::jsonb)$$, pg_temp.k('check')), 'form_answer_required:%', 'app.submit_form refuses with the same code');
select pg_temp.as_platform();
select is((select score::text || '/' || max_score::text || '/' || (submitted_by_membership_id is not null)::text from app.form_submissions where id = pg_temp.k('member')),
  ((select c.o_score::text || '/' || c.o_max::text || '/true' from private.check_form_answers(
    (select v.fields from app.form_template_versions v where v.form_template_id = pg_temp.k('check')), '{"ok": true, "load": "Heavy"}'::jsonb) c)),
  'a member''s submission scores what private.check_form_answers scores');

select * from finish();
rollback;

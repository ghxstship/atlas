-- pgTAP: migration 2604 (R1), one advance answer at a time. A token answer while the section's latest answer is pending
-- returns REFUSE advance_answer_pending, and so does one after it was Accepted; after it is Returned, the new answer is
-- stored. Preview carries review_outcome and return_reason. The signed-in path raises advance_answer_pending.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

create temporary table links (token text, code text);
grant select, insert on links to public;

select pg_temp.move_engagement('eng_art_a', 'Onboarding', 'Active');

select pg_temp.as_user('alice');
with p as (insert into app.advance_packets (project_id, title, due_at) values (pg_temp.id('prj_a'), 'Opening Night Advance', now() + interval '14 days') returning id)
  insert into world select 'packet', id from p;
with s as (insert into app.advance_sections (advance_packet_id, position, title, prompt) values (pg_temp.id('packet'), 1, 'Arrival', 'When does the party land?') returning id)
  insert into world select 'sec1', id from s;
with s as (insert into app.advance_sections (advance_packet_id, position, title) values (pg_temp.id('packet'), 2, 'Backline') returning id)
  insert into world select 'sec2', id from s;
with r as (insert into app.advance_recipients (advance_packet_id, person_id) values (pg_temp.id('packet'), pg_temp.id('mia')) returning id)
  insert into world select 'rcp_mia', id from r;
with r as (insert into app.advance_recipients (advance_packet_id, person_id) values (pg_temp.id('packet'), pg_temp.id('art')) returning id)
  insert into world select 'rcp_art', id from r;
select app.send_advance_packet(pg_temp.id('packet'));
insert into links select i.token, i.access_code from app.issue_advance_token(pg_temp.id('rcp_mia'), 'mia@northwind.test') i;
select pg_temp.as_platform();

create function pg_temp.submit(p_section text, p_body text) returns text
language sql as $$
  select coalesce(s.reason, 'stored')
  from links l, api_public.submit_advance(l.token, l.code, pg_temp.id(p_section), p_body) s;
$$;
create function pg_temp.review(p_section text, p_outcome text, p_reason text) returns void
language plpgsql as $$
begin
  perform pg_temp.as_user('alice');
  update app.advance_submissions x set reviewed_at = now(), reviewed_by = pg_temp.id('alice'), review_outcome = p_outcome::app.advance_review_outcome,
    return_reason = p_reason
  where x.id = (select y.id from app.advance_submissions y where y.advance_section_id = pg_temp.id(p_section) and y.advance_recipient_id = pg_temp.id('rcp_mia')
                order by y.submitted_at desc, y.id desc limit 1);
  perform pg_temp.as_platform();
end $$;

-- Token answers --------------------------------------------------------------------------------------------------------------
select pg_temp.as_anon();
select is(pg_temp.submit('sec1', 'Party of 6 lands at 14:20.'), 'stored', 'the first answer is stored');
select is(pg_temp.submit('sec1', 'Party of 7 lands at 14:20.'), 'advance_answer_pending', 'a second answer while the first is pending is refused');
select is((select refusal from links l, api_public.submit_advance(l.token, l.code, pg_temp.id('sec1'), 'Again.') s), 'REFUSE', 'as a REFUSE row');
select is(pg_temp.submit('sec2', 'Two wedges.'), 'stored', 'another section takes its own answer');
select pg_temp.as_platform();
select is((select count(*)::int from app.advance_submissions where advance_section_id = pg_temp.id('sec1')), 1, 'the refused answer is not stored');

select pg_temp.review('sec1', 'Returned', 'Please add the flight number.');
select pg_temp.as_anon();
select is((select review_outcome::text from links l, api_public.preview_advance(l.token, l.code) p where p.section_id = pg_temp.id('sec1')), 'Returned',
  'preview carries the review outcome');
select is((select return_reason from links l, api_public.preview_advance(l.token, l.code) p where p.section_id = pg_temp.id('sec1')), 'Please add the flight number.',
  'and the return reason');
select is(pg_temp.submit('sec1', 'Party of 6 lands at 14:20 on FA 212.'), 'stored', 'after Returned, the new answer is stored');
select is((select answer_body from links l, api_public.preview_advance(l.token, l.code) p where p.section_id = pg_temp.id('sec1')), 'Party of 6 lands at 14:20 on FA 212.',
  'the preview shows the new answer');
select ok((select review_outcome is null from links l, api_public.preview_advance(l.token, l.code) p where p.section_id = pg_temp.id('sec1')),
  'awaiting review again');
select pg_temp.as_platform();

select pg_temp.review('sec2', 'Accepted', null);
select pg_temp.as_anon();
select is(pg_temp.submit('sec2', 'Three wedges.'), 'advance_answer_pending', 'an answer after Accepted is refused');
select pg_temp.as_platform();

-- Signed-in answers ----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('art');
select lives_ok(format($$select app.submit_engaged_advance_answer(%L, %L, 'Lands at noon.')$$, pg_temp.id('rcp_art'), pg_temp.id('sec1')),
  'the artist answers through the signed-in path');
select throws_ok(format($$select app.submit_engaged_advance_answer(%L, %L, 'Lands at one.')$$, pg_temp.id('rcp_art'), pg_temp.id('sec1')),
  'XR001', 'advance_answer_pending: This section is answered; answer again only after it is returned.', 'the engaged path raises advance_answer_pending');
select pg_temp.as_user('alice');
update app.advance_submissions set reviewed_at = now(), reviewed_by = pg_temp.id('alice'), review_outcome = 'Returned', return_reason = 'Which airport?'
where advance_recipient_id = pg_temp.id('rcp_art') and advance_section_id = pg_temp.id('sec1');
select pg_temp.as_user('art');
select lives_ok(format($$select app.submit_engaged_advance_answer(%L, %L, 'Lands at noon at MIA.')$$, pg_temp.id('rcp_art'), pg_temp.id('sec1')),
  'and answers again once returned');
select pg_temp.as_platform();

select * from finish();
rollback;

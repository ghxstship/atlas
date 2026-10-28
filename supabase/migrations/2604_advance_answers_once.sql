-- 2604_advance_answers_once.sql
-- R1 Advancing wiring fixes (RRR-179, ADR 0100 to 0104). An advance section takes one answer at a time: a recipient
-- answers again only after the latest answer was Returned, so a second answer never lands on a reviewer while the
-- first is pending, and an Accepted answer stays the answer.
--
--   * api_public.submit_advance (from 0430) returns REFUSE advance_answer_pending after the length check.
--   * app.submit_engaged_advance_answer (from 0768) refuses advance_answer_pending.
-- api_public.preview_advance is unchanged; it already returns each section's review_outcome and return_reason.

-- Token answers -------------------------------------------------------------------------------------------------------

create or replace function api_public.submit_advance(p_token text, p_access_code text, p_section_id uuid, p_body text)
returns table (submission_id uuid, submitted_at timestamptz, refusal text, reason text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token_id uuid;
  v_reason text;
  v_recipient uuid;
  v_id uuid;
  v_at timestamptz;
  v_body text := btrim(coalesce(p_body, ''));
begin
  select r.token_id, r.reason into v_token_id, v_reason from private.resolve_advance_token(p_token, p_access_code) r;
  if v_reason is not null then
    return query select null::uuid, null::timestamptz, 'REFUSE'::text, v_reason;
    return;
  end if;
  select t.advance_recipient_id into v_recipient from app.advance_recipient_tokens t where t.id = v_token_id;
  if not exists (select 1 from app.advance_sections s join app.advance_recipients r on r.advance_packet_id = s.advance_packet_id
                 where s.id = p_section_id and s.deleted_at is null and r.id = v_recipient) then
    return query select null::uuid, null::timestamptz, 'REFUSE'::text, 'advance_section_open'::text;
    return;
  end if;
  if char_length(v_body) not between 1 and 20000 then
    return query select null::uuid, null::timestamptz, 'REFUSE'::text, 'advance_answer_length'::text;
    return;
  end if;
  -- One answer at a time: a section is answered again only after its latest answer was returned.
  if exists (
      select 1 from (
        select x.review_outcome from app.advance_submissions x
        where x.advance_section_id = p_section_id and x.advance_recipient_id = v_recipient and x.deleted_at is null
        order by x.submitted_at desc, x.id desc limit 1) a
      where a.review_outcome is null or a.review_outcome = 'Accepted') then
    return query select null::uuid, null::timestamptz, 'REFUSE'::text, 'advance_answer_pending'::text;
    return;
  end if;
  perform private.begin_trusted_operation('submit_advance');
  insert into app.advance_submissions (advance_section_id, advance_recipient_id, advance_recipient_token_id, body)
  values (p_section_id, v_recipient, v_token_id, v_body)
  returning id, advance_submissions.submitted_at into v_id, v_at;
  perform private.end_trusted_operation('submit_advance');
  update app.advance_recipient_tokens t set used_at = coalesce(t.used_at, v_at) where t.id = v_token_id;
  return query select v_id, v_at, null::text, null::text;
end;
$$;
comment on function api_public.submit_advance(text, text, uuid, text) is 'Gateway advance form without an account: with a valid token and access code, records the recipient''s answer to one section of the packet (1 to 20,000 characters), one answer at a time, and marks the link used. Refusals come back as REFUSE with a reason: the token reasons of preview_advance, advance_section_open, advance_answer_length, or advance_answer_pending while the section''s latest answer awaits review or was Accepted (R1).';
revoke all on function api_public.submit_advance(text, text, uuid, text) from public;
grant execute on function api_public.submit_advance(text, text, uuid, text) to anon, authenticated, service_role;

-- Signed-in answers ---------------------------------------------------------------------------------------------------

create or replace function app.submit_engaged_advance_answer(p_recipient_id uuid, p_section_id uuid, p_body text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_recipient app.advance_recipients;
  v_project uuid;
  v_id uuid;
begin
  perform private.require_person();
  select r.* into v_recipient from app.advance_recipients r where r.id = p_recipient_id and r.deleted_at is null;
  select p.project_id into v_project from app.advance_packets p where p.id = v_recipient.advance_packet_id;
  if v_recipient.id is null or not private.advance_recipient_open(v_project, v_recipient.person_id, v_recipient.counterparty_id) then
    raise exception using errcode = '42501', message = 'only the recipient side answers this packet';
  end if;
  if exists (
      select 1 from (
        select x.review_outcome from app.advance_submissions x
        where x.advance_section_id = p_section_id and x.advance_recipient_id = p_recipient_id and x.deleted_at is null
        order by x.submitted_at desc, x.id desc limit 1) a
      where a.review_outcome is null or a.review_outcome = 'Accepted') then
    perform private.refuse('advance_answer_pending', 'This section is answered; answer again only after it is returned.');
  end if;
  insert into app.advance_submissions (advance_section_id, advance_recipient_id, body)
  values (p_section_id, p_recipient_id, p_body) returning id into v_id;
  return v_id;
end;
$$;

comment on function app.submit_engaged_advance_answer(uuid, uuid, text) is 'A signed-in recipient (the person, their Advance representative, or the recipient account) answers a section of a sent packet while the engagement''s onboarding or operational area is open. A10''s guards apply: same packet, sent, arrives unreviewed. A section whose latest answer awaits review or was Accepted is refused with advance_answer_pending until the answer is returned (R1). Returns the answer id.';
revoke all on function app.submit_engaged_advance_answer(uuid, uuid, text) from public, anon;
grant execute on function app.submit_engaged_advance_answer(uuid, uuid, text) to authenticated, service_role;

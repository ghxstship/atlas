-- 2715_guest_list_caps.sql
-- R9 Guest list caps (RRR-189; owner decision 7). A party asks for guests only while the org offers it a guest list,
-- and never beyond the engagement's cap counted with plus-ones:
--
--   * private.assert_guest_capacity(p_engagement_id, p_plus_ones) reads R3's resolver: offering_not_offered while the
--     Guest List offering is Not Offered; guest_list_cap when the live, non-Declined guests of the engagement, each
--     counted with its plus-ones, and this one would go beyond cap_per_engagement.
--   * app.request_engaged_guest (from 0965) calls it before it inserts, under a lock on the engagement so two requests
--     cannot both take the last place.

create or replace function private.assert_guest_capacity(p_engagement_id uuid, p_plus_ones integer)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_offer record;
  v_used integer;
begin
  select o.offering_mode, o.cap_per_engagement into v_offer
  from private.effective_offerings(p_engagement_id) o where o.offering = 'Guest List';
  if coalesce(v_offer.offering_mode, 'Not Offered') = 'Not Offered' then
    perform private.refuse('offering_not_offered', 'A guest list is not offered on this engagement''s project.');
  end if;
  if v_offer.cap_per_engagement is null then
    return;
  end if;
  perform 1 from app.engagements e where e.id = p_engagement_id for update;
  select coalesce(sum(1 + g.plus_ones), 0) into v_used
  from app.guest_list_entries g
  where g.engagement_id = p_engagement_id and g.deleted_at is null and g.entry_state <> 'Declined';
  if v_used + 1 + coalesce(p_plus_ones, 0) > v_offer.cap_per_engagement then
    perform private.refuse('guest_list_cap', format('This engagement may bring %s guests, plus-ones included; %s are on the list.',
      v_offer.cap_per_engagement, v_used));
  end if;
end;
$$;
comment on function private.assert_guest_capacity(uuid, integer) is 'R9: a guest request on an engagement needs the Guest List offering (R3''s private.effective_offerings) to be offered (offering_not_offered), and the live guests that were not Declined, each with its plus-ones, plus this guest and its plus-ones, to stay within cap_per_engagement (guest_list_cap). Locks the engagement row while it counts.';
revoke all on function private.assert_guest_capacity(uuid, integer) from public, anon, authenticated;

create or replace function app.request_engaged_guest(
  p_engagement_id uuid,
  p_guest_name text,
  p_plus_ones integer default 0,
  p_note text default null,
  p_scope_node_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
  v_id uuid;
begin
  select * into v_engagement from app.engagements e where e.id = p_engagement_id and e.deleted_at is null;
  if v_engagement.id is null or not private.guest_party_open(v_engagement.project_id, v_engagement.person_id, v_engagement.counterparty_id) then
    raise exception using errcode = '42501', message = 'engagement not found';
  end if;
  perform private.assert_guest_capacity(v_engagement.id, coalesce(p_plus_ones, 0));
  perform private.begin_trusted_operation('request_engaged_guest');
  insert into app.guest_list_entries (project_id, scope_node_id, person_id, counterparty_id, engagement_id, guest_name, plus_ones, note)
  values (v_engagement.project_id, p_scope_node_id,
          v_engagement.person_id, case when v_engagement.person_id is null then v_engagement.counterparty_id end,
          v_engagement.id, btrim(coalesce(p_guest_name, '')), coalesce(p_plus_ones, 0), nullif(btrim(p_note), ''))
  returning id into v_id;
  perform private.end_trusted_operation('request_engaged_guest');
  return v_id;
end;
$$;
comment on function app.request_engaged_guest(uuid, text, integer, text, uuid) is 'Gateway Guest List: the engaged person, their Advance representative or the engaged account requests a guest (Requested) on the engagement''s project while its operational area is open, while the Guest List offering is offered (offering_not_offered) and within the engagement''s cap counted with plus-ones (guest_list_cap, R9). The production approves or declines in Atlas. Returns the entry id.';
revoke all on function app.request_engaged_guest(uuid, text, integer, text, uuid) from public, anon;
grant execute on function app.request_engaged_guest(uuid, text, integer, text, uuid) to authenticated, service_role;

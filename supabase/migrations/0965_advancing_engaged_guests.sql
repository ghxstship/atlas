-- 0965_advancing_engaged_guests.sql
-- A10 Advancing late slot (ADR 0022: 0965 to 0969), after A28's engagements (0700):
--   * app.guest_list_entries.engagement_id: the engagement a guest was requested under, so an engaged artist
--     (or their Advance representative, or the account) sees and adds to their own list in Gateway
--   * app.request_engaged_guest and app.engaged_guest_list: the signed-in party's half of the guest list,
--     open while the engagement's operational area is open (Section 8.7). Decisions stay internal.
--   * comments and attachments on riders, answers, reconciliations and guest list entries
--     (private.comment_subjects, A18 0580); advance packets were registered by 0580 itself.

alter table app.guest_list_entries add column engagement_id uuid references app.engagements (id);
create index guest_list_entries_engagement_id_idx on app.guest_list_entries (engagement_id);
comment on column app.guest_list_entries.engagement_id is 'Engagement the guest was requested under, on the same project and party; NULL for guests the production adds itself.';

create or replace function private.guard_guest_list_engagement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.engagement_id is not null and not exists (
    select 1 from app.engagements e
    where e.id = new.engagement_id and e.project_id = new.project_id
      and ((new.person_id is not null and e.person_id = new.person_id)
        or (new.person_id is null and new.counterparty_id is not null and e.counterparty_id = new.counterparty_id))) then
    perform private.refuse('guest_entry_engagement', 'A guest requested under an engagement is on that engagement''s project and party list.');
  end if;
  if tg_op = 'UPDATE' and new.engagement_id is distinct from old.engagement_id then
    perform private.refuse('guest_entry_engagement', 'A guest stays on the engagement it was requested under.');
  end if;
  return new;
end;
$$;
comment on function private.guard_guest_list_engagement() is 'A guest requested under an engagement belongs to that engagement''s project and party, and never moves to another engagement.';
revoke all on function private.guard_guest_list_engagement() from public, anon, authenticated;
create trigger t41_guard_guest_list_engagement before insert or update on app.guest_list_entries
  for each row execute function private.guard_guest_list_engagement();

-- Takes column values (ADR 0016 item 14): the engagement's project, person and counterparty.
create or replace function private.guest_party_open(p_project_id uuid, p_person_id uuid, p_counterparty_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.person_party_open(p_project_id, p_person_id, array['operational'])
    or (p_counterparty_id is not null and private.counterparty_area_open(p_project_id, p_counterparty_id, 'operational',
      array['Account Owner', 'Account Admin', 'Account Member']::app.account_role[]));
$$;
comment on function private.guest_party_open(uuid, uuid, uuid) is 'Section 8.7: true when the signed-in person keeps a guest list for an engagement: the engaged person or their Advance representative, or the engaged account, while the operational area is open.';
revoke all on function private.guest_party_open(uuid, uuid, uuid) from public, anon;
grant execute on function private.guest_party_open(uuid, uuid, uuid) to authenticated, service_role;

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
comment on function app.request_engaged_guest(uuid, text, integer, text, uuid) is 'Gateway Artist tab Guest List: the engaged person, their Advance representative or the engaged account requests a guest (Requested) on the engagement''s project while its operational area is open. The production approves or declines in Atlas. Returns the entry id.';
revoke all on function app.request_engaged_guest(uuid, text, integer, text, uuid) from public, anon;
grant execute on function app.request_engaged_guest(uuid, text, integer, text, uuid) to authenticated, service_role;

create or replace function app.engaged_guest_list(p_engagement_id uuid)
returns table (
  id uuid,
  scope_node_id uuid,
  guest_name text,
  plus_ones smallint,
  note text,
  entry_state app.guest_entry_state,
  checked_in_at timestamptz,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
begin
  select * into v_engagement from app.engagements e where e.id = p_engagement_id and e.deleted_at is null;
  if v_engagement.id is null or not private.guest_party_open(v_engagement.project_id, v_engagement.person_id, v_engagement.counterparty_id) then
    raise exception using errcode = '42501', message = 'engagement not found';
  end if;
  return query
    select g.id, g.scope_node_id, g.guest_name, g.plus_ones, g.note, g.entry_state, g.checked_in_at, g.created_at
    from app.guest_list_entries g
    where g.engagement_id = p_engagement_id and g.deleted_at is null
    order by g.created_at;
end;
$$;
comment on function app.engaged_guest_list(uuid) is 'The guest list of an engagement for its party (Section 8.7): each guest with plus-ones, state and check-in time, oldest first. Who decided never appears.';
revoke all on function app.engaged_guest_list(uuid) from public, anon;
grant execute on function app.engaged_guest_list(uuid) to authenticated, service_role;

-- Comments and attachments ------------------------------------------------------------------------------------

insert into private.comment_subjects (table_name) values
  ('app.advance_submissions'),
  ('app.riders'),
  ('app.reconciliations'),
  ('app.guest_list_entries')
on conflict (table_name) do nothing;

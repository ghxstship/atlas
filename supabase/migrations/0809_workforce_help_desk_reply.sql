-- 0809_workforce_help_desk_reply.sql
-- A29 Workforce Suite: the requester of a help desk request replies through the same RPC as its team
-- (0805 refused the requester before reaching its own reply branch). A requester's reply goes through
-- A31's app.post_support_message, which also hands a Waiting request back to the team.

create or replace function app.answer_help_desk_request(p_ticket_id uuid, p_body text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ticket app.support_tickets;
  v_mine uuid;
  v_id uuid;
begin
  perform private.require_person();
  select * into v_ticket from app.support_tickets t where t.id = p_ticket_id and t.deleted_at is null;
  if v_ticket.id is null or v_ticket.help_desk_team_id is null then
    raise exception using errcode = '42501', message = 'the request does not exist or you do not answer it';
  end if;
  v_mine := private.my_membership_in(v_ticket.org_id);
  if v_mine is not null and v_mine = v_ticket.membership_id then
    return app.post_support_message(p_ticket_id, p_body);
  end if;
  if not private.can_answer_help_desk_request(v_ticket.org_id, v_ticket.help_desk_team_id) then
    raise exception using errcode = '42501', message = 'the request does not exist or you do not answer it';
  end if;
  if v_ticket.ticket_state = 'Closed' then
    perform private.refuse('support_ticket_closed', 'A closed ticket takes no more messages; open a new ticket.');
  end if;
  insert into app.support_ticket_messages (support_ticket_id, author_membership_id, body) values (p_ticket_id, v_mine, btrim(p_body))
  returning id into v_id;
  if v_ticket.first_responded_at is null then
    update app.support_tickets set first_responded_at = now() where id = p_ticket_id;
    perform private.emit_event(v_ticket.org_id, 'support_ticket.answered', 'support_tickets', p_ticket_id, null,
      jsonb_build_object('ticket_number', v_ticket.ticket_number, 'queue', v_ticket.queue, 'help_desk_team_id', v_ticket.help_desk_team_id));
  end if;
  return v_id;
end;
$$;

comment on function app.answer_help_desk_request(uuid, text) is 'Writes on a help desk request: the requester replies (through app.post_support_message, which reopens a Waiting request), a member of its team or an org.help.write holder answers, and the first answer records the response time. Returns the message id.';
revoke all on function app.answer_help_desk_request(uuid, text) from public, anon;
grant execute on function app.answer_help_desk_request(uuid, text) to authenticated, service_role;

-- 1356_step_up_second_factor.sql
-- A79 (RRR-124): the step-up seam of 1351 becomes A77's one step-up check (1333). private.require_step_up, which
-- org deletion and both sides of an ownership transfer call, now runs private.require_second_factor: an API key is
-- refused (step_up_session_only), and a session must be aal2 with a second factor passed within
-- private.reverify_window() (15 minutes) or it is refused step_up_required. 1351 checked aal2 only.

create or replace function private.require_step_up(p_action text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_second_factor(p_action);
end;
$$;

comment on function private.require_step_up(text) is 'Step-up for the org lifecycle (Section 9, Section 14.7): A77''s check, private.require_second_factor, with recency. Refuses step_up_session_only for an API key and step_up_required unless the session passed a second factor within private.reverify_window(). p_action names the action in the refusal, for example "delete the organization".';
revoke all on function private.require_step_up(text) from public, anon, authenticated;

-- Migration 1333: the one step-up check (A77, RRR-122; Section 9 "step-up authentication", Section 14.7).
--
-- Every function that needs the caller to have passed a second factor calls private.require_second_factor, so the rule
-- lives in one place and Atlas answers its refusal the same way everywhere (the step-up dialog, then a retry):
--   * an API-key session is refused step_up_session_only: a key has no person to verify;
--   * p_recent true (the default, for actions that change who holds the org or how a person signs in) asks for a second
--     factor within private.reverify_window() (15 minutes) on an aal2 session;
--   * p_recent false asks only for an aal2 session, the step-up Restricted exports and break-glass use (A69's 1298
--     keeps break-glass to the whole hour).
-- A79's private.require_step_up (org deletion, ownership transfer) delegates here; its Atlas seam requireStepUp
-- delegates to requireSecondFactor in @xos/data/auth-assurance, which reads app.my_second_factor_status() by the same
-- rule.

create or replace function private.require_second_factor(p_action text, p_recent boolean default true)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if private.api_key_scopes() is not null then
    perform private.refuse('step_up_session_only', format('%s needs a signed-in session, never an API key.', p_action));
  end if;
  if private.session_aal() is distinct from 'aal2'
     or (p_recent and coalesce(private.second_factor_at() > now() - private.reverify_window(), false) is false) then
    perform private.refuse('step_up_required', format('Confirm it is you with your second factor to %s.', p_action));
  end if;
end;
$$;

comment on function private.require_second_factor(text, boolean) is 'The one step-up check (A77): refuses step_up_session_only for an API key and step_up_required unless the session is aal2 and, when p_recent (the default), passed a second factor within private.reverify_window(). p_action names the action in the refusal, for example "delete the organization".';
revoke all on function private.require_second_factor(text, boolean) from public, anon, authenticated;

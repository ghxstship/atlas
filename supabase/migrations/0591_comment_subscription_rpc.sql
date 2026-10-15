-- 0591_comment_subscription_rpc.sql
-- A18 Platform Services. app.set_thread_subscription: follows or mutes a comment thread for the caller in one
-- call, for the @xos/data comments repository. Runs as the caller, so the thread_subscriptions policy (the
-- caller's own row on a thread they can read) decides; it references only app and auth objects.

create or replace function app.set_thread_subscription(p_comment_thread_id uuid, p_subscribed boolean)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_person uuid := (select p.id from app.people p where p.user_id = (select auth.uid()) and p.deleted_at is null);
begin
  if v_person is null then
    raise exception using errcode = '42501', message = 'a signed-in person is required';
  end if;
  update app.thread_subscriptions set subscribed = p_subscribed
  where comment_thread_id = p_comment_thread_id and person_id = v_person and deleted_at is null;
  if not found then
    insert into app.thread_subscriptions (comment_thread_id, person_id, subscribed) values (p_comment_thread_id, v_person, p_subscribed);
  end if;
end;
$$;

comment on function app.set_thread_subscription(uuid, boolean) is 'Follows (true) or mutes (false) a thread the caller can read, creating their subscription on first use. Runs as the caller.';

revoke all on function app.set_thread_subscription(uuid, boolean) from public, anon;
grant execute on function app.set_thread_subscription(uuid, boolean) to authenticated, service_role;

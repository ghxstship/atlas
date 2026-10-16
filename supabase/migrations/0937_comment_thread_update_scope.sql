-- Security finding A22-003: anyone who could read a thread's subject could update the thread, so a
-- Viewer could resolve, or move to Trash, a discussion someone else opened and hide it from every
-- member.
--
-- Fix: a thread is updated (resolved, reopened, moved to Trash) only by a person who can read its
-- subject and who either opened it, took part in it (authored a comment), or manages the org's
-- members. Reading and posting are unchanged.

create or replace function private.may_update_comment_thread(p_thread_id uuid, p_org_id uuid, p_created_by uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_created_by = private.current_person_id()
    or exists (select 1 from app.comments c
               where c.comment_thread_id = p_thread_id
                 and c.author_person_id = private.current_person_id()
                 and c.deleted_at is null)
    or private.has_capability(p_org_id, 'org.members.manage');
$$;

comment on function private.may_update_comment_thread(uuid, uuid, uuid) is 'Whether the current person may resolve, reopen or trash a comment thread: its opener, a participant, or an org member manager (A22-003). Column values are passed in, per the ADR 0016 policy helper rule.';
revoke all on function private.may_update_comment_thread(uuid, uuid, uuid) from public, anon;
grant execute on function private.may_update_comment_thread(uuid, uuid, uuid) to authenticated;

drop policy comment_threads_update on app.comment_threads;
create policy comment_threads_update on app.comment_threads
  for update to authenticated
  using (private.can_read_subject(subject_table, subject_id)
         and private.may_update_comment_thread(id, org_id, created_by))
  with check (private.can_read_subject(subject_table, subject_id)
              and private.may_update_comment_thread(id, org_id, created_by));

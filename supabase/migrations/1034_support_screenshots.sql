-- 1034_support_screenshots.sql
-- A33 Platform workflow (RRR-77), for A31's support flow (Section 11.16, 0643). Screenshots a
-- requester chooses to attach as diagnostics live in a private bucket:
--   * support-screenshots, private, images only, 5 MB. Object names are <person_id>/<file name>, the
--     uploader's own person id first.
--   * Only the uploader reads or uploads under their own folder; the platform's support staff read
--     through the service role, which bypasses row level security. Nobody updates or deletes through
--     the API: a retake is a new object, and objects leave with the diagnostics' retention.
--   * A ticket's diagnostics may name only a screenshot under the requester's own folder, so a
--     request never points staff at someone else's file.
--   * 0643's screenshot_path check used the repetition {0,499}, above the regular expression limit
--     of 255, so every diagnostics row with a screenshot failed with 2201B. It is replaced by the same
--     rule written as a pattern plus a length.
-- The storage helpers take the object name as a value and never re-read storage.objects (ADR 0016
-- rule 14).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('support-screenshots', 'support-screenshots', false, 5242880, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

alter table app.support_ticket_diagnostics drop constraint support_ticket_diagnostics_screenshot_path;
alter table app.support_ticket_diagnostics add constraint support_ticket_diagnostics_screenshot_path
  check (screenshot_path is null or (screenshot_path ~ '^[a-z0-9][a-z0-9/_.-]*$' and char_length(screenshot_path) <= 500));

create or replace function private.support_screenshot_owner(p_object_name text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_parts text[] := string_to_array(p_object_name, '/');
begin
  if coalesce(array_length(v_parts, 1), 0) <> 2 or v_parts[2] !~ '^[a-z0-9][a-z0-9_.-]{0,199}$' then
    return null;
  end if;
  return v_parts[1]::uuid;
exception when invalid_text_representation then
  return null;
end;
$$;

comment on function private.support_screenshot_owner(text) is 'Person id that owns a support-screenshots object (<person_id>/<file name>, lowercase file name), or NULL for any other name.';
revoke all on function private.support_screenshot_owner(text) from public, anon;
grant execute on function private.support_screenshot_owner(text) to authenticated, service_role;

create policy support_screenshots_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'support-screenshots'
    and private.support_screenshot_owner(name) = (select private.current_person_id()));
create policy support_screenshots_read on storage.objects for select to authenticated
  using (bucket_id = 'support-screenshots'
    and private.support_screenshot_owner(name) = (select private.current_person_id()));

create or replace function private.guard_support_screenshot_path()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_requester uuid;
begin
  if new.screenshot_path is null then
    return new;
  end if;
  select m.person_id into v_requester
  from app.support_tickets t join app.memberships m on m.id = t.membership_id
  where t.id = new.support_ticket_id;
  if private.support_screenshot_owner(new.screenshot_path) is distinct from v_requester then
    perform private.refuse('support_screenshot_owner', 'A screenshot is attached only from the requester''s own uploads.');
  end if;
  return new;
end;
$$;

comment on function private.guard_support_screenshot_path() is 'Diagnostics name a screenshot only under the requester''s own support-screenshots folder (A33).';
revoke all on function private.guard_support_screenshot_path() from public, anon, authenticated;

create trigger t42_guard_support_screenshot_path before insert on app.support_ticket_diagnostics
  for each row execute function private.guard_support_screenshot_path();

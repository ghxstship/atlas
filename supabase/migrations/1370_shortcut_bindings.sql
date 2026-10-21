-- 1370_shortcut_bindings.sql
-- A81 navigation and keyboard (RRR-126, finding A65-007; Section 3.15, Section 7.3 `shortcut_bindings`, Section 11.7).
-- People rebind keyboard shortcuts in Personal settings, Keyboard Shortcuts:
--   * app.shortcut_bindings: at most one live row per person, shell and shortcut, holding the keys the person chose in
--     place of the default in the shortcut registry (packages/schemas/shortcuts.yaml). The row belongs to the person,
--     never an org, so their keys follow them into every org, as personal settings do (Section 4.5.6).
--   * keys NULL turns off a shortcut that has default keys. Resetting removes the row (soft delete) and the default
--     applies again.
--   * The registry is the single source of shortcuts, scopes and reserved keys, so the database checks only the shape
--     of an id and of the keys. The server action refuses unknown and fixed shortcuts, reserved browser and screen
--     reader keys, and keys that conflict where scopes meet (bindingProblem in @xos/schemas/shortcuts) before it
--     calls app.set_shortcut_binding, and the shell ignores any stored binding that breaks those rules.
--   * At most 200 live bindings per person and shell; the registry has far fewer shortcuts.

create type app.shortcut_shell as enum ('Atlas', 'Gateway');
comment on type app.shortcut_shell is 'Web shell whose keyboard shortcut a personal binding changes (Section 11.7).';

create table app.shortcut_bindings (
  id uuid primary key default private.uuid_v7(),
  person_id uuid not null references app.people (id),
  shell app.shortcut_shell not null,
  shortcut_id text not null,
  keys text,
  constraint shortcut_bindings_shortcut_id check (
    shortcut_id ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$' and char_length(shortcut_id) <= 60),
  constraint shortcut_bindings_keys check (
    keys is null or (char_length(keys) between 1 and 40 and keys ~ '^[!-~]+( [!-~]+)?$'))
);

call private.install_person_table('app.shortcut_bindings');
create unique index shortcut_bindings_live_key on app.shortcut_bindings (person_id, shell, shortcut_id)
  where deleted_at is null;

call private.describe('app.shortcut_bindings', 'Keyboard shortcuts a person rebound in Personal settings (Section 11.7). One live row per person, shell and shortcut overrides the registry default (packages/schemas/shortcuts.yaml); the person''s keys apply in every org. Read and written only by the person.', array[
  'id', 'Primary key, UUID v7.',
  'person_id', 'Person whose shortcut this is, from the session.',
  'shell', 'Atlas or Gateway.',
  'shortcut_id', 'Shortcut id in the registry, for example go.home or create-menu.',
  'keys', 'Keys the person chose, in the registry''s key grammar (for example G H or Mod+Shift+K); NULL turns the shortcut off.'
]);

-- Rebound shortcuts that were reset are personal data with no further use.
call private.install_default_retention('app.shortcut_bindings', interval '90 days');

create or replace function private.guard_shortcut_binding()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.shell <> old.shell or new.shortcut_id <> old.shortcut_id then
      perform private.refuse('shortcut_binding_immutable', 'A binding keeps its shortcut; reset it and bind the other shortcut.');
    end if;
    if old.deleted_at is not null and new.deleted_at is null then
      perform private.refuse('shortcut_binding_immutable', 'Bind the shortcut again instead of restoring a reset binding.');
    end if;
    return new;
  end if;
  new.person_id := coalesce(private.current_person_id(), new.person_id);
  if new.person_id is null then
    perform private.refuse('shortcut_binding_person', 'Sign in to change your keyboard shortcuts.');
  end if;
  if (select count(*) from app.shortcut_bindings b
      where b.person_id = new.person_id and b.shell = new.shell and b.deleted_at is null) >= 200 then
    perform private.refuse('shortcut_bindings_limit', 'You can rebind at most 200 shortcuts in a shell; reset one first.');
  end if;
  return new;
end;
$$;

comment on function private.guard_shortcut_binding() is 'Shortcut bindings: a new binding belongs to the session person; a binding never moves to another shell or shortcut, a reset binding stays reset, and a person keeps at most 200 live bindings per shell.';
revoke all on function private.guard_shortcut_binding() from public, anon, authenticated;

create trigger t40_guard_shortcut_binding before insert or update on app.shortcut_bindings
  for each row execute function private.guard_shortcut_binding();

-- Writing -------------------------------------------------------------------------------------------------------------
-- Both functions run with the caller's rights, so the owner policies of install_person_table decide every row: the
-- guard gives a new binding to the session person, and an update reaches only the caller's own rows.

create or replace function app.set_shortcut_binding(p_shell app.shortcut_shell, p_shortcut_id text, p_keys text)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into app.shortcut_bindings (shell, shortcut_id, keys)
  values (p_shell, p_shortcut_id, nullif(btrim(p_keys), ''))
  on conflict (person_id, shell, shortcut_id) where deleted_at is null
  do update set keys = excluded.keys
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.set_shortcut_binding(app.shortcut_shell, text, text) is 'Binds one of the signed-in person''s shortcuts in a shell to new keys (NULL or blank turns it off), replacing any binding they had for it. The app checks the keys against the shortcut registry first. Returns the binding id.';
revoke all on function app.set_shortcut_binding(app.shortcut_shell, text, text) from public, anon;
grant execute on function app.set_shortcut_binding(app.shortcut_shell, text, text) to authenticated;

create or replace function app.reset_shortcut_bindings(p_shell app.shortcut_shell, p_shortcut_id text default null)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  update app.shortcut_bindings b set deleted_at = now()
  where b.shell = p_shell and b.deleted_at is null
    and (p_shortcut_id is null or b.shortcut_id = p_shortcut_id);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function app.reset_shortcut_bindings(app.shortcut_shell, text) is 'Returns one of the signed-in person''s shortcuts in a shell to its default keys, or every one when p_shortcut_id is NULL. Returns how many bindings were reset.';
revoke all on function app.reset_shortcut_bindings(app.shortcut_shell, text) from public, anon;
grant execute on function app.reset_shortcut_bindings(app.shortcut_shell, text) to authenticated;

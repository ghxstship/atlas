-- 2061_field_history_events.sql
--
-- A106 (RRR-151, ADR 0044; follow-up of A88). app.field_history (1452) answers one row per changed field, while its
-- p_limit counts events: an update that changed five fields is five rows. PostgREST caps every RPC answer at max_rows
-- (1000, locally and on hosted projects) and drops the rest without an error, so a long or busy history arrived with
-- its oldest events missing, or with the last one holding only some of its changes, and nothing said so.
--
--   * app.field_history_events answers one row per event, its changed fields as a jsonb array, so p_limit and max_rows
--     count the same thing. p_limit is clamped to 1 to 1000 as in 1452, so a whole page always fits under max_rows.
--   * It reads app.field_history and only groups its rows, so the access rules stay in one place: the caller must be
--     able to read the row (42501 otherwise), a table outside the registry is refused, and a Restricted field arrives
--     masked with neither value. Security invoker: it needs nothing app.field_history does not already grant.
--   * app.field_history is unchanged.

create function app.field_history_events(p_subject_table text, p_subject_id uuid, p_limit integer default 200)
returns table (
  event_id uuid,
  changed_at timestamptz,
  actor_person_id uuid,
  actor_name text,
  operation text,
  changes jsonb
)
language sql
stable
security invoker
set search_path = ''
as $$
  select h.event_id, h.changed_at, h.actor_person_id, h.actor_name, h.operation,
         coalesce(
           jsonb_agg(
             jsonb_build_object('field', h.field, 'old_value', h.old_value, 'new_value', h.new_value, 'masked', h.masked)
             order by h.field
           ) filter (where h.field is not null),
           '[]'::jsonb
         )
  from app.field_history(p_subject_table, p_subject_id, p_limit) h
  group by h.event_id, h.changed_at, h.actor_person_id, h.actor_name, h.operation
  order by h.changed_at desc, h.event_id desc;
$$;

comment on function app.field_history_events(text, uuid, integer) is 'Field history of one row (Section 4.10), one row per event, newest first: who acted, when, the operation, and the changed fields as a jsonb array of {field, old_value, new_value, masked}, empty for a creation or deletion. p_limit (1 to 1000, 200 by default) counts events, so a page is never cut short by the API''s row cap. Reads app.field_history, so the same rules apply: only for someone who can read the row, and a Restricted field is masked without its read capability.';

revoke all on function app.field_history_events(text, uuid, integer) from public, anon;
grant execute on function app.field_history_events(text, uuid, integer) to authenticated, service_role;

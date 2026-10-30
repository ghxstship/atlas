-- 2792_cue_standby_and_curfew.sql
-- P2 Run of show and show calling (RRR-216, ADR 0131 decisions 2 and 5; gap G-75). The showcaller puts the next cue on
-- standby before calling it, and the console weighs the projected end against a hard stop.
--
--   * app.run_of_show.curfew_at: the hard stop (the noise curfew), an input. The show clock, overrun, projected end and
--     curfew risk are computed from the cues (ADR 0103), never stored.
--   * app.cues.standby_at, with cues_standby_key: at most one uncalled cue per running order is on standby. Skipped
--     cues are computed (uncalled cues before the latest called position), not stored.
--   * private.guard_cue, from its latest definition (0412) verbatim, adds: putting a cue on standby needs show.cue.call
--     on the project, never applies to a called cue, and is stamped with the database time. Clearing it needs only the
--     row's update policy.
--   * app.standby_cue moves the standby in one transaction: it clears the run's other standby, then sets the new one.
-- No foreign key, array or counted column is added, so the ADR 0068 registers need no entry (pgTAP 1282). No column here
-- names a row, so no table becomes eligible for Trash (ADR 0110).

alter table app.run_of_show add column curfew_at timestamptz;
comment on column app.run_of_show.curfew_at is 'Hard stop of the show (for example the noise curfew); the console warns when the projected end nears or passes it.';

alter table app.cues add column standby_at timestamptz;
comment on column app.cues.standby_at is 'When the caller put this cue on standby; the standby cue is the uncalled cue with a standby time.';

create unique index cues_standby_key on app.cues (run_of_show_id)
  where standby_at is not null and called_at is null and deleted_at is null;

-- The guard learns standby --------------------------------------------------------------------------------------------

create or replace function private.guard_cue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.run_of_show_id <> old.run_of_show_id then
    perform private.refuse('cue_run_of_show_immutable', 'A cue stays in its running order.');
  end if;
  if new.standby_at is not null and (tg_op = 'INSERT' or old.standby_at is distinct from new.standby_at) then
    if new.called_at is not null or (tg_op = 'UPDATE' and old.called_at is not null) then
      perform private.refuse('cue_standby_called', 'A called cue cannot go on standby.');
    end if;
    if auth.uid() is not null
       and not private.can_on_project((select r.project_id from app.run_of_show r where r.id = new.run_of_show_id), 'show.cue.call') then
      perform private.refuse('cue_standby_capability', 'Only a person who may call cues on the project puts a cue on standby.');
    end if;
    new.standby_at := now();
  end if;
  if new.called_at is not null and (tg_op = 'INSERT' or old.called_at is null) then
    if auth.uid() is not null
       and not private.can_on_project((select r.project_id from app.run_of_show r where r.id = new.run_of_show_id), 'show.cue.call') then
      perform private.refuse('cue_call_capability', 'Only a person who may call cues on the project calls a cue.');
    end if;
    new.called_at := now();
    new.called_by := private.current_person_id();
  elsif tg_op = 'UPDATE' and old.called_at is not null then
    new.called_at := old.called_at;
    new.called_by := old.called_by;
  end if;
  return new;
end;
$$;

comment on function private.guard_cue() is 'Cues stay in their running order; a cue is called once, by a person holding show.cue.call on the project, and stamped with the database time and that person. Putting an uncalled cue on standby also needs show.cue.call and is stamped with the database time; clearing a standby needs only the row''s update policy.';

-- Standby ---------------------------------------------------------------------------------------------------------------

create or replace function app.standby_cue(p_run_of_show_id uuid, p_cue_id uuid default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run app.run_of_show;
  v_cue app.cues;
begin
  perform private.require_person();
  select * into v_run from app.run_of_show r where r.id = p_run_of_show_id and r.deleted_at is null for update;
  if v_run.id is null or not private.can_on_project(v_run.project_id, 'show.cue.call') then
    raise exception using errcode = '42501', message = 'show.cue.call is required on the running order';
  end if;
  if p_cue_id is not null then
    select * into v_cue from app.cues c where c.id = p_cue_id and c.run_of_show_id = v_run.id and c.deleted_at is null;
    if v_cue.id is null then
      raise exception using errcode = '42501', message = 'the cue is not in this running order';
    end if;
    if v_cue.called_at is not null then
      perform private.refuse('cue_standby_called', 'A called cue cannot go on standby.');
    end if;
  end if;
  update app.cues set standby_at = null
  where run_of_show_id = v_run.id and standby_at is not null and id is distinct from p_cue_id;
  if p_cue_id is not null then
    update app.cues set standby_at = now() where id = p_cue_id and standby_at is null;
  end if;
end;
$$;

comment on function app.standby_cue(uuid, uuid) is 'Puts one uncalled cue of a running order on standby, clearing any other standby of the run, in one transaction; a NULL cue only clears. Needs show.cue.call on the project and refuses a called cue (cue_standby_called).';

revoke all on function app.standby_cue(uuid, uuid) from public, anon;
grant execute on function app.standby_cue(uuid, uuid) to authenticated, service_role;

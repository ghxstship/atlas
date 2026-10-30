-- 2790_p2_show_calling.sql
-- P2 Run of show and show calling (RRR-216, ADR 0131). Demo data for the showcaller console on the Opening Night running
-- order (0108): a curfew, House Lights Up as a time to be confirmed, and Audio, Lighting and Stage calls on cues 3 and 4.
-- Cues 1 and 2 stay as 0108 left them, so the Maestro flow and journey 15 read what they always read. Idempotent.

do $$
declare
  c_project constant uuid := '01920000-0000-7000-8000-000000001001';
  v_run uuid;
begin
  select r.id into v_run from app.run_of_show r
  where r.project_id = c_project and r.name = 'Opening Night Running Order' and r.show_date = date '2027-03-13'
    and r.deleted_at is null;
  if v_run is null then
    return;
  end if;

  update app.run_of_show set curfew_at = '2027-03-14 02:00+00' where id = v_run and curfew_at is null;
  update app.cues set start_tbc = true where run_of_show_id = v_run and position = 5 and deleted_at is null;

  insert into app.cue_calls (org_id, cue_id, call_kind, instruction)
  select c.org_id, c.id, k.call_kind::app.cue_call_kind, k.instruction
  from app.cues c
  join (values
    (3, 'Audio', 'Host mic live, walk-in bed out'),
    (3, 'Lighting', 'LX 14 GO, house to half, podium special'),
    (3, 'Stage', 'Podium set center, host standby stage left'),
    (4, 'Audio', 'Playback 1 GO, band channels open'),
    (4, 'Lighting', 'LX 20 GO, full stage wash'),
    (4, 'Stage', 'Podium strike, riser lock checked')
  ) k (position, call_kind, instruction) on k.position = c.position
  where c.run_of_show_id = v_run and c.deleted_at is null
    and not exists (
      select 1 from app.cue_calls x
      where x.cue_id = c.id and x.call_kind = k.call_kind::app.cue_call_kind and x.deleted_at is null);
end $$;

-- Store screenshots (RRR-113): moves two pieces of the local demo seed to today, so the screenshots show
-- times a person would see on a show day instead of the seed's March 2027 dates. Run only against a
-- freshly reset LOCAL stack (scripts/store-screenshots.sh does, with docker exec on the stack's database);
-- never against staging or production, which must not hold the demo seed at all (ADR 0033, decision 1).
--   * the Opening Night running order runs today: its first cue was called a few minutes ago and the next
--     one is twelve minutes away
--   * the open Festival Rigger shift starts in two hours, so Schedule offers it to claim
do $$
declare
  v_show uuid;
begin
  select id into v_show from app.run_of_show where name = 'Opening Night Running Order' and deleted_at is null;
  if v_show is null then
    raise exception 'store-screenshots.sql expects the local demo seed (supabase/seeds/0108)';
  end if;
  update app.run_of_show set show_date = (now() at time zone 'America/New_York')::date where id = v_show;
  update app.cues c
  set planned_at = date_trunc('minute', now()) + case c.position
        when 1 then interval '-5 minutes'
        when 2 then interval '12 minutes'
        when 3 then interval '13 minutes'
        when 4 then interval '22 minutes'
        else interval '102 minutes'
      end,
      called_at = case when c.position = 1 then now() - interval '4 minutes' else null end
  where c.run_of_show_id = v_show and c.deleted_at is null;

  update app.shifts
  set starts_at = date_trunc('hour', now()) + interval '2 hours',
      ends_at = date_trunc('hour', now()) + interval '10 hours'
  where shift_state = 'Published' and membership_id is null and deleted_at is null
    and starts_at > now() + interval '30 days';
end $$;

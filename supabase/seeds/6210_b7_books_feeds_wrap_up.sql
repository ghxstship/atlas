-- 2960_b7_books_feeds_wrap_up.sql
-- B7 Day sheets, books, calendar feeds and wrap-up report (RRR-231, ADR 0146). Demo data on the Opening Night project
-- (0108): three day sheets around show day (two published), the Production team (0010) and a Production department
-- group, two named project feeds of the owner (Show calls with cues for the Production team, Lighting crew with the
-- Lighting calls), a Tour Book and a Production Book, and an open debrief with points. Feed tokens are random and never
-- shown, so the feeds list their names only. Local and demo data only. Idempotent.

do $$
declare
  c_org constant uuid := '01920000-0000-7000-8000-000000000001';
  c_project constant uuid := '01920000-0000-7000-8000-000000001001';
  c_owner constant uuid := '01920000-0000-7000-8000-00000000a101';
  c_team constant uuid := '01920000-0000-7000-8000-000000000501';
  c_group constant uuid := '01920000-0000-7000-8000-0000000b7001';
  c_feed_show constant uuid := '01920000-0000-7000-8000-0000000b7101';
  c_feed_lx constant uuid := '01920000-0000-7000-8000-0000000b7102';
  c_tour constant uuid := '01920000-0000-7000-8000-0000000b7201';
  c_production constant uuid := '01920000-0000-7000-8000-0000000b7202';
  c_debrief constant uuid := '01920000-0000-7000-8000-0000000b7301';
  v_token text;
begin
  if not exists (select 1 from app.projects p where p.id = c_project and p.deleted_at is null) then
    return;
  end if;

  -- Day sheets: the day before (published) and the day after (a draft) around 0108's show day.
  insert into app.day_sheets (project_id, day, body, published_at)
  select c_project, v.day, v.body, v.published_at
  from (values
    (date '2027-03-12', 'Rigging call 08:00 at the pier gate. Lighting focus 14:00. Production meeting 17:00 in the green room.', now()),
    (date '2027-03-14', 'Load-out call 09:00. Trucks at the dock 11:00. Pier handed back 18:00.', null::timestamptz)
  ) v (day, body, published_at)
  where not exists (select 1 from app.day_sheets d where d.project_id = c_project and d.day = v.day and d.deleted_at is null);

  -- A Production department group with the second producer (0010's Production team holds a103 and a104).
  insert into app.groups (id, org_id, name, group_kind, department_code, description)
  values (c_group, c_org, 'Production department', 'Department', '5000', 'Everyone who works in production on the shows.')
  on conflict (id) do nothing;
  insert into app.group_members (group_id, membership_id)
  select c_group, '01920000-0000-7000-8000-00000000a104'
  where not exists (select 1 from app.group_members g where g.group_id = c_group
                    and g.membership_id = '01920000-0000-7000-8000-00000000a104' and g.deleted_at is null);

  -- Two named project feeds of the owner.
  if not exists (select 1 from app.calendar_feeds f where f.id = c_feed_show) then
    v_token := private.new_calendar_feed_token();
    insert into app.calendar_feeds (id, membership_id, project_id, token_hash, token_hint, name, sources, team_id)
    values (c_feed_show, c_owner, c_project, extensions.digest(v_token, 'sha256'), right(v_token, 4), 'Show calls',
      array['Shifts', 'Meetings', 'Cues']::app.calendar_feed_source[], c_team);
  end if;
  if not exists (select 1 from app.calendar_feeds f where f.id = c_feed_lx) then
    v_token := private.new_calendar_feed_token();
    insert into app.calendar_feeds (id, membership_id, project_id, token_hash, token_hint, name, sources, cue_call_kind)
    values (c_feed_lx, c_owner, c_project, extensions.digest(v_token, 'sha256'), right(v_token, 4), 'Lighting crew',
      array['Cues']::app.calendar_feed_source[], 'Lighting');
  end if;

  -- A Tour Book of show week and a Production Book of the whole project.
  insert into app.document_books (id, project_id, name, book_kind, starts_on, ends_on)
  values (c_tour, c_project, 'Opening week tour book', 'Tour Book', date '2027-03-12', date '2027-03-14'),
    (c_production, c_project, 'Production book', 'Production Book', null, null)
  on conflict (id) do nothing;
  insert into app.document_book_sections (book_id, document_kind, position)
  select v.book_id, v.kind, v.position
  from (values (c_tour, 'day-sheet', 1), (c_tour, 'call-sheet', 2), (c_tour, 'run-of-show', 3),
    (c_production, 'day-sheet', 1), (c_production, 'run-of-show', 2), (c_production, 'incident-report', 3),
    (c_production, 'final-cost-report', 4), (c_production, 'wrap-up-report', 5)) v (book_id, kind, position)
  where not exists (select 1 from app.document_book_sections s where s.book_id = v.book_id and s.document_kind = v.kind and s.deleted_at is null);

  -- An open debrief with points.
  insert into app.project_debriefs (id, project_id) values (c_debrief, c_project) on conflict (id) do nothing;
  insert into app.project_debrief_items (debrief_id, area, item_kind, body, position, owner_membership_id)
  select c_debrief, v.area::app.debrief_area, v.kind::app.debrief_item_kind, v.body, v.position, v.owner
  from (values
    ('Schedule', 'Went Well', 'Load-in finished an hour ahead of the plan.', 1, null::uuid),
    ('Audience', 'To Improve', 'The pier gate queue peaked at 25 minutes before doors.', 2, null::uuid),
    ('Safety', 'Action', 'Add a second spotter on the downstage truss for load-out.', 3, '01920000-0000-7000-8000-00000000a104'::uuid)
  ) v (area, kind, body, position, owner)
  where not exists (select 1 from app.project_debrief_items i where i.debrief_id = c_debrief and i.position = v.position and i.deleted_at is null);
end $$;

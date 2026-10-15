-- 0227_gateway.sql
-- A27 Gateway (RRR-29). Demo data that exercises Gateway beyond A28's lifecycle seed (0228), for the demo crew person
-- on the fixed ids of 0000_demo_tenant_conventions.sql:
--   * an engagement conversation on the crew engagement, with a message from the org and the crew person's reply
--   * an org-level conversation between the demo org and the crew person
--   * the crew person's availability calendar with an available and an unavailable block
--   * a saved search with alerts on, for Crew calls
--
-- Guarded on the demo org and the demo crew person. The engagement conversation also needs 0228's crew engagement,
-- which loads after this file on a reset, so it is written only when this seed runs again after 0228 (for example
-- `supabase db reset` followed by `psql -f` of this file); everything else loads on every reset. Idempotent: fixed ids with
-- `on conflict do nothing`. Message authors are stamped from the session, so each message is written with the author's
-- JWT claims set for the transaction and cleared afterwards. Extra fixed ids, all in the 0227 block:
--   engagement thread ...227001, party thread ...227002, messages ...227101 to ...227103,
--   availability calendar ...227201, blocks ...227211 and ...227212, saved search ...227301.

do $$
declare
  v_org constant uuid := '01920000-0000-7000-8000-000000000001';
  v_owner constant uuid := '01920000-0000-7000-8000-000000000101';
  v_crew constant uuid := '01920000-0000-7000-8000-000000000201';
  v_engagement constant uuid := '01920000-0000-7000-8000-000000228401';
  v_thread constant uuid := '01920000-0000-7000-8000-000000227001';
  v_party_thread constant uuid := '01920000-0000-7000-8000-000000227002';
  v_calendar constant uuid := '01920000-0000-7000-8000-000000227201';
begin
  if not exists (select 1 from app.organizations where id = v_org)
     or not exists (select 1 from app.people where id = v_crew) then
    return;
  end if;

  -- Engagement conversation ---------------------------------------------------------------------------------------
  if exists (select 1 from app.engagements where id = v_engagement) then
    insert into app.engagement_threads (id, org_id, engagement_id, subject)
    values (v_thread, v_org, v_engagement, 'Load-In and Parking')
    on conflict (id) do nothing;

    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    insert into app.engagement_messages (id, org_id, engagement_thread_id, body)
    values ('01920000-0000-7000-8000-000000227101', v_org, v_thread,
      'Crew parking is in Lot C off the service road. Check in at the production office by 07:30.')
    on conflict (id) do nothing;

    perform set_config('request.jwt.claims', json_build_object('sub', v_crew, 'role', 'authenticated')::text, true);
    insert into app.engagement_messages (id, org_id, engagement_thread_id, body)
    values ('01920000-0000-7000-8000-000000227102', v_org, v_thread,
      'Thanks. I will bring my own harness and lanyards; is there a lockable gear cage?')
    on conflict (id) do nothing;
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_crew, 'role', 'authenticated')::text, true);

  -- Org-level conversation ------------------------------------------------------------------------------------------
  insert into app.party_threads (id, org_id, party_person_id, subject)
  values (v_party_thread, v_org, v_crew, 'Availability for the Fall Season')
  on conflict (id) do nothing;

  insert into app.party_messages (id, org_id, party_thread_id, body)
  values ('01920000-0000-7000-8000-000000227103', v_org, v_party_thread,
    'I am open most weekends in November and can lead a rigging crew of four.')
  on conflict (id) do nothing;

  -- Availability ----------------------------------------------------------------------------------------------------
  insert into app.availability_calendars (id, person_id, time_zone, visibility)
  values (v_calendar, v_crew, 'America/New_York', 'Shared on Application')
  on conflict (id) do nothing;

  insert into app.availability_blocks (id, availability_calendar_id, starts_at, ends_at, availability_kind)
  values
    ('01920000-0000-7000-8000-000000227211', v_calendar, '2026-11-06 00:00+00', '2026-11-09 00:00+00', 'Available'),
    ('01920000-0000-7000-8000-000000227212', v_calendar, '2026-11-20 00:00+00', '2026-11-23 00:00+00', 'Unavailable')
  on conflict (id) do nothing;

  -- Saved search ----------------------------------------------------------------------------------------------------
  insert into app.saved_searches (id, person_id, name, role_type, alerts_enabled)
  values ('01920000-0000-7000-8000-000000227301', v_crew, 'Rigging Calls', 'Crew', true)
  on conflict (id) do nothing;

  perform set_config('request.jwt.claims', '', true);
end $$;

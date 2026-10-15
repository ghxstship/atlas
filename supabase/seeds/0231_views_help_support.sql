-- 0231_views_help_support.sql
-- A31 Views, Help and Support. The demo tenant's saved views (shared with the org and with the
-- Production team, with a default per page), guided tour progress, a dismissed tip, and support tickets
-- in both queues, one with consented diagnostics (Section 19.6: a demo tenant seed exercises every
-- feature). Builds on 0010_demo_identity.sql and loads cleanly without it. Idempotent: every row has a
-- fixed id in this file's block (...0231xxxx) and is inserted only when missing.

do $$
declare
  v_org constant uuid := '01920000-0000-7000-8000-000000000001';
  v_admin_m constant uuid := '01920000-0000-7000-8000-00000000a102';
  v_producer_m constant uuid := '01920000-0000-7000-8000-00000000a103';
  v_field_m constant uuid := '01920000-0000-7000-8000-00000000a104';
  v_team constant uuid := '01920000-0000-7000-8000-000000000501';
  v_view_inbound constant uuid := '01920000-0000-7000-8000-000002310001';
  v_view_projects constant uuid := '01920000-0000-7000-8000-000002310002';
  v_view_venues constant uuid := '01920000-0000-7000-8000-000002310003';
  v_ticket_org constant uuid := '01920000-0000-7000-8000-000002310101';
  v_ticket_platform constant uuid := '01920000-0000-7000-8000-000002310102';
begin
  if not exists (select 1 from app.organizations o where o.id = v_org)
     or not exists (select 1 from app.memberships m where m.id = v_field_m) then
    return;
  end if;

  -- Saved views: the Producer's board of inbound shipments, shared with the Production team; the
  -- Admin's project table, shared with the whole org; the Producer's private venue map.
  insert into app.saved_views (id, membership_id, collection_key, name, view_type, search_text, shared)
  select v.id, v.membership_id, v.collection_key, v.name, v.view_type::app.view_type, v.search_text, v.shared
  from (values
    (v_view_inbound, v_producer_m, 'logistics/shipments', 'Inbound Shipments', 'Board', 'inbound', false),
    (v_view_projects, v_admin_m, 'projects', 'Active Projects', 'Table', null, true),
    (v_view_venues, v_producer_m, 'places/venues', 'Venues On The Map', 'Map', null, false)
  ) as v (id, membership_id, collection_key, name, view_type, search_text, shared)
  where not exists (select 1 from app.saved_views s where s.id = v.id);

  insert into app.saved_view_filters (id, saved_view_id, field, operator, value_text)
  select '01920000-0000-7000-8000-000002310011', v_view_projects, 'archive', 'eq', 'active'
  where not exists (select 1 from app.saved_view_filters f where f.id = '01920000-0000-7000-8000-000002310011');

  insert into app.saved_view_sorts (id, saved_view_id, field, direction, position)
  select '01920000-0000-7000-8000-000002310021', v_view_projects, 'name', 'Ascending', 1
  where not exists (select 1 from app.saved_view_sorts s where s.id = '01920000-0000-7000-8000-000002310021');

  insert into app.saved_view_shares (id, saved_view_id, team_id)
  select '01920000-0000-7000-8000-000002310031', v_view_inbound, v_team
  where exists (select 1 from app.teams t where t.id = v_team)
    and not exists (select 1 from app.saved_view_shares s where s.id = '01920000-0000-7000-8000-000002310031');

  -- The Field lead opens shipments on the Production team's board by default. The default guard reads
  -- as the signed-in person, so the seed signs in as them for this one insert.
  if exists (select 1 from app.saved_view_shares s where s.id = '01920000-0000-7000-8000-000002310031')
     and not exists (select 1 from app.saved_view_defaults d where d.id = '01920000-0000-7000-8000-000002310041') then
    perform set_config('request.jwt.claims',
      json_build_object('sub', (select p.user_id from app.people p join app.memberships m on m.person_id = p.id where m.id = v_field_m),
        'role', 'authenticated')::text, true);
    insert into app.saved_view_defaults (id, membership_id, collection_key, saved_view_id)
    values ('01920000-0000-7000-8000-000002310041', v_field_m, 'logistics/shipments', v_view_inbound);
    perform set_config('request.jwt.claims', '', true);
  end if;

  -- Tours and tips: the Producer finished the getting-started tour and dismissed the gates tip; the
  -- Field lead was offered the Compass tour and has not started it.
  insert into app.tour_progress (id, membership_id, tour_key, tour_state, step)
  select t.id, t.membership_id, t.tour_key, t.tour_state::app.tour_state, t.step
  from (values
    ('01920000-0000-7000-8000-000002310051'::uuid, v_producer_m, 'atlas.getting-started', 'Completed', 5),
    ('01920000-0000-7000-8000-000002310052'::uuid, v_field_m, 'module.crew', 'Offered', 0)
  ) as t (id, membership_id, tour_key, tour_state, step)
  where not exists (select 1 from app.tour_progress p where p.id = t.id);

  insert into app.tip_dismissals (id, membership_id, tip_key)
  select '01920000-0000-7000-8000-000002310061', v_producer_m, 'gates'
  where not exists (select 1 from app.tip_dismissals d where d.id = '01920000-0000-7000-8000-000002310061');

  -- Support: the Field lead asks the org's admins about a scanner zone, with consented diagnostics;
  -- the Admin asks the platform team (Team plan: priority queue, 8 business hours) about payroll export.
  if not exists (select 1 from app.support_tickets t where t.id = v_ticket_org) then
    insert into app.support_tickets (id, membership_id, ticket_number, queue, category, severity, subject, body, channel)
    values (v_ticket_org, v_field_m, 'SUP-' || lpad(private.next_sequence(v_org, 'support_ticket')::text, 4, '0'),
      'Organization', 'Access', 'Severity 3', 'Scanner shows an unknown zone',
      'At the north gate the scanner says the zone is unknown for every wristband.', 'In App');
    insert into app.support_ticket_diagnostics (id, support_ticket_id, consented_at, route, app_version, device, recent_errors)
    values ('01920000-0000-7000-8000-000002310111', v_ticket_org, now(), '/demo/credentials/scans', '4.0.0 (812)',
      'Safari 19 on iOS 26', 'Zone lookup returned no rows for zone NG-1');
  end if;
  if not exists (select 1 from app.support_tickets t where t.id = v_ticket_platform) then
    insert into app.support_tickets (id, membership_id, ticket_number, queue, category, severity, subject, body, channel, first_response_due_at)
    select v_ticket_platform, v_admin_m, 'SUP-' || lpad(private.next_sequence(v_org, 'support_ticket')::text, 4, '0'),
      'Platform', 'Question', 'Severity 3', 'Payroll export file format',
      'Which columns does the payroll export include for our accounting mapping?', t.channel, t.first_response_due_at
    from private.platform_support_terms('team', 'Severity 3', now()) t;
    insert into app.support_ticket_messages (id, support_ticket_id, author_membership_id, body)
    values ('01920000-0000-7000-8000-000002310121', v_ticket_platform, null,
      'The export follows the mapping chosen in Settings, Payroll. Which accounting system do you use?');
    update app.support_tickets set first_responded_at = now() where id = v_ticket_platform;
  end if;
end;
$$;

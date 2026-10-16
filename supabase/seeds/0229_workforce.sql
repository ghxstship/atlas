-- 0229_workforce.sql
-- A29 Workforce Suite. The demo tenant's group space and chat, feed with a pinned announcement that
-- needs acknowledgment, an update, a quick poll and a scheduled post, an open pulse survey, a
-- recognition, a briefing with RSVPs, a published form with a submission, a training course with a
-- pass, a mandatory handbook article, a help desk team with a request, an occupancy counter, weather
-- thresholds with a reading, door check-in, and a lost item with a claim (Section 19.6: a demo tenant
-- seed exercises every feature). Builds on 0010_demo_identity.sql and 0107_projects.sql and loads
-- cleanly without them. Idempotent: the fixed group id (...0229xxxx block) marks the seed as loaded.
-- Writes go through the suite's RPCs as the demo people, so every guard and event runs as in the app.

do $$
declare
  v_org constant uuid := '01920000-0000-7000-8000-000000000001';
  v_project constant uuid := '01920000-0000-7000-8000-000000001001';
  v_admin_m constant uuid := '01920000-0000-7000-8000-00000000a102';
  v_producer_m constant uuid := '01920000-0000-7000-8000-00000000a103';
  v_field_m constant uuid := '01920000-0000-7000-8000-00000000a104';
  v_group constant uuid := '01920000-0000-7000-8000-000002290001';
  v_guest_door constant uuid := '01920000-0000-7000-8000-000002290101';
  v_guest_in constant uuid := '01920000-0000-7000-8000-000002290102';
  v_producer_user uuid;
  v_field_user uuid;
  v_admin_user uuid;
  v_conversation uuid;
  v_post uuid;
  v_poll uuid;
  v_survey uuid;
  v_template uuid;
  v_course uuid;
  v_lesson uuid;
  v_quiz uuid;
  v_question uuid;
  v_section uuid;
  v_article uuid;
  v_team uuid;
  v_counter uuid;
  v_item uuid;
  v_event uuid;
begin
  if not exists (select 1 from app.organizations o where o.id = v_org)
     or not exists (select 1 from app.memberships m where m.id = v_field_m)
     or not exists (select 1 from app.projects p where p.id = v_project)
     or exists (select 1 from app.groups g where g.id = v_group) then
    return;
  end if;
  select p.user_id into v_producer_user from app.people p join app.memberships m on m.person_id = p.id where m.id = v_producer_m;
  select p.user_id into v_field_user from app.people p join app.memberships m on m.person_id = p.id where m.id = v_field_m;
  select p.user_id into v_admin_user from app.people p join app.memberships m on m.person_id = p.id where m.id = v_admin_m;

  -- The Admin sets up the Production Crew group space and the IT help desk team.
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin_user, 'role', 'authenticated')::text, true);
  insert into app.groups (id, org_id, name, group_kind, description)
  values (v_group, v_org, 'Production Crew Space', 'Crew', 'Everyone running the Northwind summer shows.');
  insert into app.group_members (group_id, membership_id, group_role) values
    (v_group, v_producer_m, 'Owner'), (v_group, v_field_m, 'Member'), (v_group, v_admin_m, 'Member');
  insert into app.help_desk_teams (org_id, name, team_kind, description, first_response_hours)
  values (v_org, 'Site IT Desk', 'IT', 'Tablets, scanners and accounts on site.', 4) returning id into v_team;
  insert into app.help_desk_team_members (help_desk_team_id, membership_id) values (v_team, v_admin_m);

  -- The Producer posts, runs a survey, schedules a briefing, builds a form, a course and the handbook.
  perform set_config('request.jwt.claims', json_build_object('sub', v_producer_user, 'role', 'authenticated')::text, true);
  select c.id into v_conversation from app.conversations c where c.group_id = v_group;
  perform app.send_chat_message(v_conversation, 'Load-in starts at 06:00. Coffee at the dock.');
  v_post := app.create_feed_post(v_org, 'Announcement', 'Wristbands switch from blue to orange on Friday. Check yours at the gate.',
    'Wristband Change Friday', p_pinned => true, p_requires_acknowledgment => true);
  perform app.create_feed_post(v_org, 'Update', 'The pier deck reopened after the rain check. Thanks for the quick reset.',
    p_audience_kind => 'Project', p_project_id => v_project);
  perform app.create_feed_post(v_org, 'Poll', 'Help us pick the Saturday crew meal.',
    p_poll => '{"question": "Which crew meal on Saturday?", "options": ["Tacos", "Pasta", "Grain bowls"]}'::jsonb);
  select p.id into v_poll from app.polls p join app.feed_posts f on f.id = p.feed_post_id where f.org_id = v_org order by p.created_at desc limit 1;
  perform app.create_feed_post(v_org, 'Announcement', 'Payroll for the first week closes Sunday at 18:00.', 'Payroll Cutoff Reminder',
    p_publish_at => now() + interval '2 days');
  v_survey := app.create_survey(v_org, 'Load-In Pulse', '[
    {"prompt": "How safe did the load-in feel?", "kind": "Scale", "scale_max": 5},
    {"prompt": "Which shift worked best?", "kind": "Choice", "choices": ["Morning", "Night"]},
    {"prompt": "Anything we should fix?", "kind": "Text", "required": false}]'::jsonb, p_min_responses => 3::smallint);
  perform app.transition_survey(v_survey, 'Draft', 'Open', 'Ready for the crew.');
  perform app.recognize(v_org, v_field_m, 'Re-rigged the stage left truss in record time before doors.', v_project);

  insert into app.workforce_events (org_id, organizer_membership_id, event_kind, title, agenda, location, audience_kind, project_id, starts_at, ends_at)
  values (v_org, v_producer_m, 'Briefing', 'Show Day Safety Briefing', '1. Weather plan. 2. Gate assignments. 3. Radio check.',
    'Pier Deck stage left', 'Project', v_project, date_trunc('hour', now()) + interval '1 day 8 hours', date_trunc('hour', now()) + interval '1 day 9 hours')
  returning id into v_event;

  insert into app.form_templates (org_id, name, description, record_kind, record_subtype, fields, requires_location, pass_score)
  values (v_org, 'Rigging Pre-Use Check', 'Before every lift.', 'Inspection', 'Safety', '[
    {"key": "hoist_ok", "label": "Hoist inspected", "kind": "yes_no", "required": true, "points": {"true": 2}},
    {"key": "defect", "label": "Defect found", "kind": "long_text", "required": true, "show_if": {"key": "hoist_ok", "equals": false}},
    {"key": "load", "label": "Load class", "kind": "choice", "choices": ["Light", "Medium", "Heavy"], "points": {"Light": 1, "Medium": 1, "Heavy": 0}},
    {"key": "photos", "label": "Photos of the hoist", "kind": "photo"}
  ]'::jsonb, true, 2)
  returning id into v_template;
  perform app.publish_form_template(v_template);

  insert into app.training_courses (org_id, title, summary, validity_days, pass_percent, estimated_minutes)
  values (v_org, 'Rigging Basics for Crew', 'Slings, shackles and safe working loads.', 365, 50, 15) returning id into v_course;
  insert into app.training_lessons (training_course_id, position, title, lesson_kind, body)
  values (v_course, 1, 'Inspect Every Sling', 'Reading', 'Check slings for cuts, burns and broken stitching before every lift.') returning id into v_lesson;
  insert into app.training_lessons (training_course_id, position, title, lesson_kind) values (v_course, 2, 'Check Your Knowledge', 'Quiz') returning id into v_quiz;
  insert into app.training_quiz_questions (training_lesson_id, position, prompt, options)
  values (v_quiz, 1, 'What do you do before a lift?', array['Inspect the sling', 'Skip the check']) returning id into v_question;
  insert into app.training_quiz_keys (training_quiz_question_id, correct_option) values (v_question, 1);
  perform app.publish_training_course(v_course);
  perform app.assign_training(v_course, array[v_field_m], current_date + 7, 'New rigging crew');

  insert into app.handbook_sections (org_id, name, position) values (v_org, 'Site Rules', 1) returning id into v_section;
  insert into app.handbook_articles (org_id, handbook_section_id, title, body, is_mandatory)
  values (v_org, v_section, 'Hearing Protection on Site', 'Wear hearing protection within 10 m of the main stacks during sound check and shows.' || chr(10) || chr(10) || 'Foam plugs are at every gate.', true)
  returning id into v_article;
  perform app.publish_handbook_article(v_article, 'First version.');

  -- Site operations on the demo project.
  v_counter := app.create_occupancy_counter(v_project, 'Pier Deck Doors', '01920000-0000-7000-8000-000000010911');
  perform app.record_occupancy_count(v_counter, 250, 'Gate A');
  insert into app.weather_thresholds (org_id, project_id, hazard, alert_level, threshold_value, unit, comparison, source_note) values
    (v_org, v_project, 'Wind', 'Monitor', 20, 'mph', 'At or Above', 'Emergency plan 4.2'),
    (v_org, v_project, 'Wind', 'Restrict', 30, 'mph', 'At or Above', 'Emergency plan 4.2'),
    (v_org, v_project, 'Wind', 'Evacuate', 40, 'mph', 'At or Above', 'Emergency plan 4.2'),
    (v_org, v_project, 'Lightning', 'Evacuate', 8, 'mi', 'At or Below', 'Emergency plan 4.3');
  perform app.record_weather_reading(v_project, 'Wind', 24);
  v_item := app.log_lost_item(v_project, 'Wallet', 'Brown leather wallet, no cash, library card inside.', 'Bar 2', 'Security office locker 4');
  perform app.claim_lost_item(v_item, 'Sam Rivera', 'sam.rivera@example.com', 'Named the library card inside.');
  insert into app.guest_list_entries (id, project_id, guest_name, plus_ones, entry_state) values
    (v_guest_door, v_project, 'Avery Brooks', 2, 'Approved'),
    (v_guest_in, v_project, 'Casey Morgan', 1, 'Approved');
  perform app.check_in_guest(v_guest_in, 1::smallint, 'Gate A');

  -- The Field lead reads, votes, answers, attends, submits, learns and asks for help.
  perform set_config('request.jwt.claims', json_build_object('sub', v_field_user, 'role', 'authenticated')::text, true);
  perform app.send_chat_message(v_conversation, 'On my way. Bringing the spare shackles.');
  perform app.acknowledge_feed_post(v_post);
  perform app.react_to_feed_post(v_post, 'thumbs_up');
  perform app.vote_in_poll(v_poll, array[(select o.id from app.poll_options o where o.poll_id = v_poll and o.position = 1)]);
  perform app.respond_to_survey(v_survey, jsonb_build_object(
    (select q.id::text from app.survey_questions q where q.survey_id = v_survey and q.position = 1), 4,
    (select q.id::text from app.survey_questions q where q.survey_id = v_survey and q.position = 2), 'Morning'));
  perform app.rsvp_to_event(v_event, 'Going');
  perform app.submit_form(v_template, '{"hoist_ok": true, "load": "Medium"}'::jsonb, v_project,
    '{"latitude": 25.7743, "longitude": -80.1937, "accuracy_m": 6}'::jsonb);
  perform app.complete_training_lesson(v_lesson);
  perform app.complete_training(v_course, jsonb_build_object(v_question::text, 1));
  perform app.acknowledge_handbook_article(v_article);
  perform app.open_help_desk_request(v_org, v_team, 'Access', 'Dock tablet will not sign in',
    'The dock tablet shows a blank screen after sign-in since this morning.');
  perform app.start_direct_conversation(v_org, v_producer_m);
  perform app.send_chat_message(app.start_direct_conversation(v_org, v_producer_m), 'Can I swap Saturday for Sunday?');

  perform set_config('request.jwt.claims', '', true);
end;
$$;

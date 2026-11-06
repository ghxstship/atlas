-- 6146_rating_dispute_rpcs.sql
-- RRR-248, ADR 0158. The route a rated person disputes a rating through (6145 holds the table):
--   * app.file_rating_dispute: the rated person, once per rating, once it is released.
--   * app.respond_to_rating_dispute: the org that gave the rating answers once. It cannot decide.
--   * Filing and answering need the person's own session: an app's or connector's token never spends the one dispute or the
--     one answer. The rated person never answers for the org, and an operator who belongs to the rating org never decides.
--   * app.rating_dispute_subjects: which rating a dispute is about, for the two sides, even after the rating is removed.
--   * the console queue and app.console_decide_rating_dispute (moderation.decide): an operator decides with a statement
--     of reasons. Upholding needs a named ground: the wrong person, a false statement, abuse or personal data. Neither
--     the queue nor the detail shows the score, so what a rating scored cannot decide it (16 CFR Part 465).
--   * rating_dispute.filed tells the org; rating_dispute.decided tells the person and the org.

create or replace function private.rating_answerer_ids(p_org_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct m.person_id from app.memberships m
  where m.org_id = p_org_id and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
    and private.person_capability_reach(m.person_id, p_org_id, 'opportunities.rating.write', true) is not null;
$$;

comment on function private.rating_answerer_ids(uuid) is 'Members of an org who hold opportunities.rating.write: those told about a dispute of its rating.';
revoke all on function private.rating_answerer_ids(uuid) from public, anon, authenticated;

create or replace function private.person_in_org(p_person_id uuid, p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from app.memberships m
                 where m.person_id = p_person_id and m.org_id = p_org_id and m.deleted_at is null
                   and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now()));
$$;

comment on function private.person_in_org(uuid, uuid) is 'True while the person holds an active membership of the org, whatever the session reaches.';
revoke all on function private.person_in_org(uuid, uuid) from public, anon, authenticated;

insert into private.separation_of_duties_rules (code, enforced_on, description) values
  ('sod_rating_dispute_answer', 'Rating disputes', 'A person cannot answer their own dispute of a rating for the organization that gave it.'),
  ('sod_rating_dispute_decide', 'Rating disputes', 'An operator who belongs to the organization that gave a rating cannot decide a dispute of it.');

create or replace function app.file_rating_dispute(p_rating_id uuid, p_ground app.rating_dispute_ground, p_details text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_rating app.ratings;
  v_engagement app.engagements;
  v_id uuid;
begin
  if private.api_key_scopes() is not null then
    raise exception using errcode = '42501', message = 'disputing a rating needs the person''s own session';
  end if;
  select * into v_rating from app.ratings r where r.id = p_rating_id and r.deleted_at is null for share;
  select * into v_engagement from app.engagements e where e.id = v_rating.engagement_id;
  -- Only the rated individual: an account that supplied them does not dispute for them, and a company's rating stays as it is.
  if v_rating.id is null or v_rating.rater_side <> 'Organization' or v_engagement.person_id is distinct from v_me
     or not private.rating_is_of_individual(v_engagement.role_type, v_engagement.person_id, v_engagement.counterparty_id, v_engagement.application_id)
     or not private.rating_released(v_rating.engagement_id) then
    raise exception using errcode = '42501', message = 'rating not found';
  end if;
  if p_ground is null then
    perform private.refuse('rating_dispute_ground', 'Choose why you dispute this rating.');
  end if;
  if p_details is null or char_length(btrim(p_details)) not between 1 and 4000 then
    perform private.refuse('rating_dispute_details', 'Say what is wrong with this rating, in up to 4,000 characters.');
  end if;
  if exists (select 1 from app.rating_disputes d where d.rating_id = v_rating.id and d.deleted_at is null) then
    perform private.refuse('rating_dispute_exists', 'This rating has already been disputed.');
  end if;
  insert into app.rating_disputes (rating_id, disputant_person_id, dispute_ground, dispute_details)
  values (v_rating.id, v_me, p_ground, btrim(p_details))
  returning id into v_id;
  perform private.notify(v_rating.org_id, a, 'rating_dispute.filed', 'ratings', v_rating.id, v_engagement.project_id,
    jsonb_build_object('ground', p_ground, 'project', (select p.name from app.projects p where p.id = v_engagement.project_id)))
  from private.rating_answerer_ids(v_rating.org_id) a;
  return v_id;
end;
$$;

comment on function app.file_rating_dispute(uuid, app.rating_dispute_ground, text) is 'The person an org rated disputes a released rating, once per rating (ADR 0158), and the org''s rating holders are told. The rating stays shown while the dispute is open. Only from the person''s own session.';
revoke all on function app.file_rating_dispute(uuid, app.rating_dispute_ground, text) from public, anon;
grant execute on function app.file_rating_dispute(uuid, app.rating_dispute_ground, text) to authenticated, service_role;

create or replace function app.respond_to_rating_dispute(p_dispute_id uuid, p_response text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_dispute app.rating_disputes;
  v_project uuid;
begin
  if private.api_key_scopes() is not null then
    raise exception using errcode = '42501', message = 'answering a dispute needs the person''s own session';
  end if;
  select * into v_dispute from app.rating_disputes d where d.id = p_dispute_id and d.deleted_at is null for update;
  select e.project_id into v_project from app.ratings r join app.engagements e on e.id = r.engagement_id where r.id = v_dispute.rating_id;
  if v_dispute.id is null or v_dispute.org_id not in (select private.my_org_ids())
     or not private.can_on_project(v_project, 'opportunities.rating.write') then
    raise exception using errcode = '42501', message = 'dispute not found';
  end if;
  if v_dispute.disputant_person_id = v_me then
    perform private.refuse('sod_rating_dispute_answer', 'A person cannot answer their own dispute for the organization. Someone else with rating access answers.');
  end if;
  if v_dispute.dispute_state <> 'Open' then
    perform private.refuse('rating_dispute_decided', 'This dispute has already been decided.');
  end if;
  if v_dispute.org_response is not null then
    perform private.refuse('rating_dispute_answered', 'Your organization has already answered this dispute.');
  end if;
  if p_response is null or char_length(btrim(p_response)) not between 1 and 4000 then
    perform private.refuse('rating_dispute_response', 'Write your answer in up to 4,000 characters.');
  end if;
  update app.rating_disputes
  set org_response = btrim(p_response), org_responded_by = v_me, org_responded_at = now()
  where id = v_dispute.id;
end;
$$;

comment on function app.respond_to_rating_dispute(uuid, text) is 'A member of the org that gave a rating, with opportunities.rating.write on the project, answers a dispute of it once while it is open (ADR 0158), from their own session and never for a dispute they filed themselves (sod_rating_dispute_answer). The org cannot decide its own dispute.';
revoke all on function app.respond_to_rating_dispute(uuid, text) from public, anon;
grant execute on function app.respond_to_rating_dispute(uuid, text) to authenticated, service_role;

-- Which rating a dispute is about -------------------------------------------------------------------------------------

create or replace function app.rating_dispute_subjects()
returns table (
  dispute_id uuid,
  org_name text,
  engagement_id uuid,
  party_name text,
  project_name text,
  rating_score smallint,
  rating_comment text,
  rating_submitted_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, o.name, e.id, coalesce(pe.full_name, ac.name), pj.name,
    case when d.dispute_state <> 'Upheld' then r.score end,
    case when d.dispute_state <> 'Upheld' then r.comment end,
    r.submitted_at
  from app.rating_disputes d
  join app.ratings r on r.id = d.rating_id
  join app.engagements e on e.id = r.engagement_id
  join app.projects pj on pj.id = e.project_id
  join app.organizations o on o.id = d.org_id
  left join app.people pe on pe.id = e.person_id
  left join app.counterparties c on c.id = e.counterparty_id
  left join app.organizations ac on ac.id = c.organization_id
  where d.deleted_at is null
    and (d.disputant_person_id = private.current_person_id() or d.rating_id in (select private.org_rating_ids()));
$$;

comment on function app.rating_dispute_subjects() is 'What each dispute the signed-in person reads is about, under the same rule as app.rating_disputes: the org that gave the rating, the person it is about, the project and the date, so the org knows what it is answering. An upheld dispute keeps those and drops the score and comment, which stay out of every product read (ADR 0158).';
revoke all on function app.rating_dispute_subjects() from public, anon;
grant execute on function app.rating_dispute_subjects() to authenticated, service_role;

-- The console --------------------------------------------------------------------------------------------------------

create or replace function app.console_rating_dispute_queue(p_open boolean default true)
returns table (
  dispute_id uuid,
  org_id uuid,
  org_name text,
  disputant_name text,
  dispute_ground app.rating_dispute_ground,
  dispute_state app.rating_dispute_state,
  org_answered boolean,
  filed_at timestamptz,
  decided_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_operator('moderation.decide');
  return query
  select d.id, d.org_id, o.name, p.full_name, d.dispute_ground, d.dispute_state, d.org_response is not null, d.filed_at, d.decided_at
  from app.rating_disputes d
  join app.organizations o on o.id = d.org_id
  left join app.people p on p.id = d.disputant_person_id
  where d.deleted_at is null and ((p_open and d.dispute_state = 'Open') or (not p_open and d.dispute_state <> 'Open'))
  order by case when p_open then d.filed_at end, d.decided_at desc nulls last
  limit 200;
end;
$$;

comment on function app.console_rating_dispute_queue(boolean) is 'Rating disputes for the moderation queue (moderation.decide): open ones, oldest first, or decided ones, newest first. The score never appears (ADR 0158).';
revoke all on function app.console_rating_dispute_queue(boolean) from public, anon;
grant execute on function app.console_rating_dispute_queue(boolean) to authenticated;

create or replace function app.console_rating_dispute_detail(p_dispute_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operator uuid := private.require_platform_operator('moderation.decide');
  v_dispute app.rating_disputes;
  v_rating app.ratings;
begin
  select * into v_dispute from app.rating_disputes d where d.id = p_dispute_id and d.deleted_at is null;
  if v_dispute.id is null then
    raise exception using errcode = '42501', message = 'dispute not found';
  end if;
  select * into v_rating from app.ratings r where r.id = v_dispute.rating_id;
  perform private.log_operator_action('rating_dispute.viewed', v_dispute.org_id, 'app.rating_disputes', v_dispute.id, null, '{}'::jsonb);
  return jsonb_build_object(
    'id', v_dispute.id,
    'state', v_dispute.dispute_state,
    'ground', v_dispute.dispute_ground,
    'details', v_dispute.dispute_details,
    'filed_at', v_dispute.filed_at,
    'disputant_name', (select p.full_name from app.people p where p.id = v_dispute.disputant_person_id),
    'org_name', (select o.name from app.organizations o where o.id = v_dispute.org_id),
    'project_name', (select p.name from app.engagements e join app.projects p on p.id = e.project_id where e.id = v_rating.engagement_id),
    'comment', v_rating.comment,
    'submitted_at', v_rating.submitted_at,
    'reply', (select rr.body from app.rating_replies rr where rr.rating_id = v_rating.id and rr.deleted_at is null),
    'org_response', v_dispute.org_response,
    'org_responded_at', v_dispute.org_responded_at,
    'decision_ground', v_dispute.decision_ground,
    'decision_statement', v_dispute.decision_statement,
    'decided_at', v_dispute.decided_at,
    'decided_by_name', (select p.full_name from app.people p where p.id = v_dispute.decided_by),
    'decidable_by_me', v_dispute.dispute_state = 'Open' and v_dispute.disputant_person_id <> v_operator
      and not private.person_in_org(v_operator, v_dispute.org_id));
end;
$$;

comment on function app.console_rating_dispute_detail(uuid) is 'One rating dispute for an operator (moderation.decide): what the person said, the org''s answer and the rating''s comment, without its score (ADR 0158). Each read is logged.';
revoke all on function app.console_rating_dispute_detail(uuid) from public, anon;
grant execute on function app.console_rating_dispute_detail(uuid) to authenticated;

create or replace function app.console_decide_rating_dispute(
  p_dispute_id uuid,
  p_outcome app.rating_dispute_state,
  p_ground app.rating_dispute_ground,
  p_statement text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operator uuid := private.require_platform_operator('moderation.decide');
  v_dispute app.rating_disputes;
  v_project uuid;
  v_args jsonb;
begin
  select * into v_dispute from app.rating_disputes d where d.id = p_dispute_id and d.deleted_at is null for update;
  if v_dispute.id is null then
    raise exception using errcode = '42501', message = 'dispute not found';
  end if;
  if v_dispute.disputant_person_id = v_operator then
    perform private.refuse('rating_dispute_own', 'Another operator decides this dispute: it is your own.');
  end if;
  if private.person_in_org(v_operator, v_dispute.org_id) then
    perform private.refuse('sod_rating_dispute_decide', 'Another operator decides this dispute: you belong to the organization that gave the rating.');
  end if;
  if p_outcome is null or p_outcome = 'Open' then
    perform private.refuse('rating_dispute_outcome', 'Uphold the dispute or do not.');
  end if;
  if p_outcome = 'Upheld' and (p_ground is null or p_ground = 'Other') then
    perform private.refuse('rating_dispute_decision_ground', 'Upholding needs a named ground: the wrong person, a false statement, abuse or personal data. A low score or an unfavorable opinion is not one.');
  end if;
  if p_statement is null or char_length(btrim(p_statement)) not between 1 and 4000 then
    perform private.refuse('rating_dispute_statement', 'Write the reasons the person and the organization receive, in up to 4,000 characters.');
  end if;
  perform private.transition_lifecycle('rating_dispute', 'app.rating_disputes', 'dispute_state', 'app.rating_dispute_state_transitions',
    'rating_dispute_id', v_dispute.id, v_dispute.dispute_state::text, p_outcome::text, 'Decided by a platform operator.');
  update app.rating_disputes
  set decision_ground = case when p_outcome = 'Upheld' then p_ground end,
      decision_statement = btrim(p_statement), decided_by = v_operator, decided_at = now()
  where id = v_dispute.id;
  select e.project_id into v_project from app.ratings r join app.engagements e on e.id = r.engagement_id where r.id = v_dispute.rating_id;
  v_args := jsonb_build_object('outcome', p_outcome, 'statement', btrim(p_statement),
    'project', (select p.name from app.projects p where p.id = v_project));
  perform private.notify(v_dispute.org_id, v_dispute.disputant_person_id, 'rating_dispute.decided', 'ratings', v_dispute.rating_id, v_project, v_args);
  perform private.notify(v_dispute.org_id, a, 'rating_dispute.decided', 'ratings', v_dispute.rating_id, v_project, v_args)
  from private.rating_answerer_ids(v_dispute.org_id) a;
  perform private.log_operator_action('rating_dispute.decided', v_dispute.org_id, 'app.rating_disputes', v_dispute.id, p_statement,
    jsonb_build_object('outcome', p_outcome, 'ground', p_ground));
end;
$$;

comment on function app.console_decide_rating_dispute(uuid, app.rating_dispute_state, app.rating_dispute_ground, text) is 'An operator (moderation.decide), never the disputant nor a member of the rating org (sod_rating_dispute_decide), decides a rating dispute with a statement of reasons (ADR 0158). Upheld removes the rating from every product read and needs a named ground; the score is never read. The person and the org are told, naming the platform, not the operator.';
revoke all on function app.console_decide_rating_dispute(uuid, app.rating_dispute_state, app.rating_dispute_ground, text) from public, anon;
grant execute on function app.console_decide_rating_dispute(uuid, app.rating_dispute_state, app.rating_dispute_ground, text) to authenticated;

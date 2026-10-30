-- 2902_site_plan_annotations.sql
-- B1 Places depth on image plans (RRR-225; gap G-18; ADR 0140 D5). Annotations reuse the one comment system (0580).
--
--   * Pins and shapes become comment subjects, so each takes threads with replies, @mention and Resolve, in every plan
--     state: a comment writes no pin.
--   * private.subject_row, from its only definition (0580), gives a pin or a shape its plan's project and a title (its
--     label, else the plan's title). Mentions and notifications then reach only people who can open the plan's project
--     (private.person_may_read_subject), never every member of the org.
--   * A note at a coordinate is an anchored thread on the plan. Its anchor has one form, 'point:<x>,<y>' with exactly four
--     decimals, so two clients never open two threads at one point; a reply to a resolved point thread reopens it.

insert into private.comment_subjects (table_name) values ('app.site_plan_pins'), ('app.site_plan_shapes') on conflict do nothing;

create or replace function private.subject_row(p_subject_table text, p_subject_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_row jsonb;
  v_plan jsonb;
begin
  if p_subject_table not in (select s.table_name from private.comment_subjects s) then
    return null;
  end if;
  execute format('select to_jsonb(t) from %s t where t.id = $1', p_subject_table) into v_row using p_subject_id;
  if p_subject_table = 'app.projects' and v_row is not null then
    v_row := v_row || jsonb_build_object('project_id', v_row -> 'id');
  end if;
  -- A pin or a shape is reached through its plan (B1, ADR 0140 D5): the plan's project and a title.
  if p_subject_table in ('app.site_plan_pins', 'app.site_plan_shapes') and v_row is not null then
    select jsonb_build_object('project_id', p.project_id, 'title', coalesce(nullif(v_row ->> 'label', ''), p.title))
    into v_plan from app.site_plans p where p.id = (v_row ->> 'site_plan_id')::uuid;
    v_row := v_row || coalesce(v_plan, '{}'::jsonb);
  end if;
  return v_row;
end;
$$;

comment on function private.subject_row(text, uuid) is 'The subject row as JSON, read with definer rights, for deriving its org, project and title inside triggers; a project subject carries its own id as project_id, and a site plan pin or shape carries its plan''s project and a title (ADR 0140 D5). Never returned to callers.';
revoke all on function private.subject_row(text, uuid) from public, anon, authenticated;

create or replace function private.guard_site_plan_anchor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.anchor !~ '^point:(0\.\d{4}|1\.0000),(0\.\d{4}|1\.0000)$' then
    perform private.refuse('site_plan_anchor', 'A note on a plan is anchored at a point written point:<across>,<down>, each 0.0000 to 1.0000.');
  end if;
  return new;
end;
$$;

comment on function private.guard_site_plan_anchor() is 'Before insert of an anchored comment thread on a site plan: the anchor is a point in the one canonical form point:x,y with four decimals (site_plan_anchor), so every client finds the same thread at a point.';
revoke all on function private.guard_site_plan_anchor() from public, anon, authenticated;
create trigger t12_guard_site_plan_anchor before insert on app.comment_threads
  for each row when (new.subject_table = 'app.site_plans' and new.anchor is not null)
  execute function private.guard_site_plan_anchor();

create or replace function private.reopen_site_plan_point_thread()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update app.comment_threads t set resolved_at = null
  where t.id = new.comment_thread_id and t.resolved_at is not null
    and t.subject_table = 'app.site_plans' and t.anchor like 'point:%';
  return null;
end;
$$;

comment on function private.reopen_site_plan_point_thread() is 'After insert of a comment: a reply to a resolved point note on a site plan reopens it, since app.post_comment reuses the one thread at a point (ADR 0140 D5).';
revoke all on function private.reopen_site_plan_point_thread() from public, anon, authenticated;
create trigger t61_reopen_site_plan_point_thread after insert on app.comments
  for each row execute function private.reopen_site_plan_point_thread();

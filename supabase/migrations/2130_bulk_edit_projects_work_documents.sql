-- 2130_bulk_edit_projects_work_documents.sql
-- A119 (RRR-164, A65-006, ADR 0078). Bulk edit (Section 11.7) reaches the Projects, Work orders, Punch lists and
-- Documents collections: four more resources on the driver of 1451, private.run_bulk, so each call keeps its rules.
-- All or nothing, a preview that always undoes, the capability checked on every row, refusals naming the row, the
-- inverse rows that undo a call, and one <resource>.bulk_update audit event per org.
--
--   * Projects: every row needs projects.project.write, as the update policy does. State goes through
--     app.transition_project (projects.settings.write, the active_projects plan limit on reopening), then the primary
--     venue, and archived_at needs projects.project.archive, as the project guard asks. archived_at takes true to
--     archive now, null to restore, or the time an undo puts back.
--   * Work orders: state through app.transition_work_order (work.work_order.write); Awarded stays with the award.
--   * Punch items: their Task record's state, owner and due time. Each row needs work.punch_list.write on the
--     item's project, as the punch item policies do, and then meets every rule of a record's bulk change: the row
--     goes through private.bulk_records_row, so the record's own write rule, lifecycle and replan log apply.
--   * Documents: the scope, a project of the org or org-wide (NULL). Moving one needs knowledge.document.write where
--     it is and where it goes, so no one moves a document out of reach of the people who could read it, or in.
--   * Row functions run with owner rights, so each checks the caller's capability on the row the way the table's
--     policies do, and every guard trigger still applies. The driver, its helpers and the 1451 row functions are not
--     redefined here.
--   * Work orders, punch items and projects gain the audit trail app.records has (1451), so each row change and its
--     undo reaches the ledger field by field; app.documents has had one since 0995.

-- Projects -----------------------------------------------------------------------------------------------------------

create or replace function private.bulk_projects_row(p_id uuid, p_set jsonb, p_expect jsonb, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old app.projects;
  v_new app.projects;
  v_state app.project_state;
  v_venue uuid;
  v_archived timestamptz;
  v_keys jsonb := p_set;
begin
  perform private.bulk_check_fields(p_set, p_expect, 'project_state,venue_id,archived_at');
  select * into v_old from app.projects p where p.id = p_id and p.deleted_at is null for update;
  if v_old.id is null
     or not (v_old.id in (select private.readable_project_ids())
             or v_old.org_id in (select private.oversight_org_ids('projects.project.read'))) then
    perform private.refuse('bulk_row_not_found', 'This row no longer exists or is not available to you.');
  end if;
  if v_old.id not in (select private.project_ids_with('projects.project.write')) then
    raise exception using errcode = '42501', message = 'projects.project.write is required on this project.';
  end if;
  perform private.bulk_check_expect(to_jsonb(v_old), p_expect);

  v_state := case when p_set ? 'project_state' then (p_set ->> 'project_state')::app.project_state else v_old.project_state end;
  v_venue := case when p_set ? 'venue_id' then (p_set ->> 'venue_id')::uuid else v_old.venue_id end;
  -- true archives now (a project already archived keeps its time), null restores, a time is what an undo puts back.
  v_archived := case
    when not p_set ? 'archived_at' then v_old.archived_at
    when jsonb_typeof(p_set -> 'archived_at') = 'boolean' and (p_set ->> 'archived_at')::boolean then coalesce(v_old.archived_at, now())
    when jsonb_typeof(p_set -> 'archived_at') in ('boolean', 'null') then null
    else (p_set ->> 'archived_at')::timestamptz
  end;
  if v_state = v_old.project_state and v_venue is not distinct from v_old.venue_id
     and v_archived is not distinct from v_old.archived_at then
    return jsonb_build_object('org_id', v_old.org_id, 'changed', false);
  end if;

  if v_archived is distinct from v_old.archived_at and not private.can_on_project(p_id, 'projects.project.archive') then
    raise exception using errcode = '42501', message = 'projects.project.archive is required to archive or restore this project.';
  end if;
  if v_venue is distinct from v_old.venue_id or v_archived is distinct from v_old.archived_at then
    update app.projects set venue_id = v_venue, archived_at = v_archived where id = p_id;
  end if;
  if v_state <> v_old.project_state then
    perform app.transition_project(p_id, v_old.project_state, v_state, coalesce(nullif(btrim(p_reason), ''), 'Changed in bulk.'));
  end if;

  select * into v_new from app.projects p where p.id = p_id;
  return jsonb_build_object('org_id', v_old.org_id, 'changed', true,
    'before', private.bulk_pick(to_jsonb(v_old), v_keys), 'after', private.bulk_pick(to_jsonb(v_new), v_keys));
end;
$$;

comment on function private.bulk_projects_row(uuid, jsonb, jsonb, text) is 'One project of a bulk change. Needs projects.project.write on the project as its update policy does, and then: state through app.transition_project (projects.settings.write), the primary venue, and archived_at (projects.project.archive): true archives now, null restores, a time puts back what an undo names.';
revoke all on function private.bulk_projects_row(uuid, jsonb, jsonb, text) from public, anon, authenticated;

-- Work orders --------------------------------------------------------------------------------------------------------

create or replace function private.bulk_work_orders_row(p_id uuid, p_set jsonb, p_expect jsonb, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old app.work_orders;
  v_new app.work_orders;
  v_state app.work_order_state;
begin
  perform private.bulk_check_fields(p_set, p_expect, 'work_order_state');
  select * into v_old from app.work_orders w where w.id = p_id and w.deleted_at is null for update;
  if v_old.id is null
     or not (v_old.project_id in (select private.project_ids_with('work.work_order.read'))
             or v_old.org_id in (select private.oversight_org_ids('work.work_order.read'))) then
    perform private.refuse('bulk_row_not_found', 'This row no longer exists or is not available to you.');
  end if;
  if v_old.project_id not in (select private.project_ids_with('work.work_order.write')) then
    raise exception using errcode = '42501', message = 'work.work_order.write is required on this work order''s project.';
  end if;
  perform private.bulk_check_expect(to_jsonb(v_old), p_expect);
  v_state := case when p_set ? 'work_order_state' then (p_set ->> 'work_order_state')::app.work_order_state else v_old.work_order_state end;
  if v_state = v_old.work_order_state then
    return jsonb_build_object('org_id', v_old.org_id, 'changed', false);
  end if;
  perform app.transition_work_order(p_id, v_old.work_order_state, v_state, coalesce(nullif(btrim(p_reason), ''), 'Changed in bulk.'));
  select * into v_new from app.work_orders w where w.id = p_id;
  return jsonb_build_object('org_id', v_old.org_id, 'changed', true,
    'before', jsonb_build_object('work_order_state', v_old.work_order_state),
    'after', jsonb_build_object('work_order_state', v_new.work_order_state));
end;
$$;

comment on function private.bulk_work_orders_row(uuid, jsonb, jsonb, text) is 'One work order of a bulk change: its state through app.transition_work_order, which needs work.work_order.write on the project and leaves Awarded to app.award_work_order.';
revoke all on function private.bulk_work_orders_row(uuid, jsonb, jsonb, text) from public, anon, authenticated;

-- Punch items --------------------------------------------------------------------------------------------------------

create or replace function private.bulk_punch_items_row(p_id uuid, p_set jsonb, p_expect jsonb, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_item app.punch_items;
  v_record app.records;
begin
  perform private.bulk_check_fields(p_set, p_expect, 'record_state,owner_party_id,due_at');
  select * into v_item from app.punch_items i where i.id = p_id and i.deleted_at is null;
  select * into v_record from app.records r where r.id = v_item.record_id and r.deleted_at is null;
  if v_record.id is null
     or not (coalesce(v_record.project_id in (select private.project_ids_with('work.record.read')), false)
             or v_record.id in (select private.my_record_ids('work.record.read'))
             or v_record.org_id in (select private.oversight_org_ids('work.record.read'))) then
    perform private.refuse('bulk_row_not_found', 'This row no longer exists or is not available to you.');
  end if;
  -- records.project_id is not null today; a NULL here must still refuse, never skip the check.
  if v_record.project_id is null or v_record.project_id not in (select private.project_ids_with('work.punch_list.write')) then
    raise exception using errcode = '42501', message = 'work.punch_list.write is required on this punch item''s project.';
  end if;
  -- The item's title, owner, due time and state are its record's (0410): the record's own bulk row applies them.
  return private.bulk_records_row(v_record.id, p_set, p_expect, p_reason);
end;
$$;

comment on function private.bulk_punch_items_row(uuid, jsonb, jsonb, text) is 'One punch item of a bulk change: its Task record''s state, owner or due time. Needs work.punch_list.write on the project, then every rule of private.bulk_records_row (work.record.write, the record lifecycle, replans).';
revoke all on function private.bulk_punch_items_row(uuid, jsonb, jsonb, text) from public, anon, authenticated;

-- Documents ----------------------------------------------------------------------------------------------------------

create or replace function private.bulk_documents_row(p_id uuid, p_set jsonb, p_expect jsonb, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old app.documents;
  v_new app.documents;
  v_project uuid;
begin
  perform private.bulk_check_fields(p_set, p_expect, 'project_id');
  select * into v_old from app.documents d where d.id = p_id and d.deleted_at is null for update;
  -- The policy's expression, split by scope: an org-wide document's NULL project_id would make the IN NULL, and a
  -- NULL condition skips the guard where a policy hides the row.
  if v_old.id is null
     or not (case when v_old.project_id is null
                  then v_old.org_id in (select private.orgs_with_capability('knowledge.document.read'))
                  else v_old.project_id in (select private.project_ids_with('knowledge.document.read')) end) then
    perform private.refuse('bulk_row_not_found', 'This row no longer exists or is not available to you.');
  end if;
  if not (case when v_old.project_id is null
               then v_old.org_id in (select private.orgs_with_capability('knowledge.document.write'))
               else v_old.project_id in (select private.project_ids_with('knowledge.document.write')) end) then
    raise exception using errcode = '42501', message = 'knowledge.document.write is required where this document is.';
  end if;
  perform private.bulk_check_expect(to_jsonb(v_old), p_expect);
  v_project := case when p_set ? 'project_id' then (p_set ->> 'project_id')::uuid else v_old.project_id end;
  if v_project is not distinct from v_old.project_id then
    return jsonb_build_object('org_id', v_old.org_id, 'changed', false);
  end if;
  if v_project is null and v_old.org_id not in (select private.orgs_with_capability('knowledge.document.write')) then
    raise exception using errcode = '42501', message = 'knowledge.document.write across the org is required to make a document org-wide.';
  end if;
  if v_project is not null and v_project not in (select private.project_ids_with('knowledge.document.write')) then
    raise exception using errcode = '42501', message = 'knowledge.document.write is required on the project it moves to.';
  end if;
  -- A project of another org is refused by the table's same-org reference check.
  update app.documents set project_id = v_project where id = p_id;
  select * into v_new from app.documents d where d.id = p_id;
  return jsonb_build_object('org_id', v_old.org_id, 'changed', true,
    'before', jsonb_build_object('project_id', v_old.project_id),
    'after', jsonb_build_object('project_id', v_new.project_id));
end;
$$;

comment on function private.bulk_documents_row(uuid, jsonb, jsonb, text) is 'One document of a bulk change: its scope, a project of the org or org-wide. Needs knowledge.document.write where the document is and where it moves.';
revoke all on function private.bulk_documents_row(uuid, jsonb, jsonb, text) from public, anon, authenticated;

insert into private.bulk_resources (resource, table_name, row_function) values
  ('projects', 'app.projects', 'private.bulk_projects_row'),
  ('work_orders', 'app.work_orders', 'private.bulk_work_orders_row'),
  ('punch_items', 'app.punch_items', 'private.bulk_punch_items_row'),
  ('documents', 'app.documents', 'private.bulk_documents_row');

-- App RPCs -----------------------------------------------------------------------------------------------------------

create or replace function app.bulk_update_projects(p_rows jsonb, p_preview boolean default false, p_reason text default null)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.run_bulk('projects', p_rows, coalesce(p_preview, false), p_reason);
$$;

comment on function app.bulk_update_projects(jsonb, boolean, text) is 'Changes projects in bulk in one transaction (Section 11.7): rows as [{id, set, expect}] with state, primary venue or archived_at (true archives, null restores). All or nothing, with the answer of app.bulk_update_records. p_preview checks without changing anything.';

create or replace function app.bulk_update_work_orders(p_rows jsonb, p_preview boolean default false, p_reason text default null)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.run_bulk('work_orders', p_rows, coalesce(p_preview, false), p_reason);
$$;

comment on function app.bulk_update_work_orders(jsonb, boolean, text) is 'Moves work orders to another state in bulk in one transaction (Section 11.7), every rule of a single move applying to each row, with the answer of app.bulk_update_records.';

create or replace function app.bulk_update_punch_items(p_rows jsonb, p_preview boolean default false, p_reason text default null)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.run_bulk('punch_items', p_rows, coalesce(p_preview, false), p_reason);
$$;

comment on function app.bulk_update_punch_items(jsonb, boolean, text) is 'Changes punch items in bulk in one transaction (Section 11.7): rows by punch item id with their record''s state, owner or due time. Needs work.punch_list.write on each item''s project; answers as app.bulk_update_records.';

create or replace function app.bulk_update_documents(p_rows jsonb, p_preview boolean default false, p_reason text default null)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.run_bulk('documents', p_rows, coalesce(p_preview, false), p_reason);
$$;

comment on function app.bulk_update_documents(jsonb, boolean, text) is 'Moves documents to a project or org-wide in bulk in one transaction (Section 11.7), with the answer of app.bulk_update_records.';

revoke all on function app.bulk_update_projects(jsonb, boolean, text) from public, anon;
revoke all on function app.bulk_update_work_orders(jsonb, boolean, text) from public, anon;
revoke all on function app.bulk_update_punch_items(jsonb, boolean, text) from public, anon;
revoke all on function app.bulk_update_documents(jsonb, boolean, text) from public, anon;
grant execute on function app.bulk_update_projects(jsonb, boolean, text) to authenticated, service_role;
grant execute on function app.bulk_update_work_orders(jsonb, boolean, text) to authenticated, service_role;
grant execute on function app.bulk_update_punch_items(jsonb, boolean, text) to authenticated, service_role;
grant execute on function app.bulk_update_documents(jsonb, boolean, text) to authenticated, service_role;

-- Each row change and its undo reaches the ledger field by field, as records' do (1451).
call private.install_audit_trail('app.projects');
call private.install_audit_trail('app.work_orders');
call private.install_audit_trail('app.punch_items');

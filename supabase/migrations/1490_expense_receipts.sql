-- 1490_expense_receipts.sql
-- A92 Compass receipt capture (RRR-137, A65-011 part 1, Section 4.3 item 11 "Expenses: receipt capture with OCR
-- prefill, posting to a budget line"). A person photographs a receipt in Compass (or picks one in the system photo
-- picker), Aurora reads it when the org has document extraction on, they confirm the fields, and the expense posts to
-- one budget line with the photo attached. The whole save is one offline write: the photo uploads to the field-media
-- bucket, then app.submit_expense_receipt files the expense and its receipt, replayed once through
-- app.apply_sync_mutation.
--
--   * app.expense_receipts: the receipt photo of an expense, with how it was taken and the AI suggestion whose fields
--     the person confirmed, when Aurora read it.
--   * field-media objects <org_id>/expense-receipts/<project_id>/<file name>: written with finance.expense.write on the
--     project, read with finance.expense.read or finance.expense.write there. Incident, inspection and kiosk punch
--     media keep their rules (0368, 1328), restated from 1328 below.
--   * app.submit_expense_receipt: files the expense (the 0321 guard sets the submitter, checks the budget currency and
--     refuses a closed production) and its receipt, idempotent on the device-minted expense id. When the person
--     confirmed an Aurora receipt extraction, its suggestion moves Proposed, Confirmed, Applied with the expense as the
--     record written, so the agent provenance of those fields is kept (Section 4.7).

-- Receipts -------------------------------------------------------------------------------------------------------------

create table app.expense_receipts (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  expense_id uuid not null references app.expenses (id),
  media_uri text not null,
  capture_source text not null default 'Camera',
  captured_at timestamptz,
  ai_suggestion_id uuid references app.ai_suggestions (id),
  constraint expense_receipts_capture_source check (capture_source in ('Camera', 'Photo Library')),
  constraint expense_receipts_media_uri_format check (media_uri ~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/expense-receipts/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]+$')
);

create unique index expense_receipts_media_uri_key on app.expense_receipts (media_uri);
create index expense_receipts_expense_id_idx on app.expense_receipts (expense_id);
create index expense_receipts_ai_suggestion_id_idx on app.expense_receipts (ai_suggestion_id);

call private.install_domain_table('app.expense_receipts', 'app.expenses', 'expense_id',
  array['app.ai_suggestions', 'ai_suggestion_id']);
call private.describe('app.expense_receipts', 'The receipt photo of an expense, filed from Compass with the expense (Section 4.3 item 11). Written only by app.submit_expense_receipt; readable by whoever can read the expense.', array[
  'expense_id', 'The expense the receipt belongs to.',
  'media_uri', 'Object name of the photo in the field-media bucket: <org_id>/expense-receipts/<project_id>/<file name>, the project of the expense''s budget line.',
  'capture_source', 'How the photo was taken: Camera (Compass''s camera) or Photo Library (one photo picked in the system picker).',
  'captured_at', 'When the photo was taken, by the device clock; null when unknown.',
  'ai_suggestion_id', 'The Aurora receipt extraction whose proposed fields the person confirmed, or null when they typed every field.'
]);

-- Readable with the expense: the 0321 expense read rule (finance.expense.read on the budget line, or the submitter).
-- The helper takes the expense id as its argument and never reads app.expense_receipts (ADR 0016 item 14).
create or replace function private.expense_readable(p_expense_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.expenses e
    where e.id = p_expense_id and e.deleted_at is null
      and (e.budget_line_id in (select private.budget_line_ids_with('finance.expense.read'))
        or e.submitter_person_id = private.current_person_id()));
$$;

comment on function private.expense_readable(uuid) is 'True when the signed-in person may read the expense: finance.expense.read on its budget line''s project, or they submitted it (the 0321 expense read rule). Policies on rows of an expense pass the expense id column.';
revoke all on function private.expense_readable(uuid) from public, anon;
grant execute on function private.expense_readable(uuid) to authenticated, service_role;

call private.install_policies('app.expense_receipts', 'private.expense_readable(expense_id)');

-- Field media ------------------------------------------------------------------------------------------------------------
-- From 1328 (the latest), with expense receipts added.

create or replace function private.field_media_subject(p_object_name text)
returns table (org_id uuid, kind text, subject_id uuid, project_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_parts text[] := storage.foldername(p_object_name);
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if coalesce(array_length(v_parts, 1), 0) <> 3 or v_parts[1] !~ v_uuid
     or v_parts[2] not in ('incidents', 'inspections', 'kiosk-punches', 'expense-receipts') or v_parts[3] !~ v_uuid then
    return;
  end if;
  if v_parts[2] = 'incidents' then
    return query select i.org_id, 'incidents'::text, i.id, i.project_id from app.incidents i
      where i.id = v_parts[3]::uuid and i.org_id = v_parts[1]::uuid and i.deleted_at is null;
  elsif v_parts[2] = 'inspections' then
    return query select i.org_id, 'inspections'::text, i.id, i.project_id from app.inspections i
      where i.id = v_parts[3]::uuid and i.org_id = v_parts[1]::uuid and i.deleted_at is null;
  else
    return query select p.org_id, v_parts[2], p.id, p.id from app.projects p
      where p.id = v_parts[3]::uuid and p.org_id = v_parts[1]::uuid and p.deleted_at is null;
  end if;
end;
$$;

comment on function private.field_media_subject(text) is 'The incident, inspection or project a field-media object name points to (<org_id>/incidents|inspections/<id>/<file name>; <org_id>/kiosk-punches/<project_id>/<file name> for kiosk punch photos, 1328; <org_id>/expense-receipts/<project_id>/<file name> for expense receipts, 1490), the id belonging to that org, with its project; no row for any other name.';

create or replace function private.field_media_allowed(p_object_name text, p_write boolean)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.field_media_subject(p_object_name) s
    where case
      when s.kind = 'kiosk-punches' then
        private.has_capability(s.org_id, 'org.time_attendance.write')
        or (not p_write and s.project_id in (select private.project_ids_with('crew.time_entry.read')))
      when s.kind = 'expense-receipts' then
        s.project_id in (select private.project_ids_with('finance.expense.write'))
        or (not p_write and s.project_id in (select private.project_ids_with('finance.expense.read')))
      else s.project_id in (select private.project_ids_with(
        case when s.kind = 'incidents' then case when p_write then 'safety.incident.write' else 'safety.incident.read' end
             else case when p_write then 'safety.inspection.write' else 'safety.inspection.read' end end))
    end);
$$;

comment on function private.field_media_allowed(text, boolean) is 'True when the signed-in person may write (upload) or read a field-media object: the incident or inspection capability on the subject''s project; for kiosk punch photos (1328), org.time_attendance.write to write or read and crew.time_entry.read on the project to read; for expense receipts (1490), finance.expense.write on the project to write or read and finance.expense.read there to read. Access never crosses orgs or projects.';

-- Filing --------------------------------------------------------------------------------------------------------------

create function app.submit_expense_receipt(
  p_id uuid,
  p_budget_line_id uuid,
  p_description text,
  p_amount_minor bigint,
  p_currency_code text,
  p_incurred_on date,
  p_media_uri text,
  p_capture_source text default 'Camera',
  p_captured_at timestamptz default null,
  p_ai_suggestion_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_uuid constant text := '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  v_line record;
  v_existing app.expenses;
  v_suggestion app.ai_suggestions;
  v_uri text := btrim(coalesce(p_media_uri, ''));
begin
  if p_id is null then
    perform private.refuse('expense_receipt_id_required', 'An expense filed from a device carries its own id.');
  end if;
  select bl.id, bl.org_id, b.project_id into v_line
  from app.budget_lines bl join app.budgets b on b.id = bl.budget_id
  where bl.id = p_budget_line_id and bl.deleted_at is null and b.deleted_at is null;
  if v_line.id is null or not private.can_on_project(v_line.project_id, 'finance.expense.write') then
    raise exception using errcode = '42501', message = 'finance.expense.write is required on the budget line''s project';
  end if;

  -- A replay of the same filing returns the expense it made; another person's or another line's id is refused.
  select * into v_existing from app.expenses e where e.id = p_id;
  if v_existing.id is not null then
    if v_existing.submitter_person_id is distinct from v_person or v_existing.budget_line_id <> p_budget_line_id then
      perform private.refuse('expense_receipt_id_taken', 'Another expense already uses this id.');
    end if;
    return v_existing.id;
  end if;

  if v_uri !~ ('^' || v_uuid || '/expense-receipts/' || v_uuid || '/[^/]+$')
     or split_part(v_uri, '/', 1)::uuid <> v_line.org_id or split_part(v_uri, '/', 3)::uuid <> v_line.project_id then
    perform private.refuse('expense_receipt_path',
      'The receipt photo is stored under the budget line''s org and project: <org_id>/expense-receipts/<project_id>/<file name>.');
  end if;

  if p_ai_suggestion_id is not null then
    select * into v_suggestion from app.ai_suggestions s where s.id = p_ai_suggestion_id and s.deleted_at is null;
    if v_suggestion.id is null or not private.ai_request_is_mine(v_suggestion.request_id)
       or v_suggestion.operation_id <> 'expenses.create' or v_suggestion.org_id <> v_line.org_id then
      perform private.refuse('expense_receipt_suggestion', 'The receipt names an AI suggestion that is not your receipt extraction.');
    end if;
  end if;

  insert into app.expenses (id, budget_line_id, description, incurred_on, amount_minor, currency_code)
  values (p_id, p_budget_line_id, btrim(coalesce(p_description, '')), p_incurred_on, p_amount_minor,
    upper(btrim(coalesce(p_currency_code, ''))));
  insert into app.expense_receipts (expense_id, media_uri, capture_source, captured_at, ai_suggestion_id)
  values (p_id, v_uri, coalesce(p_capture_source, 'Camera'), p_captured_at, p_ai_suggestion_id);

  -- The person confirmed the fields Aurora proposed (Section 4.7: a person confirms before anything is written), so a
  -- suggestion still waiting is confirmed and applied with this expense; an expired or decided one stays as it is.
  if v_suggestion.id is not null and v_suggestion.suggestion_state = 'Proposed' and v_suggestion.expires_at > now() then
    perform app.transition_ai_suggestion(v_suggestion.id, 'Proposed', 'Confirmed', 'Checked against the receipt in Compass.');
    perform app.transition_ai_suggestion(v_suggestion.id, 'Confirmed', 'Applied',
      'Written by expenses.create from Compass with the receipt.', p_id);
  end if;
  return p_id;
end;
$$;

comment on function app.submit_expense_receipt(uuid, uuid, text, bigint, text, date, text, text, timestamptz, uuid) is 'Files an expense against one budget line with its receipt photo (already stored in field-media under the line''s org and project) for a person with finance.expense.write on the project, from Compass online or offline. Idempotent on the device-minted expense id. When p_ai_suggestion_id names the caller''s Aurora receipt extraction, a Proposed suggestion is confirmed and applied with the expense.';
revoke all on function app.submit_expense_receipt(uuid, uuid, text, bigint, text, date, text, text, timestamptz, uuid) from public, anon;
grant execute on function app.submit_expense_receipt(uuid, uuid, text, bigint, text, date, text, text, timestamptz, uuid) to authenticated, service_role;

insert into private.sync_rpcs (rpc, description) values
  ('app.submit_expense_receipt', 'A person files an expense with its receipt photo from Compass, online or offline.');

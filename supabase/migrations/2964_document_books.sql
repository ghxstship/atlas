-- 2964_document_books.sql
-- B7 (RRR-231, ADR 0146 decision 4; gap G-54). A book compiles a project's show documents into one PDF with a cover
-- and contents: a Tour Book (dated days of day sheets, call sheets, runs of show, BEOs, inspections and incidents) or a
-- Production Book (the same, optionally over the whole project, plus the final cost report and the wrap-up report).
--
--   * app.document_books: one book of a project, read with show.run_of_show.read and written with show.day_sheet.write.
--     A Tour Book needs both dates; a Production Book gives both or neither (the whole project). Written only by
--     app.save_document_book; members update only deleted_at, to delete with undo, and Trash restores it.
--   * app.document_book_sections: the document kinds of a book in order, one row per kind. Written only by
--     app.save_document_book, which replaces them whole, so a book never holds a kind its kind does not allow
--     (no final cost report in a Tour Book) whatever a caller sends to PostgREST. Members hold update on
--     deleted_at only because app.restore_trash_item restores a book's rows as the caller; a guard refuses any
--     other change.
--   * Purchase orders, invoices, change orders, credential badges and agreement certificates are not section kinds
--     (ADR 0146 decision 4): they are commercial or personal records whose readers differ from the show crew's.
--   * Trash (ADR 0110): a deleted book is in Trash, titled by its name, with the default retention. Sections have no
--     title column and come back with their book.

create type app.document_book_kind as enum ('Tour Book', 'Production Book');
comment on type app.document_book_kind is 'What a document book compiles (ADR 0146 decision 4): a Tour Book for dated show days, or a Production Book for the whole project or a period, with its final cost report and wrap-up.';

create table app.document_books (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  name text not null,
  book_kind app.document_book_kind not null,
  starts_on date,
  ends_on date,
  deleted_at timestamptz,
  constraint document_books_name_format check (char_length(name) between 1 and 120 and name = btrim(name) and name !~ '[[:cntrl:]]'),
  constraint document_books_dates_order check (ends_on >= starts_on),
  constraint document_books_dates_pair check ((starts_on is null) = (ends_on is null)),
  constraint document_books_tour_dates check (book_kind <> 'Tour Book' or starts_on is not null)
);

create index document_books_project_id_idx on app.document_books (project_id);

call private.install_project_table('app.document_books', 'show.run_of_show.read', 'show.day_sheet.write');
call private.describe('app.document_books', 'A book of a project''s show documents compiled into one PDF with a cover and contents (ADR 0146 decision 4): a Tour Book of dated show days, or a Production Book of the whole project or a period with its final cost report and wrap-up report. Written by app.save_document_book; deleted to Trash.', array[
  'project_id', 'Project whose documents the book compiles.',
  'name', 'Book name, printed on its cover.',
  'book_kind', 'Tour Book or Production Book.',
  'starts_on', 'First day the book covers, in the project''s zone. Null with ends_on for the whole project.',
  'ends_on', 'Last day the book covers, in the project''s zone.'
]);
revoke insert, update on app.document_books from authenticated;
grant update (deleted_at) on app.document_books to authenticated;
call private.install_audit_trail('app.document_books');
call private.install_default_retention('app.document_books');

create table app.document_book_sections (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  book_id uuid not null references app.document_books (id),
  document_kind text not null,
  position integer not null,
  deleted_at timestamptz,
  constraint document_book_sections_kind check (document_kind in ('day-sheet', 'call-sheet', 'run-of-show', 'beo',
    'inspection-report', 'incident-report', 'final-cost-report', 'wrap-up-report')),
  constraint document_book_sections_position_positive check (position > 0)
);

create unique index document_book_sections_kind_key on app.document_book_sections (book_id, document_kind) where deleted_at is null;
create unique index document_book_sections_position_key on app.document_book_sections (book_id, position) where deleted_at is null;

call private.install_child_table('app.document_book_sections', 'app.document_books', 'book_id', 'show.run_of_show.read', 'show.day_sheet.write');
call private.describe('app.document_book_sections', 'The document kinds a book compiles, in order (ADR 0146 decision 4). Replaced whole by app.save_document_book.', array[
  'book_id', 'Book the section belongs to.',
  'document_kind', 'Document kind the section compiles: day-sheet, call-sheet, run-of-show, beo, inspection-report, incident-report, final-cost-report or wrap-up-report.',
  'position', 'Order of the section in the book, from 1.'
]);
revoke insert, update, delete on app.document_book_sections from authenticated;
-- app.restore_trash_item brings back a book's rows deleted with it as the caller, so members hold update on
-- deleted_at; the guard below lets them do nothing else with it.
grant update (deleted_at) on app.document_book_sections to authenticated;
call private.install_audit_trail('app.document_book_sections');

create or replace function private.guard_document_book_section()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind app.document_book_kind;
begin
  if private.in_trusted_operation('document_book_save') then
    return new;
  end if;
  select b.book_kind into v_kind from app.document_books b where b.id = new.book_id and b.deleted_at is null;
  if tg_op = 'UPDATE' and old.deleted_at is not null and new.deleted_at is null
     and (to_jsonb(new) - 'deleted_at' - 'updated_at' - 'updated_by') = (to_jsonb(old) - 'deleted_at' - 'updated_at' - 'updated_by')
     and v_kind is not null
     and not (v_kind = 'Tour Book' and new.document_kind in ('final-cost-report', 'wrap-up-report')) then
    return new;
  end if;
  perform private.refuse('document_book_sections', 'A book''s sections change only when the book is saved.');
  return new;
end;
$$;
comment on function private.guard_document_book_section() is 'Before update on app.document_book_sections: outside app.save_document_book (trusted operation document_book_save) a section may only come back from Trash with its live book, and never as a kind its book does not allow.';
revoke all on function private.guard_document_book_section() from public, anon, authenticated;
create trigger t40_guard_document_book_section before update on app.document_book_sections
  for each row execute function private.guard_document_book_section();
call private.install_default_retention('app.document_book_sections');

create or replace function app.save_document_book(
  p_book_id uuid,
  p_project_id uuid,
  p_name text,
  p_kind app.document_book_kind,
  p_starts_on date,
  p_ends_on date,
  p_sections text[])
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid := p_book_id;
  v_name text := btrim(p_name);
  v_sections text[] := coalesce(p_sections, '{}');
begin
  if p_project_id is null or not private.can_on_project(p_project_id, 'show.day_sheet.write') then
    raise exception using errcode = '42501', message = 'project not found';
  end if;
  if v_id is not null and not exists (
    select 1 from app.document_books b where b.id = v_id and b.project_id = p_project_id and b.deleted_at is null) then
    raise exception using errcode = '42501', message = 'document book not found';
  end if;
  if v_name is null or v_name = '' or char_length(v_name) > 120 or v_name ~ '[[:cntrl:]]' then
    perform private.refuse('document_book_name', 'Give the book a name of 1 to 120 characters.');
  end if;
  if cardinality(v_sections) = 0 or array_position(v_sections, null) is not null
     or cardinality(v_sections) <> (select count(distinct s) from unnest(v_sections) s)
     or exists (select 1 from unnest(v_sections) s where s not in ('day-sheet', 'call-sheet', 'run-of-show', 'beo',
       'inspection-report', 'incident-report', 'final-cost-report', 'wrap-up-report')) then
    perform private.refuse('document_book_sections', 'Choose at least one section, each once, from the kinds a book can hold.');
  end if;
  if p_kind = 'Tour Book' and (v_sections && array['final-cost-report', 'wrap-up-report']) then
    perform private.refuse('document_book_kind_sections', 'A Tour Book holds show-day documents. Put the final cost report and the wrap-up in a Production Book.');
  end if;
  if (p_starts_on is null) <> (p_ends_on is null) or p_ends_on < p_starts_on or (p_kind = 'Tour Book' and p_starts_on is null) then
    perform private.refuse('document_book_dates', 'A Tour Book needs a first and a last day, the last on or after the first. A Production Book takes both or neither.');
  end if;

  perform private.begin_trusted_operation('document_book_save');
  if v_id is null then
    insert into app.document_books (project_id, name, book_kind, starts_on, ends_on)
    values (p_project_id, v_name, p_kind, p_starts_on, p_ends_on)
    returning id into v_id;
  else
    update app.document_books set name = v_name, book_kind = p_kind, starts_on = p_starts_on, ends_on = p_ends_on
    where id = v_id;
  end if;

  update app.document_book_sections set deleted_at = now() where book_id = v_id and deleted_at is null;
  insert into app.document_book_sections (book_id, document_kind, position)
  select v_id, s, o::integer from unnest(v_sections) with ordinality as u(s, o);
  perform private.end_trusted_operation('document_book_save');
  return v_id;
end;
$$;
comment on function app.save_document_book(uuid, uuid, text, app.document_book_kind, date, date, text[]) is 'Creates a document book of a project (p_book_id null) or changes a live one, and replaces its sections in the order given; old sections are soft-deleted (ADR 0146 decision 4). Needs show.day_sheet.write on the project. Refuses document_book_name, document_book_sections (empty, repeated or unknown kinds), document_book_kind_sections (the final cost report or the wrap-up in a Tour Book) and document_book_dates.';
revoke all on function app.save_document_book(uuid, uuid, text, app.document_book_kind, date, date, text[]) from public, anon;
grant execute on function app.save_document_book(uuid, uuid, text, app.document_book_kind, date, date, text[]) to authenticated, service_role;

select private.sync_trash_tables();

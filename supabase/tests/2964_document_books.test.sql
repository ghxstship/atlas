-- pgTAP: migration 2964 (B7, RRR-231, ADR 0146 decision 4; G-54), document books. Row level security for reading and
-- writing, a cross-project and cross-org refusal, the sections replaced in order, the kind and date rules, the direct
-- writes PostgREST would allow refused, a deleted book in Trash and restored from it, and 2390's registry consistent.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select * from no_plan();

create temporary table k (key text primary key, id uuid, val text);
grant select, insert, update on k to public;

create function pg_temp.sections(p_book uuid) returns text
language sql as $$
  select string_agg(document_kind, ',' order by position) from app.document_book_sections where book_id = p_book and deleted_at is null
$$;

-- Saving --------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
insert into k (key, id) select 'tour', app.save_document_book(null, pg_temp.id('prj_a'), ' Summer tour book ', 'Tour Book', '2027-06-01', '2027-06-07',
  array['day-sheet', 'call-sheet', 'run-of-show']);
select is((select name from app.document_books where id = (select id from k where key = 'tour')), 'Summer tour book', 'a book is saved with a trimmed name');
select is(pg_temp.sections((select id from k where key = 'tour')), 'day-sheet,call-sheet,run-of-show', 'its sections keep the order given');
select lives_ok(format($$select app.save_document_book(%L, %L, 'Summer tour book', 'Tour Book', '2027-06-01', '2027-06-07',
  array['run-of-show', 'day-sheet', 'beo'])$$, (select id from k where key = 'tour'), pg_temp.id('prj_a')), 'a book''s sections are replaced');
select is(pg_temp.sections((select id from k where key = 'tour')), 'run-of-show,day-sheet,beo', 'in the new order');
select is((select count(*)::int from app.document_book_sections where book_id = (select id from k where key = 'tour') and deleted_at is not null), 3,
  'the old sections are soft-deleted');
insert into k (key, id) select 'production', app.save_document_book(null, pg_temp.id('prj_a'), 'Production book', 'Production Book', null, null,
  array['day-sheet', 'final-cost-report', 'wrap-up-report']);
select is((select starts_on from app.document_books where id = (select id from k where key = 'production')), null::date,
  'a Production Book may cover the whole project');

-- Refusals --------------------------------------------------------------------------------------------------------------------
select throws_ok(format($$select app.save_document_book(null, %L, 'Tour', 'Tour Book', '2027-06-01', '2027-06-02', array['day-sheet', 'final-cost-report'])$$,
  pg_temp.id('prj_a')), 'XR001', 'document_book_kind_sections: A Tour Book holds show-day documents. Put the final cost report and the wrap-up in a Production Book.',
  'a final cost report in a Tour Book is refused');
select throws_ok(format($$select app.save_document_book(null, %L, 'Tour', 'Tour Book', '2027-06-01', '2027-06-02', array['day-sheet', 'day-sheet'])$$,
  pg_temp.id('prj_a')), 'XR001', 'document_book_sections: Choose at least one section, each once, from the kinds a book can hold.', 'a repeated section is refused');
select throws_ok(format($$select app.save_document_book(null, %L, 'Tour', 'Tour Book', '2027-06-01', '2027-06-02', array['purchase-order'])$$,
  pg_temp.id('prj_a')), 'XR001', 'document_book_sections: Choose at least one section, each once, from the kinds a book can hold.', 'an unknown kind is refused');
select throws_ok(format($$select app.save_document_book(null, %L, 'Tour', 'Tour Book', '2027-06-01', '2027-06-02', array[]::text[])$$,
  pg_temp.id('prj_a')), 'XR001', null, 'an empty book is refused');
select throws_ok(format($$select app.save_document_book(null, %L, 'Tour', 'Tour Book', '2027-06-03', '2027-06-02', array['day-sheet'])$$,
  pg_temp.id('prj_a')), 'XR001', 'document_book_dates: A Tour Book needs a first and a last day, the last on or after the first. A Production Book takes both or neither.',
  'a last day before the first is refused');
select throws_ok(format($$select app.save_document_book(null, %L, 'Tour', 'Tour Book', null, null, array['day-sheet'])$$,
  pg_temp.id('prj_a')), 'XR001', null, 'a Tour Book without dates is refused');
select throws_ok(format($$select app.save_document_book(null, %L, 'Book', 'Production Book', '2027-06-01', null, array['day-sheet'])$$,
  pg_temp.id('prj_a')), 'XR001', null, 'a Production Book takes both dates or neither');
select throws_ok(format($$select app.save_document_book(null, %L, '  ', 'Production Book', null, null, array['day-sheet'])$$,
  pg_temp.id('prj_a')), 'XR001', null, 'a blank name is refused');
select throws_ok(format($$select app.save_document_book(%L, %L, 'Moved', 'Tour Book', '2027-06-01', '2027-06-02', array['day-sheet'])$$,
  (select id from k where key = 'tour'), pg_temp.id('prj_a2')), '42501', null, 'a book never moves to another project');

-- Direct writes are refused ---------------------------------------------------------------------------------------------------------
select throws_ok(format($$insert into app.document_books (project_id, name, book_kind) values (%L, 'Direct', 'Production Book')$$, pg_temp.id('prj_a')),
  '42501', null, 'a book is never inserted directly');
select throws_ok(format($$update app.document_books set name = 'Renamed' where id = %L$$, (select id from k where key = 'tour')),
  '42501', null, 'nor renamed directly');
select throws_ok(format($$insert into app.document_book_sections (book_id, document_kind, position) values (%L, 'final-cost-report', 9)$$,
  (select id from k where key = 'tour')), '42501', null, 'a final cost report cannot be slipped into a Tour Book through PostgREST');
select throws_ok(format($$update app.document_book_sections set document_kind = 'final-cost-report' where book_id = %L$$, (select id from k where key = 'tour')),
  '42501', null, 'nor a section changed directly');
select throws_ok(format($$update app.document_book_sections set deleted_at = now() where book_id = %L and deleted_at is null$$, (select id from k where key = 'tour')),
  'XR001', 'document_book_sections: A book''s sections change only when the book is saved.', 'nor a section soft-deleted directly');
select throws_ok(format($$delete from app.document_book_sections where book_id = %L$$, (select id from k where key = 'tour')),
  '42501', null, 'nor a section deleted');
select throws_ok(format($$update app.document_book_sections set deleted_at = null where book_id = %L and deleted_at is not null and document_kind = 'call-sheet'$$,
  (select id from k where key = 'tour')), 'XR001', 'document_book_sections: A book''s sections change only when the book is saved.',
  'nor a section the last save replaced brought back');

-- Reading -------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select is((select count(*)::int from app.document_books where project_id = pg_temp.id('prj_a')), 2, 'a reader of the run of show reads the project''s books');
select is((select count(*)::int from app.document_book_sections s join app.document_books b on b.id = s.book_id where s.deleted_at is null), 6,
  'and their sections');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.document_books), 0, 'a reader outside the project reads none');
select throws_ok(format($$select app.save_document_book(null, %L, 'Mine', 'Production Book', null, null, array['day-sheet'])$$, pg_temp.id('prj_a')),
  '42501', 'project not found', 'nor saves one');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.document_books), 0, 'another org reads none');
select throws_ok(format($$select app.save_document_book(%L, %L, 'Taken', 'Production Book', null, null, array['day-sheet'])$$,
  (select id from k where key = 'tour'), pg_temp.id('prj_b')), '42501', null, 'nor saves into one of them from its own project');

-- Delete with undo and Trash (ADR 0110) ----------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
update app.document_books set deleted_at = now() where id = (select id from k where key = 'production');
select is((select count(*)::int from app.document_books where deleted_at is null), 1, 'a writer deletes a book');
select is((select count(*)::int from app.trash_items where subject_table = 'document_books' and subject_id = (select id from k where key = 'production')), 1,
  'the deleted book is in Trash');
select is((select title from app.trash_items where subject_id = (select id from k where key = 'production')), 'Production book', 'titled by its name');
select is(app.restore_trash_item('document_books', (select id from k where key = 'production')), 1, 'and restores from there');
select is(pg_temp.sections((select id from k where key = 'production')), 'day-sheet,final-cost-report,wrap-up-report', 'with its sections');
update app.document_books set deleted_at = now() where id = (select id from k where key = 'production');
update app.document_books set deleted_at = null where id = (select id from k where key = 'production');
select is((select count(*)::int from app.document_books where deleted_at is null), 2, 'undo restores it in place');

select pg_temp.as_platform();
select ok(exists (select 1 from private.trash_tables where table_name = 'document_books' and title_column = 'name'), 'document_books is in Trash, titled by name');
select ok(not exists (select 1 from private.trash_tables where table_name = 'document_book_sections'), 'sections have no title and are not');
select ok(exists (select 1 from private.retention_policies where table_name = 'app.document_books' and basis = 'Soft Deleted' and purge_method = 'Delete'),
  'books carry the default retention');
select ok(exists (select 1 from private.retention_policies where table_name = 'app.document_book_sections'), 'and so do their sections');
select is(private.sync_trash_tables(), 0, 'the sync has nothing left to add (2390)');

select * from finish();
rollback;

-- pgTAP: a Document record's text (B15, RRR-239, migration 3045). The body is nullable and runs 1 to 100,000 characters.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select no_plan();

select has_column('app', 'record_document', 'body', 'a Document record has a body');
select col_is_null('app', 'record_document', 'body', 'it is optional');
select col_type_is('app', 'record_document', 'body', 'text', 'it is text');
select ok(pg_get_constraintdef((select oid from pg_constraint where conname = 'record_document_body_length')) ~ '100000', 'it holds at most 100,000 characters');
select ok(pg_get_constraintdef((select oid from pg_constraint where conname = 'record_document_body_length')) ~ 'btrim', 'and is not blank');

select * from finish();
rollback;

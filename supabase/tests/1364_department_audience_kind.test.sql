-- pgTAP: the Department audience kind and the columns that key it by canon department (A80, RRR-125, A65-021).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(5);

select ok('Department' = any (enum_range(null::app.audience_kind)::text[]), 'app.audience_kind has Department');
select col_type_is('app', 'feed_posts', 'department_code', 'text', 'feed posts carry the department of a Department audience');
select fk_ok('app', 'feed_posts', 'department_code', 'xpms', 'dim_department', 'dept_code', 'keyed by canon department code');
select col_type_is('app', 'groups', 'department_code', 'text', 'Department groups name their canon department');
select col_has_check('app', 'groups', array['department_code', 'group_kind'], 'only Department groups name a department');

select * from finish();
rollback;

-- pgTAP: migration 4664 (R6a, ADR 0102 decision 2), what stays after uniform sizes and travel preferences left the
-- profile. R6a's one-time move and the ten profile columns it emptied are gone since R6b (904110101, whose test covers
-- the dropped columns): what remains here is R6a's sharing rules. Uniform Sizes cannot be shared, no live share names
-- it, Contact is never shared alone, and a person's own dietary details still save.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(8);

-- Fixture: Ivy's details and a share of her dietary needs ---------------------------------------------------------------------
select pg_temp.as_user('ivy');
select app.ensure_my_work_details();
select app.give_sensitive_consent('Dietary and Allergies', '2026-11-06', 'en-US', 'Atlas');
select app.share_work_details(pg_temp.id('eng_ivy_a'), '{Dietary Needs}');
select pg_temp.as_platform();
insert into world select 'share_ivy', s.id from app.work_detail_shares s
where s.engagement_id = pg_temp.id('eng_ivy_a') and s.revoked_at is null and s.deleted_at is null;

-- Shares -------------------------------------------------------------------------------------------------------------------------
select ok(exists (select 1 from pg_constraint where conname = 'work_detail_shares_no_retired_category'
  and conrelid = 'app.work_detail_shares'::regclass), 'the constraint work_detail_shares_no_retired_category exists');
select throws_ok(format($$update app.work_detail_shares set categories = '{Uniform Sizes,Dietary Needs}' where id = %L$$, pg_temp.id('share_ivy')),
  '23514', null, 'no live share names Uniform Sizes');
select ok(exists (select 1 from pg_constraint where conname = 'work_detail_shares_contact_not_alone'
  and conrelid = 'app.work_detail_shares'::regclass), 'the constraint work_detail_shares_contact_not_alone exists');
select throws_ok(format($$update app.work_detail_shares set categories = '{Contact}' where id = %L$$, pg_temp.id('share_ivy')),
  '23514', null, 'no live share names Contact alone');

-- The person -----------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
select lives_ok($$update app.person_work_details set dietary_needs = '{Vegan,Halal}'
  where person_id = (select id from world where key = 'ivy')$$, 'a person''s own dietary details still save');
select throws_like(format($$select app.share_work_details(%L, '{Uniform Sizes,Dietary Needs}')$$, pg_temp.id('eng_ivy_a')),
  'work_detail_category_retired:%', 'sharing Uniform Sizes is refused');
select throws_like(format($$select app.share_work_details(%L, '{Contact}')$$, pg_temp.id('eng_ivy_a')),
  'work_detail_share_contact_alone:%', 'Contact alone is refused: API v1 lists at least one other category beside it');
select lives_ok(format($$select app.share_work_details(%L, '{Contact,Dietary Needs}')$$, pg_temp.id('eng_ivy_a')),
  'Contact with another category is shared');
select pg_temp.as_platform();

select * from finish();
rollback;

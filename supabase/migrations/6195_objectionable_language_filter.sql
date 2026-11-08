-- 6195_objectionable_language_filter.sql
-- App Store Review Guideline 1.2 and Google Play's user-generated content policy ask for a way to filter objectionable
-- material out of what people post. Reporting and blocking exist (1206, 1207, 1630, 1631); this migration adds the
-- filter, in the database so Compass, Atlas, Gateway, the API and imports meet the same rule:
--   * private.objectionable_terms: the term list, slurs only. Its source is packages/data/src/objectionable-terms.ts,
--     loaded here through private.load_objectionable_terms; a change to the list is a new migration that loads the
--     file again (pnpm --filter @xos/data content-filter:migration), and the content filter test fails while the
--     newest load differs from the file.
--   * private.content_filter_normal_form folds case, accents and the digits and symbols that stand for letters, and
--     turns every other run of characters into one space; @xos/data/content-filter folds the same characters, so
--     Compass can warn before it queues a message. A term matches whole words with an optional plural ending.
--   * private.refuse_objectionable_text, a trigger on the text other people read: feed posts and their poll options,
--     comments, chat messages, shout-outs, engagement and party threads and their messages, ratings and replies to
--     them, marketplace listings, and person and organization profiles. It refuses the write with a plain sentence
--     (content_objectionable) and never alters the text. An update is checked only when the text itself changes, so
--     a later term never blocks other changes to an older row.
-- No row records what was refused: the text never reaches the database, and the person sees the refusal at once.

create table private.objectionable_terms (
  term text primary key,
  language text not null,
  constraint objectionable_terms_normal_form check (term ~ '^[a-z]+( [a-z]+)*$'),
  constraint objectionable_terms_language check (language in ('en', 'es'))
);

comment on table private.objectionable_terms is 'The objectionable language filter''s terms (App Store Review Guideline 1.2), in their normal form. Loaded from packages/data/src/objectionable-terms.ts by private.load_objectionable_terms; never edited by hand.';
comment on column private.objectionable_terms.term is 'A slur in its normal form: lowercase a to z, words separated by one space.';
comment on column private.objectionable_terms.language is 'en or es, the languages XOS ships in.';

alter table private.objectionable_terms enable row level security;
revoke all on private.objectionable_terms from public, anon, authenticated;
grant select on private.objectionable_terms to service_role;

create or replace function private.load_objectionable_terms(p_terms jsonb)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if jsonb_typeof(p_terms) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'the objectionable terms are a JSON array';
  end if;
  delete from private.objectionable_terms where true;
  insert into private.objectionable_terms (term, language)
  select x ->> 'term', x ->> 'language' from jsonb_array_elements(p_terms) x;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function private.load_objectionable_terms(jsonb) is 'Replaces the objectionable language filter''s terms with a JSON array of {term, language}, the contents of packages/data/src/objectionable-terms.ts. Called only by migrations. Returns how many terms were loaded.';
revoke all on function private.load_objectionable_terms(jsonb) from public, anon, authenticated;

create or replace function private.content_filter_normal_form(p_text text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select ' ' || btrim(regexp_replace(lower(translate(coalesce(p_text, ''),
    'ÁÀÄÂÃÅÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇáàäâãåéèëêíìïîóòöôõúùüûñç013457@$',
    'aaaaaaeeeeiiiiooooouuuuncaaaaaaeeeeiiiiooooouuuuncoieastas')), '[^a-z]+', ' ', 'g')) || ' ';
$$;

comment on function private.content_filter_normal_form(text) is 'Text in the objectionable language filter''s normal form: accents and the digits and symbols that stand for letters folded, lowercase a to z, every other run of characters one space, a space at each end. @xos/data/content-filter folds the same characters.';
revoke all on function private.content_filter_normal_form(text) from public, anon;
grant execute on function private.content_filter_normal_form(text) to authenticated, service_role;

create or replace function private.objectionable_term(p_text text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select (regexp_match(private.content_filter_normal_form(p_text), ' (' || string_agg(t.term, '|') || ')(s|es|z)? '))[1]
  from private.objectionable_terms t
  where nullif(btrim(p_text), '') is not null;
$$;

comment on function private.objectionable_term(text) is 'The listed term a text holds, as whole words with an optional plural ending (s, es or z), after folding to the normal form; null when it holds none.';
revoke all on function private.objectionable_term(text) from public, anon;
grant execute on function private.objectionable_term(text) to authenticated, service_role;

create or replace function private.refuse_objectionable_text()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new jsonb := to_jsonb(new);
  v_old jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) end;
  v_column text;
begin
  foreach v_column in array tg_argv loop
    if (tg_op = 'INSERT' or (v_new ->> v_column) is distinct from (v_old ->> v_column))
       and private.objectionable_term(v_new ->> v_column) is not null then
      perform private.refuse('content_objectionable',
        'This contains language that is not allowed here. Change the wording and try again.');
    end if;
  end loop;
  return new;
end;
$$;

comment on function private.refuse_objectionable_text() is 'Before insert or update trigger: refuses the row (content_objectionable) when a text column named in the trigger arguments holds a listed term (private.objectionable_term). On update only a column whose text changed is checked. Never alters the text.';
revoke all on function private.refuse_objectionable_text() from public, anon, authenticated;

-- Where other people read what a person wrote ---------------------------------------------------------------------------

create trigger t36_refuse_objectionable_text before insert or update of title, body on app.feed_posts
  for each row execute function private.refuse_objectionable_text('title', 'body');
create trigger t36_refuse_objectionable_text before insert or update of label on app.poll_options
  for each row execute function private.refuse_objectionable_text('label');
create trigger t36_refuse_objectionable_text before insert or update of body on app.comments
  for each row execute function private.refuse_objectionable_text('body');
create trigger t36_refuse_objectionable_text before insert or update of body on app.chat_messages
  for each row execute function private.refuse_objectionable_text('body');
create trigger t36_refuse_objectionable_text before insert or update of message on app.recognitions
  for each row execute function private.refuse_objectionable_text('message');
create trigger t36_refuse_objectionable_text before insert or update of subject on app.engagement_threads
  for each row execute function private.refuse_objectionable_text('subject');
create trigger t36_refuse_objectionable_text before insert or update of body on app.engagement_messages
  for each row execute function private.refuse_objectionable_text('body');
create trigger t36_refuse_objectionable_text before insert or update of subject on app.party_threads
  for each row execute function private.refuse_objectionable_text('subject');
create trigger t36_refuse_objectionable_text before insert or update of body on app.party_messages
  for each row execute function private.refuse_objectionable_text('body');
create trigger t36_refuse_objectionable_text before insert or update of comment on app.ratings
  for each row execute function private.refuse_objectionable_text('comment');
create trigger t36_refuse_objectionable_text before insert or update of body on app.rating_replies
  for each row execute function private.refuse_objectionable_text('body');
create trigger t36_refuse_objectionable_text before insert or update of title, description on app.opportunities
  for each row execute function private.refuse_objectionable_text('title', 'description');
create trigger t36_refuse_objectionable_text
  before insert or update of handle, preferred_name, pronouns, headline, bio on app.person_profiles
  for each row execute function private.refuse_objectionable_text('handle', 'preferred_name', 'pronouns', 'headline', 'bio');
create trigger t36_refuse_objectionable_text before insert or update of handle, about on app.organization_profiles
  for each row execute function private.refuse_objectionable_text('handle', 'about');

-- The list ---------------------------------------------------------------------------------------------------------------
-- objectionable-terms: generated from packages/data/src/objectionable-terms.ts; do not edit by hand.
select private.load_objectionable_terms($terms$[
  {"term":"beaner","language":"en"},
  {"term":"cunt","language":"en"},
  {"term":"dyke","language":"en"},
  {"term":"fag","language":"en"},
  {"term":"faggot","language":"en"},
  {"term":"gook","language":"en"},
  {"term":"heil hitler","language":"en"},
  {"term":"jigaboo","language":"en"},
  {"term":"kike","language":"en"},
  {"term":"nigga","language":"en"},
  {"term":"nigger","language":"en"},
  {"term":"paki","language":"en"},
  {"term":"porch monkey","language":"en"},
  {"term":"raghead","language":"en"},
  {"term":"retard","language":"en"},
  {"term":"shemale","language":"en"},
  {"term":"sieg heil","language":"en"},
  {"term":"spic","language":"en"},
  {"term":"towelhead","language":"en"},
  {"term":"wetback","language":"en"},
  {"term":"joto","language":"es"},
  {"term":"marica","language":"es"},
  {"term":"maricon","language":"es"},
  {"term":"mayate","language":"es"},
  {"term":"negrata","language":"es"},
  {"term":"sudaca","language":"es"}
]$terms$::jsonb);

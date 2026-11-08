-- pgTAP: migration 6195, the objectionable language filter (App Store Review Guideline 1.2, Google Play's user-generated
-- content policy). The text other people read is refused, with a plain sentence and the rule content_objectionable,
-- when it holds a listed slur, folded for case, accents and stand-in digits and symbols, as whole words with a plural
-- ending. Words that only contain a term pass, and so do names and phrases that are also slurs, which stay off the
-- list. A handle XOS makes from a name never holds a term, so a profile it creates is never refused. An update is
-- checked only when the text changes, and the list is the one in packages/data/src/objectionable-terms.ts (the content
-- filter unit test holds the two together).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(43);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

-- The list and the folding -------------------------------------------------------------------------------------------
select ok((select count(*) >= 15 from private.objectionable_terms), 'the term list is loaded');
select is((select count(*)::int from private.objectionable_terms where term !~ '^[a-z]+( [a-z]+)*$'), 0,
  'every term is in its normal form');
select is(private.content_filter_normal_form('  Maricón '), ' maricon ', 'accents fold');
select is(private.content_filter_normal_form('N1GG3R'), ' nigger ', 'stand-in digits fold, case folds');
select is(private.content_filter_normal_form('$p1c'), ' spic ', 'stand-in symbols fold');
select is(private.content_filter_normal_form('f@g_bot'), ' fag bot ', 'other characters separate words');
select is(private.content_filter_normal_form('ÉCOLE Ñandú'), ' ecole nandu ', 'capital accents fold too');

select is(private.objectionable_term('You are a faggot'), 'faggot', 'a term is found as a word');
select is(private.objectionable_term('those F4GS again'), 'fag', 'with a plural ending, through stand-ins');
select is(private.objectionable_term('Sieg   Heil!'), 'sieg heil', 'a phrase across spacing and punctuation');
select is(private.objectionable_term('son unos maricones'), 'maricon', 'a Spanish term with its plural');
select is((select count(*)::int from (values ('Scunthorpe crew call at 7'), ('Add spice to the catering order'),
            ('Flame retardant drapes only'), ('Fagan brought the riggers'), ('Pakistan tour dates'),
            ('Heil is not a word here; Hitler is history'), (''), ('   '), (null)) v(t)
           where private.objectionable_term(t) is not null), 0,
  'words that only contain a term, and empty text, pass');
select is((select count(*)::int from (values ('Kike Ramírez runs the dock'), ('Dick Van Dyke tribute night'),
            ('Spic and Span cleaning crew'), ('Retard the ignition timing'), ('Paki Kahananui on follow spot'),
            ('Wipe the gook off the lens'), ('Un mayate en la carpa'), ('Marica Novak, stagehand')) v(t)
           where private.objectionable_term(t) is not null), 0,
  'names, nicknames, surnames, brands and everyday words that are also slurs pass');

-- Where it applies ---------------------------------------------------------------------------------------------------
select is((select count(*)::int from pg_catalog.pg_trigger
           where tgname = 't36_refuse_objectionable_text' and not tgisinternal
             and tgrelid in ('app.feed_posts'::regclass, 'app.poll_options'::regclass, 'app.comments'::regclass,
               'app.chat_messages'::regclass, 'app.recognitions'::regclass, 'app.engagement_threads'::regclass,
               'app.engagement_messages'::regclass, 'app.party_threads'::regclass, 'app.party_messages'::regclass,
               'app.ratings'::regclass, 'app.rating_replies'::regclass, 'app.opportunities'::regclass,
               'app.person_profiles'::regclass, 'app.organization_profiles'::regclass)), 14,
  'the filter guards posts, poll options, comments, messages, shout-outs, threads, ratings, listings and profiles');

-- Feed posts and comments ----------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok($$select app.create_feed_post(pg_temp.id('org_a'), 'Update', 'The new guy is a f4ggot.')$$,
  'XR001', 'content_objectionable: This contains language that is not allowed here. Change the wording and try again.',
  'a post with a slur is refused with a plain sentence');
select throws_ok($$select app.create_feed_post(pg_temp.id('org_a'), 'Update', 'Crew notes', p_title => 'Wetbacks on the deck')$$,
  'XR001', null, 'and so is its title');
select lives_ok($$insert into k select 'post', app.create_feed_post(pg_temp.id('org_a'), 'Update', 'Add spice to the catering order.')$$,
  'a post without one is posted');
select is((select body from app.feed_posts where id = (select id from k where key = 'post')), 'Add spice to the catering order.',
  'as written');
select pg_temp.as_platform();
select throws_ok($$update app.feed_posts set body = 'Edited: what a towelhead.' where id = (select id from k where key = 'post')$$,
  'XR001', null, 'an edit that adds a slur is refused');

select pg_temp.as_user('dave');
select throws_ok($$select app.post_comment('app.feed_posts', (select id from k where key = 'post'), 'Ok, n1gga.', '{}', null)$$,
  'XR001', null, 'a comment with a slur is refused');
select lives_ok($$insert into k select 'comment', app.post_comment('app.feed_posts', (select id from k where key = 'post'), 'Cumin too.', '{}', null)$$,
  'a comment without one is posted');

-- Chat messages and shout-outs ----------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into k select 'dm', app.start_direct_conversation(pg_temp.id('org_a'), pg_temp.id('dave@org_a'));
select throws_ok($$select app.send_chat_message((select id from k where key = 'dm'), 'Shut up, beaner.')$$,
  'XR001', null, 'a message with a slur is refused');
select throws_ok($$select app.send_chat_message((select id from k where key = 'dm'), 'SIEG HEIL')$$,
  'XR001', null, 'a hate phrase in capitals is refused');
select lives_ok($$insert into k select 'msg', app.send_chat_message((select id from k where key = 'dm'), 'Meet at the Scunthorpe stage.')$$,
  'a message that only contains a term in a longer word is sent');
select throws_ok($$select app.edit_chat_message((select id from k where key = 'msg'), 'Meet me, maricón.')$$,
  'XR001', null, 'editing a message into a slur is refused');
select throws_ok($$select app.recognize(pg_temp.id('org_a'), pg_temp.id('dave@org_a'), 'Thanks, you sudaca.')$$,
  'XR001', null, 'a shout-out with a slur is refused');
select lives_ok($$select app.recognize(pg_temp.id('org_a'), pg_temp.id('dave@org_a'), 'Thanks for covering my shift.')$$,
  'a shout-out without one is sent');

-- Profiles, and writes the platform makes -------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select app.ensure_organization_profile(pg_temp.id('org_a'));
select pg_temp.as_platform();
select throws_ok($$update app.organization_profiles set about = 'No ragheads.' where org_id = pg_temp.id('org_a')$$,
  'XR001', null, 'an organization profile''s about text with a slur is refused, whoever writes it');
select throws_ok($$insert into app.chat_messages (conversation_id, author_membership_id, body)
  values ((select id from k where key = 'dm'), pg_temp.id('carol@org_a'), 'wetback')$$,
  'XR001', null, 'the service role is held to the same rule');

-- Handles XOS makes from a name ------------------------------------------------------------------------------------------
-- A long name is cut to 30 characters for its handle, and this one is cut inside a word, leaving a listed term. The
-- person never typed that handle, so their profile is still created, with a neutral one.
select pg_temp.new_user('max', 'max@crew.test', 'Maximiliano Bartholomew Al Fagundes');
select pg_temp.new_user('kike', 'kike@crew.test', 'Kike Ramírez');
select pg_temp.as_user('max');
select lives_ok($$select app.ensure_my_profile()$$, 'a profile is created when the handle made from the name would hold a term');
select matches((select handle from app.person_profiles where person_id = pg_temp.id('max')), '^member(-[0-9]{4})?$',
  'with a neutral handle instead');
select pg_temp.as_user('kike');
select lives_ok($$select app.ensure_my_profile()$$, 'a profile is created for a name that only looks like a slur');
select is((select handle from app.person_profiles where person_id = pg_temp.id('kike')), 'kike-ram-rez',
  'with the handle made from the name');
select lives_ok($$update app.person_profiles set preferred_name = 'Kike', headline = 'Van Dyke''s crew lead'
  where person_id = pg_temp.id('kike')$$, 'and the person can use their own name');
select pg_temp.as_user('xavier');
insert into k select 'org_long', app.create_organization('Al Fagundes Audio', 'maximiliano-bartholomew-al-fagundes');
select lives_ok($$select app.ensure_organization_profile((select id from k where key = 'org_long'))$$,
  'an organization profile is created when the handle made from its slug would hold a term');
select matches((select handle from app.organization_profiles where org_id = (select id from k where key = 'org_long')),
  '^company(-[0-9]{4})?$', 'with a neutral handle instead');
select pg_temp.as_platform();
select matches(private.suggest_handle('Person', 'Wetback'), '^member(-[0-9]{4})?$', 'a name that is a term gives the neutral handle');

-- A later term never blocks other changes to an older row ------------------------------------------------------------------
insert into private.objectionable_terms (term, language) values ('cumin', 'en');
select is(private.objectionable_term('cumin too'), 'cumin', 'a term added later is found');
select lives_ok($$update app.comments set edited_at = now() where id = (select id from k where key = 'comment')$$,
  'an update that leaves the text alone is not checked again');
select throws_ok($$update app.comments set body = 'More cumin.' where id = (select id from k where key = 'comment')$$,
  'XR001', null, 'an update to the text is');
select is((select body from app.comments where id = (select id from k where key = 'comment')), 'Cumin too.',
  'and the text is never altered');

-- Loading the list ---------------------------------------------------------------------------------------------------
select is(private.load_objectionable_terms('[{"term": "first", "language": "en"}, {"term": "second", "language": "es"}]'), 2,
  'loading a list replaces the terms');
select is((select array_agg(term order by term) from private.objectionable_terms), array['first', 'second'],
  'with exactly the loaded ones');

select * from finish();
rollback;

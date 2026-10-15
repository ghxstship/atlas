-- pgTAP: the unified comment system (Section 7.3): access follows the subject's read policy (invariant 2),
-- mentions and subscriptions notify, edits keep versions, deletes are soft, events and audit are written,
-- and verified email replies post as comments.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(35);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

-- Posting and access ---------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
insert into k values ('c1', app.post_comment('app.projects', pg_temp.id('prj_a'), 'Load-in moves to 07:00.', array[pg_temp.id('erin')]));
select is((select org_id from app.comment_threads), pg_temp.id('org_a'), 'a thread takes the org of its subject');
select is((select author_person_id from app.comments where id = (select id from k where key = 'c1')), pg_temp.id('dave'),
  'the author comes from the session');
select throws_ok($$select app.post_comment('app.projects', pg_temp.id('prj_a2'), 'Not my project.')$$, '42501', null,
  'nobody comments on a subject they cannot read');
select throws_ok($$select app.post_comment('app.audit_events', gen_random_uuid(), 'No.')$$, '42501', null,
  'only commentable subjects take comments');
select throws_ok($$select app.post_comment('app.projects', pg_temp.id('prj_a'), 'Hey', array[pg_temp.id('gina')])$$, 'XR001', null,
  'only people who can open the subject can be mentioned');
select throws_ok($$select app.post_comment('app.projects', pg_temp.id('prj_a'), '   ')$$, '23514', null, 'a comment has text');
select throws_ok($$insert into app.comments (comment_thread_id, author_person_id, body, source)
  values ((select id from app.comment_threads), pg_temp.id('dave'), 'Spoofed', 'Email')$$, 'XR001', null,
  'email comments arrive only through verified replies');

select pg_temp.as_user('erin');
select is((select count(*)::integer from app.comments), 1, 'another member of the project reads the comment');
select is((select count(*)::integer from app.comment_mentions where mentioned_person_id = pg_temp.id('erin')), 1, 'and sees the mention');
select is((select count(*)::integer from app.notifications where kind = 'mention.created'), 1, 'a mention notifies the person mentioned');
select is((select subscribed from app.thread_subscriptions), true, 'a mention subscribes the person to the thread');
select pg_temp.as_user('gina');
select is((select count(*)::integer from app.comments) + (select count(*)::integer from app.comment_threads), 0,
  'a member who cannot read the project reads none of its comments (invariant 2)');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.comments), 0, 'no cross-tenant comment reads');
select pg_temp.as_user('bob');
select is((select count(*)::integer from app.comments), 1, 'an overseer of every project reads it');

-- Subscribers are notified at commit, without double notices ------------------------------------------------------
select pg_temp.as_user('erin');
insert into k values ('c2', app.post_comment('app.projects', pg_temp.id('prj_a'), 'Confirmed, crew briefed.'));
set constraints all immediate;
set constraints all deferred;
select pg_temp.as_user('dave');
select is((select count(*)::integer from app.notifications where kind = 'comment.created'), 1, 'a new comment notifies the other subscribers');
select pg_temp.as_user('erin');
select is((select count(*)::integer from app.notifications where kind = 'comment.created'), 0, 'the author is not notified of their own comment');

-- Edits keep versions; deletes are soft ------------------------------------------------------------------------------
select pg_temp.as_user('erin');
with u as (update app.comments set body = 'Changed by Erin' where id = (select id from k where key = 'c1') returning 1)
select is((select count(*)::integer from u), 0, 'nobody edits someone else''s comment');
select pg_temp.as_user('dave');
update app.comments set body = 'Load-in moves to 06:30.' where id = (select id from k where key = 'c1');
select ok((select edited_at is not null from app.comments where id = (select id from k where key = 'c1')), 'an edit is stamped');
select results_eq($$select version_number, body from app.comment_versions where comment_id = (select id from k where key = 'c1')$$,
  $$values (1, 'Load-in moves to 07:00.'::text)$$, 'the earlier text is kept as version 1');
update app.comments set deleted_at = now() where id = (select id from k where key = 'c1');
select results_eq($$select body, deleted_at is not null from app.comments where id = (select id from k where key = 'c1')$$,
  $$values (''::text, true)$$, 'a delete is soft and clears the text from view');
select is((select count(*)::integer from app.comment_versions where comment_id = (select id from k where key = 'c1')), 2,
  'the deleted text is kept in the history');
select throws_ok($$update app.comments set body = 'Back' where id = (select id from k where key = 'c1')$$, 'XR001', null, 'a deleted comment stays deleted');
select pg_temp.as_user('erin');
select is((select count(*)::integer from app.comment_versions), 0, 'others cannot read the edit history');
select pg_temp.as_user('alice');
select is((select count(*)::integer from app.comment_versions), 2, 'readers of the audit log can');
select throws_ok($$update app.comment_versions set body = 'x'$$, '42501', null, 'the history is append-only');

-- Reactions, subscriptions and resolution -------------------------------------------------------------------------------
select pg_temp.as_user('frank');
insert into app.comment_reactions (comment_id, person_id, reaction_code) values ((select id from k where key = 'c2'), pg_temp.id('dave'), 'thumbs_up');
select is((select person_id from app.comment_reactions), pg_temp.id('frank'), 'a reaction is always the caller''s own');
select throws_ok($$insert into app.comment_reactions (comment_id, reaction_code) values ((select id from k where key = 'c2'), 'thumbs_up')$$,
  '23505', null, 'one reaction of a kind per person');
select throws_ok($$insert into app.comment_reactions (comment_id, reaction_code) values ((select id from k where key = 'c2'), 'skull')$$,
  '23503', null, 'only listed reactions');
select pg_temp.as_user('erin');
update app.thread_subscriptions set subscribed = false;
select is((select count(*)::integer from app.thread_subscriptions where subscribed), 0, 'a person mutes a thread');
with u as (update app.thread_subscriptions set subscribed = false where person_id = pg_temp.id('dave') returning 1)
select is((select count(*)::integer from u), 0, 'nobody changes someone else''s subscription');
update app.comment_threads set resolved_at = now() - interval '1 year';
select results_eq($$select resolved_by, resolved_at > now() - interval '1 minute' from app.comment_threads$$,
  $$values (pg_temp.id('erin'), true)$$, 'resolving stamps the person and the database time');

-- Events and audit -------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is((select string_agg(event_type, ',' order by event_type collate "C") from (select distinct event_type from app.domain_events where event_type like 'comment%') e),
  'comment.created,comment.deleted,comment.edited,comment_thread.resolved', 'every comment change emits a domain event');
select ok((select bool_and(not (data ? 'body')) from app.domain_events where event_type like 'comment%'), 'event payloads never carry the text');
select ok((select count(*) from app.audit_events where action in ('comments.insert', 'comments.update')) >= 3, 'comments are in the audit ledger');

-- Verified email replies post as comments ----------------------------------------------------------------------------------
select app.receive_inbound_email(private.reply_local_part(pg_temp.id('erin'), pg_temp.id('prj_a')), 'erin@northwind.test', 'Re: Load-in',
  '<reply-1@northwind.test>', true, 'Running ten minutes late.', 'raw/reply-1.eml');
select results_eq($$select c.body, c.source::text, c.author_person_id from app.inbound_messages m join app.comments c on c.id = m.posted_comment_id
  where m.message_id_header = '<reply-1@northwind.test>'$$,
  $$values ('Running ten minutes late.'::text, 'Email'::text, pg_temp.id('erin'))$$, 'a verified reply posts as the person''s comment');

select * from finish();
rollback;

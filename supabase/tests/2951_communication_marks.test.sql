-- pgTAP: migration 2951 (B6, RRR-230, G-120, ADR 0145), Needs review and Mark as communicated. An assignee counts as told
-- at the latest of a communication mark, their own acceptance and a telling notification that reached them; a
-- communicable change by someone else after that instant, a cancellation or a return to Draft needs review; marking
-- as communicated is all or nothing and leaves an append-only mark with an audit event.
--
-- Time order: everything in one test transaction carries the same now(), and a change counts only when it is strictly
-- later than the told instant (a shift.changed notification still lets a non-time field saved with it count). Each case
-- runs the flow for real, then, as postgres, writes the later change as the ledger row its trigger would write a few
-- seconds after now() (pg_temp.later), a later copy of the notification the flow wrote (pg_temp.notified_later), or
-- moves the earlier instant back.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select no_plan();

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;
create function pg_temp.k(p_key text) returns uuid language sql stable as $$ select k.id from k where k.key = p_key $$;

-- A shift on prj_a for a member, as Carol, published unless p_publish is false.
create function pg_temp.shift(p_key text, p_member text, p_publish boolean default true) returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  perform pg_temp.as_user('carol');
  insert into app.shifts (project_id, membership_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), case when p_member is null then null else pg_temp.id(p_member || '@org_a') end, '0000.50.01',
    now() + interval '2 days', now() + interval '2 days 8 hours', 'America/New_York')
  returning id into v_id;
  insert into k values (p_key, v_id);
  if p_publish then
    perform app.publish_shifts(array[v_id]);
  end if;
  perform pg_temp.as_platform();
  return v_id;
end $$;

-- The ledger row a shift change by p_actor writes, p_seconds after now().
create function pg_temp.later(p_id uuid, p_actor text, p_diff jsonb, p_seconds numeric default 1) returns void
language plpgsql as $$
begin
  perform pg_temp.as_platform();
  -- The stamp trigger would set created_at to now(); off for this one row, it keeps the instant given.
  alter table app.audit_events disable trigger t90_stamp_audit_columns;
  insert into app.audit_events (org_id, actor_kind, actor_person_id, action, subject_table, subject_id, diff, created_at)
  values (pg_temp.id('org_a'), 'Person', pg_temp.id(p_actor), 'shifts.update', 'app.shifts', p_id, p_diff,
    now() + make_interval(secs => p_seconds));
  alter table app.audit_events enable trigger t90_stamp_audit_columns;
end $$;

-- A copy, p_seconds after now(), of the latest p_kind notification about a shift.
create function pg_temp.notified_later(p_id uuid, p_kind text, p_seconds numeric) returns void
language plpgsql as $$
begin
  perform pg_temp.as_platform();
  alter table app.notifications disable trigger t90_stamp_audit_columns;
  insert into app.notifications (org_id, recipient_person_id, kind, actor_person_id, subject_table, subject_id, project_id,
    message_args, created_at)
  select n.org_id, n.recipient_person_id, n.kind, n.actor_person_id, n.subject_table, n.subject_id, n.project_id, n.message_args,
    now() + make_interval(secs => p_seconds)
  from app.notifications n where n.subject_id = p_id and n.kind = p_kind
  order by n.created_at desc limit 1;
  alter table app.notifications enable trigger t90_stamp_audit_columns;
end $$;

create function pg_temp.status(p_key text) returns table (told_via text, needs_review boolean, changed_fields text[], person_id uuid)
language plpgsql as $$
begin
  perform pg_temp.as_user('carol');
  return query select s.told_via, s.needs_review, s.changed_fields, s.person_id
    from app.communication_status('app.shifts', array[pg_temp.k(p_key)]) s;
end $$;

-- Registry --------------------------------------------------------------------------------------------------------------------
select is((select count(*)::int from private.communication_telling_kinds k
           where not exists (select 1 from private.notification_templates t where t.kind = k.kind)), 0,
  'every telling kind is a notification kind');
select is((select array_agg(field_name order by field_name) from private.communication_fields where table_name = 'app.shifts'),
  array['ends_at', 'engagement_id', 'membership_id', 'record_id', 'role_code', 'scheduled_break_minutes', 'scope_node_id',
        'shift_state', 'starts_at', 'time_zone'], 'the communicable fields of a shift');
select ok(not has_table_privilege('authenticated', 'private.communication_subjects', 'select'), 'the registry stays private');

-- 7. Told by notification, then a role change, then a move ---------------------------------------------------------------
select pg_temp.shift('s1', 'frank');
select is((select count(*)::int from app.notifications where subject_id = pg_temp.k('s1') and kind = 'shift.assigned'), 1,
  'publishing tells the worker (shift.assigned)');
select is((select told_via from pg_temp.status('s1')), 'notified', 'who then counts as told by notification');
select is((select needs_review from pg_temp.status('s1')), false, 'with nothing to review');

select pg_temp.as_user('carol');
update app.shifts set role_code = '0000.51.01' where id = pg_temp.k('s1');
select pg_temp.later(pg_temp.k('s1'), 'carol', '{"old": {"role_code": "0000.50.01"}, "new": {"role_code": "0000.51.01"}}', 1);
select is((select needs_review from pg_temp.status('s1')), true, 'a role change after the notification needs review');
select is((select changed_fields from pg_temp.status('s1')), array['role_code'], 'naming the role');

select pg_temp.as_user('carol');
update app.shifts set starts_at = starts_at + interval '1 hour' where id = pg_temp.k('s1');
select pg_temp.as_platform();
select is((select count(*)::int from app.notifications where subject_id = pg_temp.k('s1') and kind = 'shift.changed'), 1,
  'moving the shift tells the worker (shift.changed)');
select pg_temp.notified_later(pg_temp.k('s1'), 'shift.changed', 2);
select is((select needs_review from pg_temp.status('s1')), false, 'and once that reaches them there is nothing to review');

-- 8d. One update that moves the start and changes the role: the notification tells the times only.
select pg_temp.shift('s_both', 'frank');
select pg_temp.as_user('carol');
update app.shifts set starts_at = starts_at + interval '1 hour', role_code = '0000.51.01' where id = pg_temp.k('s_both');
select is((select changed_fields from pg_temp.status('s_both')), array['role_code'],
  'a role saved with a new start still needs review: shift.changed tells only the times');
select is((select needs_review from pg_temp.status('s_both')), true, 'so the shift needs review');

-- 8. Cancellation, a return to Draft, acceptance ----------------------------------------------------------------------------
select pg_temp.as_user('carol');
select app.transition_shift(pg_temp.k('s1'), 'Published', 'Canceled', 'Show moved.');
select pg_temp.later(pg_temp.k('s1'), 'carol', '{"old": {"shift_state": "Published"}, "new": {"shift_state": "Canceled"}}', 3);
select is((select needs_review from pg_temp.status('s1')), true, 'canceling a told shift needs review');
select is((select changed_fields from pg_temp.status('s1')), array['shift_state'], 'as a change of its state');

select pg_temp.shift('s_draft', 'frank');
select pg_temp.as_user('carol');
select app.transition_shift(pg_temp.k('s_draft'), 'Published', 'Draft', 'Back to planning.');
select pg_temp.later(pg_temp.k('s_draft'), 'carol', '{"old": {"shift_state": "Published"}, "new": {"shift_state": "Draft"}}', 1);
select is((select needs_review from pg_temp.status('s_draft')), true, 'returning a told shift to Draft needs review too');

select pg_temp.shift('s_acc', 'frank');
select pg_temp.as_user('frank');
select app.accept_shift(pg_temp.k('s_acc'));
select is((select told_via from pg_temp.status('s_acc')), 'accepted', 'the assignee accepting makes them told');
select is((select needs_review from pg_temp.status('s_acc')), false, 'and acceptance is not a change');

-- 9. Notifications that do not reach the person; a reassignment --------------------------------------------------------------
select pg_temp.shift('s_quiet', 'frank');
-- With In App off a notification is recorded archived at creation; its deliveries stay unsent.
update app.notifications set archived_at = created_at where subject_id = pg_temp.k('s_quiet');
update app.notification_deliveries set message_status = 'Queued'
where notification_id in (select id from app.notifications where subject_id = pg_temp.k('s_quiet'));
select is((select told_via from pg_temp.status('s_quiet')), null, 'a notification archived at creation and never sent does not tell');
select is((select needs_review from pg_temp.status('s_quiet')), true, 'so the published shift needs review');
select pg_temp.as_platform();
update app.notification_deliveries set message_status = 'Sent'
where notification_id in (select id from app.notifications where subject_id = pg_temp.k('s_quiet'));
select is((select told_via from pg_temp.status('s_quiet')),
  case when exists (select 1 from app.notification_deliveries d join app.notifications n on n.id = d.notification_id
                    where n.subject_id = pg_temp.k('s_quiet')) then 'notified' end,
  'a delivery Sent makes it tell');

select pg_temp.shift('s_moved', 'frank');
select pg_temp.as_user('carol');
update app.shifts set membership_id = pg_temp.id('erin@org_a') where id = pg_temp.k('s_moved');
select is((select person_id from pg_temp.status('s_moved')), pg_temp.id('erin'), 'after a reassignment the status is the new assignee''s');
select is((select told_via from pg_temp.status('s_moved')), 'notified', 'told by their own shift.assigned');
select is((select needs_review from pg_temp.status('s_moved')), false, 'with nothing to review');

-- 10. Mark as communicated -----------------------------------------------------------------------------------------------------
select pg_temp.shift('s_m1', 'frank');
select pg_temp.shift('s_m2', 'erin');
update app.notifications set archived_at = created_at where subject_id in (pg_temp.k('s_m1'), pg_temp.k('s_m2'));
select pg_temp.as_user('carol');
select is((select count(*)::int from app.communication_status('app.shifts', array[pg_temp.k('s_m1'), pg_temp.k('s_m2')]) s
           where s.needs_review), 2, 'two untold shifts need review');
select is(app.mark_communicated('app.shifts', array[pg_temp.k('s_m1'), pg_temp.k('s_m2')], 'Called both.'), 2,
  'marking both as communicated');
select is((select count(*)::int from app.communication_status('app.shifts', array[pg_temp.k('s_m1'), pg_temp.k('s_m2')]) s
           where s.needs_review), 0, 'clears their review');
select is((select told_via from app.communication_status('app.shifts', array[pg_temp.k('s_m1')])), 'marked', 'as marked');
select is((select told_by_name from app.communication_status('app.shifts', array[pg_temp.k('s_m1')])), 'Carol Nguyen', 'by Carol');
select pg_temp.as_platform();
select is((select array_agg(m.person_id order by m.person_id) from app.communication_marks m
           where m.subject_id in (pg_temp.k('s_m1'), pg_temp.k('s_m2'))),
  (select array_agg(p order by p) from unnest(array[pg_temp.id('frank'), pg_temp.id('erin')]) p),
  'one mark per shift, for its current assignee');
select is((select count(*)::int from app.audit_events e where e.action = 'communication_marks.insert'
           and e.subject_id in (select m.id from app.communication_marks m where m.subject_id in (pg_temp.k('s_m1'), pg_temp.k('s_m2')))),
  2, 'each with an audit event');
select is((select org_id from app.communication_marks where subject_id = pg_temp.k('s_m1')), pg_temp.id('org_a'),
  'stamped with the shift''s org');

-- All or nothing: one shift Carol cannot write refuses the call.
select pg_temp.as_user('alice');
with x as (insert into app.shifts (project_id, membership_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a2'), pg_temp.id('frank@org_a'), '0000.50.01', now() + interval '3 days', now() + interval '3 days 8 hours',
    'America/New_York') returning id)
insert into k select 's_other', id from x;
select pg_temp.as_user('frank');
select throws_ok($$select app.mark_communicated('app.shifts', array[pg_temp.k('s_m1')])$$, '42501', null,
  'a caller without crew.shift.write is refused');
select pg_temp.as_user('dave');
select throws_ok($$select app.mark_communicated('app.shifts', array[pg_temp.k('s_quiet'), pg_temp.k('s_other')])$$, '42501', null,
  'a shift on a project the caller cannot write refuses the whole call');
select pg_temp.as_platform();
select is((select count(*)::int from app.communication_marks where subject_id in (pg_temp.k('s_quiet'), pg_temp.k('s_other'))), 0,
  'and nothing is marked for any id');
select pg_temp.shift('s_open', null);
select pg_temp.as_user('carol');
select throws_like($$select app.mark_communicated('app.shifts', array[pg_temp.k('s_open')])$$, 'communication_no_assignee%',
  'an open shift is refused');
select throws_like($$select app.mark_communicated('app.shifts', array(select gen_random_uuid() from generate_series(1, 501)))$$,
  'communication_too_many%', '501 ids are refused');
select throws_like($$select * from app.communication_status('app.shifts', array(select gen_random_uuid() from generate_series(1, 501)))$$,
  'communication_too_many%', 'as is a status for 501');
select throws_like($$select * from app.communication_status('app.records', array[gen_random_uuid()])$$,
  'communication_unavailable%', 'a table without communication is refused');

-- 11. Marks access -------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select throws_like($$update app.communication_marks set note = 'Texted.' where subject_id = pg_temp.k('s_m1')$$, 'append_only%',
  'a mark is never updated');
select throws_like($$delete from app.communication_marks where subject_id = pg_temp.k('s_m1')$$, 'append_only%', 'nor deleted');
select ok(not has_table_privilege('authenticated', 'app.communication_marks', 'insert'),
  'signed-in people cannot insert a mark directly');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.communication_marks), 0, 'a reader without crew.shift.read sees no marks');
select pg_temp.as_user('carol');
select is((select count(*)::int from app.communication_marks where subject_id = pg_temp.k('s_m1')), 1, 'a shift reader sees them');
select pg_temp.as_user('frank');
select is((select count(*)::int from app.communication_status('app.shifts', array[pg_temp.k('s_m1'), pg_temp.k('s_acc')])), 0,
  'the status leaves out shifts the caller cannot write');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.communication_status('app.shifts', array[pg_temp.k('s_m1')])), 0,
  'or cannot read');

select * from finish();
rollback;

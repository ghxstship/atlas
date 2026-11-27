-- 904190301_trash_restore_rules.sql
--
-- Nine Trash tables are restored by the people who manage their rows (RRR-198; ADR 0110, amendment of 4.19); a fix of
-- A33's 1031. app.restore_trash_item restores as the caller, so the table's own update policy and grants decide. Nine
-- tables in Trash give members no UPDATE at all, because their rows change only through their RPCs: support_tickets,
-- rating_replies, party_threads, chat_messages, feed_posts, poll_options, surveys, occupancy_counters and
-- shared_reports. A deleted row of any of them showed in Trash with a Restore button that always answered "you cannot
-- edit this row". Only chat_messages has a delete path for members (app.delete_chat_message, and a moderator's
-- removal); a row of the other eight reaches Trash when the service role deletes it.
--
-- The nine stay in Trash and gain a restore rule, checked by a definer function, because granting UPDATE on deleted_at
-- would also let the same people delete rows these tables never let them delete:
--   * support_tickets: the requester, or a responder of the Organization queue (org.help.write), as
--     app.transition_support_ticket.
--   * rating_replies: the person who replied.
--   * party_threads: the org side (opportunities.engagement.write) or the party, as app.start_party_thread.
--   * chat_messages: the author, when the author deleted it. A message a moderator removed is not restored from Trash
--     (trash_removed_by_moderation); that decision is reversed by its appeal.
--   * feed_posts: the author or a communication admin (org.communication.write), as app.hide_feed_post.
--   * poll_options: the same people, through the option's poll and its post.
--   * surveys: the author or knowledge.sop.publish, as app.transition_survey.
--   * occupancy_counters: safety.emergency_code.write, as app.close_occupancy_counter.
--   * shared_reports: reports.report.export, as app.revoke_shared_report. A restored share stays revoked or expired.
-- Everything else about a restore is unchanged: the caller must read the row through its row level security, the row
-- must be deleted and inside its retention period, and trash.restored is emitted. private.guard_chat_message (0800)
-- lets a deleted message come back only through this restore, with nothing else changed.
--
-- app.restore_trash_item runs as the caller, and signed-in people hold no USAGE on the private schema, so the rule
-- (app.restore_trash_row_by_rule) and the cascade's lookup (app.trash_returns_with_parent) are app functions, as
-- app.trash_restore_terms and app.record_trash_restore are. The rule is safe to call by itself: it names its tables,
-- checks that the person reads the row and manages it, checks the retention period, and only ever clears deleted_at.
--
-- The cascade. Rows that reference a restored row and were deleted with it come back with it. Later migrations keep
-- child tables out of Trash that are meant to come back that way (a template's questions, a segment's cues), and
-- 1031 keeps tables out because their rows never come back: access, authority, credentials and links, and restricted
-- or legally kept records. The cascade walked both kinds. private.trash_excluded_tables.returns_with_parent now says
-- which is which, and the cascade leaves the tables that never come back.

-- 1. Excluded tables that never come back, even with a restored parent -------------------------------------------------

alter table private.trash_excluded_tables add column returns_with_parent boolean not null default true;

comment on column private.trash_excluded_tables.returns_with_parent is 'Whether a row deleted in the same statement as a row that references it comes back when that row is restored from Trash. False for access, authority, credentials and links, and restricted or legally kept records, which never come back.';
comment on table private.trash_excluded_tables is 'Soft-deletable tables kept out of Trash, with why: access, identity, credentials, settings, per-person state, restricted or legally kept records, derived data and parts of another row, whose deletion is not a mistake a person undoes from Trash. A migration that makes a table eligible for Trash and keeps it out lists it here, and sets returns_with_parent false when its rows never come back (ADR 0110).';

update private.trash_excluded_tables set returns_with_parent = false
where table_name in (
  -- Access and authority: a removed row is revoked access.
  'memberships', 'membership_roles', 'workspace_members', 'team_members', 'user_capability_grants', 'record_grants',
  'delegations', 'account_memberships', 'account_membership_roles', 'account_engagement_assignments',
  'account_invitations', 'roster_invitations', 'talent_pool_invitations', 'spend_authorities', 'service_accounts',
  'oauth_apps', 'oauth_grants', 'identity_providers', 'scim_group_mappings', 'scim_identities', 'org_ip_allowlist',
  'member_blocklist_entries',
  -- Credentials and links: a revoked one never opens again.
  'api_keys', 'personal_access_tokens', 'kiosk_pins', 'calendar_feeds', 'person_calendar_feeds', 'inbound_addresses',
  'crew_access_links', 'form_links', 'live_links', 'showcaller_links', 'vendor_intake_links', 'stakeholder_packs',
  'stakeholder_pack_recipients', 'warehouse_destinations', 'integration_connections', 'mcp_connectors',
  -- Restricted and legally kept records.
  'payout_accounts', 'vendor_bank_accounts', 'tax_forms', 'background_checks', 'medical_encounters', 'osha_cases',
  'osha_establishments', 'osha_annual_summaries', 'consent_records', 'sensitive_data_consents', 'legal_holds'
);

create or replace function app.trash_returns_with_parent(p_table text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select e.returns_with_parent from private.trash_excluded_tables e where e.table_name = p_table), true);
$$;

comment on function app.trash_returns_with_parent(text) is 'Whether rows of an app table deleted with a row they reference come back when that row is restored from Trash: false only for a table private.trash_excluded_tables marks as never coming back.';
revoke all on function app.trash_returns_with_parent(text) from public, anon;
grant execute on function app.trash_returns_with_parent(text) to authenticated, service_role;

-- 2. A deleted chat message comes back only through the Trash restore (from 0800) --------------------------------------

create or replace function private.guard_chat_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.conversation_id <> old.conversation_id or new.author_membership_id <> old.author_membership_id
     or new.message_kind <> old.message_kind or new.created_at <> old.created_at then
    perform private.refuse('chat_message_fixed', 'A message keeps its conversation, author and kind.');
  end if;
  if old.deleted_at is not null then
    if private.in_trusted_operation('trash_restore') and new.deleted_at is null
       and new.body is not distinct from old.body and new.language is not distinct from old.language
       and new.edited_at is not distinct from old.edited_at and new.auto_reply = old.auto_reply then
      return new;
    end if;
    perform private.refuse('chat_message_deleted', 'A deleted message does not change.');
  end if;
  return new;
end;
$$;

comment on function private.guard_chat_message() is 'Chat messages keep their conversation, author and kind; a deleted message does not change, and comes back only through the Trash restore, as it was.';
revoke all on function private.guard_chat_message() from public, anon, authenticated;

-- 3. The restore rules ---------------------------------------------------------------------------------------------------

create or replace function private.trash_ruled_tables()
returns setof text
language sql
immutable
set search_path = ''
as $$
  select unnest(array['support_tickets', 'rating_replies', 'party_threads', 'chat_messages', 'feed_posts', 'poll_options',
    'surveys', 'occupancy_counters', 'shared_reports']);
$$;

comment on function private.trash_ruled_tables() is 'The Trash tables whose rows members never update directly: app.restore_trash_row_by_rule restores them for the people who manage the row.';
revoke all on function private.trash_ruled_tables() from public, anon;
grant execute on function private.trash_ruled_tables() to authenticated, service_role;

create or replace function app.restore_trash_row_by_rule(p_table text, p_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.current_person_id();
  v_retention interval;
  v_deleted timestamptz;
  v_allowed boolean;
  v_restored integer;
begin
  if p_table is null or p_table not in (select private.trash_ruled_tables()) then
    return null;
  end if;
  if v_person is null then
    raise exception using errcode = '42501', message = 'a signed-in person is required';
  end if;
  select t.retention into v_retention from app.trash_restore_terms(p_table) t;
  if v_retention is null then
    perform private.refuse('trash_not_restorable', format('Rows of %s are not restored from Trash.', p_table));
  end if;

  case p_table
    when 'support_tickets' then
      select t.deleted_at, t.membership_id in (select private.my_membership_ids())
          or (t.queue = 'Organization' and private.has_capability(t.org_id, 'org.help.write'))
      into v_deleted, v_allowed from app.support_tickets t where t.id = p_id;
    when 'rating_replies' then
      select r.deleted_at, r.replied_by = v_person and r.rating_id in (select private.readable_rating_ids())
      into v_deleted, v_allowed from app.rating_replies r where r.id = p_id;
    when 'party_threads' then
      select t.deleted_at, (t.org_id in (select private.orgs_with_capability('opportunities.engagement.write'))
            and t.org_id in (select private.orgs_with_capability('opportunities.engagement.read')))
          or private.party_side_open(t.org_id, t.party_person_id, t.party_organization_id)
      into v_deleted, v_allowed from app.party_threads t where t.id = p_id;
    when 'chat_messages' then
      select m.deleted_at, m.author_membership_id in (select private.my_membership_ids()) and m.updated_by = v_person
          and m.conversation_id in (select private.my_conversation_ids())
      into v_deleted, v_allowed from app.chat_messages m where m.id = p_id;
      if v_deleted is not null and exists (select 1 from app.content_moderation_decisions d
                                           where d.chat_message_id = p_id and d.action = 'Removed' and d.deleted_at is null) then
        perform private.refuse('trash_removed_by_moderation', 'A moderator removed this message, so it is not restored from Trash.');
      end if;
    when 'feed_posts' then
      select p.deleted_at, (p.author_membership_id in (select private.my_membership_ids())
            or private.has_capability(p.org_id, 'org.communication.write'))
          and private.can_read_feed_post(p.org_id, p.author_membership_id, p.publish_at, p.hidden_at, p.audience_kind,
            p.project_id, p.team_id, p.role_id, p.group_id, p.department_code)
      into v_deleted, v_allowed from app.feed_posts p where p.id = p_id;
    when 'poll_options' then
      select o.deleted_at, (p.author_membership_id in (select private.my_membership_ids())
            or private.has_capability(p.org_id, 'org.communication.write'))
          and p.id in (select private.readable_feed_post_ids())
      into v_deleted, v_allowed
      from app.poll_options o
      join app.polls q on q.id = o.poll_id
      join app.feed_posts p on p.id = q.feed_post_id
      where o.id = p_id;
    when 'surveys' then
      select s.deleted_at, (s.author_membership_id in (select private.my_membership_ids())
            or private.has_capability(s.org_id, 'knowledge.sop.publish'))
          and private.can_read_survey(s.org_id, s.author_membership_id, s.survey_state, s.audience_kind, s.project_id,
            s.team_id, s.role_id, s.group_id)
      into v_deleted, v_allowed from app.surveys s where s.id = p_id;
    when 'occupancy_counters' then
      select c.deleted_at, private.has_capability(c.org_id, 'safety.emergency_code.write')
          and c.project_id in (select private.project_ids_with('safety.incident.read'))
      into v_deleted, v_allowed from app.occupancy_counters c where c.id = p_id;
    when 'shared_reports' then
      select s.deleted_at, private.has_capability(s.org_id, 'reports.report.export')
          and s.org_id in (select private.orgs_with_capability('reports.report.read'))
      into v_deleted, v_allowed from app.shared_reports s where s.id = p_id;
  end case;

  if v_deleted is null or not coalesce(v_allowed, false) then
    return 0;
  end if;
  if v_deleted + v_retention < now() then
    perform private.refuse('trash_restore_expired', 'Its retention period has ended; it is about to be purged and cannot be restored.');
  end if;

  perform private.begin_trusted_operation('trash_restore');
  execute format('update app.%I set deleted_at = null where id = $1 and deleted_at is not null', p_table) using p_id;
  get diagnostics v_restored = row_count;
  perform private.end_trusted_operation('trash_restore');
  return v_restored;
end;
$$;

comment on function app.restore_trash_row_by_rule(text, uuid) is 'Restores a deleted row of a table in private.trash_ruled_tables for the people who manage it: a support ticket for its requester or an Organization queue responder, a rating reply for who replied, a party thread for either side, a chat message for the author who deleted it (never one a moderator removed), a feed post or poll option for the author or a communication admin, a survey for its author or knowledge.sop.publish, an occupancy counter for safety.emergency_code.write, a shared report for reports.report.export. Each rule also requires that the person reads the row. Returns 1 when restored, 0 when the signed-in person may not restore it or it is not deleted, and null for any other table. Called by app.restore_trash_item, which also restores the rows deleted with it and emits trash.restored.';
revoke all on function app.restore_trash_row_by_rule(text, uuid) from public, anon;
grant execute on function app.restore_trash_row_by_rule(text, uuid) to authenticated, service_role;

-- 4. The restore (from 1031, 2131 and 6102) ----------------------------------------------------------------------------

create or replace function app.restore_trash_item(p_subject_table text, p_subject_id uuid)
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_terms record;
  v_deleted timestamptz;
  v_restored integer;
  v_queue_tables text[];
  v_queue_ids uuid[];
  v_depths integer[];
  v_table text;
  v_id uuid;
  v_depth integer;
  v_fk record;
  v_child uuid;
  v_total integer := 1;
  i integer := 1;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'a signed-in person is required';
  end if;
  select * into v_terms from app.trash_restore_terms(p_subject_table);
  if v_terms.table_name is null then
    raise exception using errcode = 'XR001', hint = 'trash_not_restorable',
      message = format('trash_not_restorable: Rows of %s are not restored from Trash.', coalesce(p_subject_table, 'that table'));
  end if;
  execute format('select deleted_at from app.%I where id = $1', v_terms.table_name) into v_deleted using p_subject_id;
  get diagnostics v_restored = row_count;
  if v_restored = 0 then
    raise exception using errcode = '42501', message = 'the row is not visible to you';
  end if;
  if v_deleted is null then
    raise exception using errcode = 'XR001', hint = 'trash_not_deleted', message = 'trash_not_deleted: This row is not in Trash.';
  end if;
  if v_deleted + v_terms.retention < now() then
    raise exception using errcode = 'XR001', hint = 'trash_restore_expired',
      message = 'trash_restore_expired: Its retention period has ended; it is about to be purged and cannot be restored.';
  end if;
  -- A table whose rows members never update directly is restored by its rule, for the people who manage the row;
  -- every other table is restored as the caller, so its own update policy and guards decide.
  v_restored := app.restore_trash_row_by_rule(v_terms.table_name, p_subject_id);
  if v_restored is null then
    execute format('update app.%I set deleted_at = null where id = $1 and deleted_at is not null', v_terms.table_name)
      using p_subject_id;
    get diagnostics v_restored = row_count;
  end if;
  if v_restored = 0 then
    raise exception using errcode = '42501', message = 'you cannot edit this row, so you cannot restore it';
  end if;

  -- Rows that reference it and were deleted in the same statement come back with it, three levels deep, in the
  -- tables whose deleted_at the caller may update, except the tables whose rows never come back (access, authority,
  -- credentials and links, restricted and legally kept records).
  v_queue_tables := array[v_terms.table_name];
  v_queue_ids := array[p_subject_id];
  v_depths := array[1];
  while i <= cardinality(v_queue_ids) loop
    v_table := v_queue_tables[i];
    v_id := v_queue_ids[i];
    v_depth := v_depths[i];
    i := i + 1;
    continue when v_depth > 3;
    for v_fk in
      select cl.relname::text as child_table, a.attname::text as child_column
      from pg_catalog.pg_constraint k
      join pg_catalog.pg_class cl on cl.oid = k.conrelid
      join pg_catalog.pg_namespace n on n.oid = cl.relnamespace
      join pg_catalog.pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
      where k.contype = 'f' and k.confrelid = format('app.%I', v_table)::regclass and cardinality(k.conkey) = 1
        and n.nspname = 'app' and a.attname not in ('created_by', 'updated_by')
        -- The column form admits a table-wide UPDATE grant and one on deleted_at alone, and never raises.
        and exists (select 1 from pg_catalog.pg_attribute d where d.attrelid = k.conrelid and d.attname = 'deleted_at' and not d.attisdropped
                      and has_column_privilege(d.attrelid, d.attnum, 'UPDATE'))
        and exists (select 1 from pg_catalog.pg_attribute x where x.attrelid = k.conrelid and x.attname = 'id' and not x.attisdropped)
        and app.trash_returns_with_parent(cl.relname::text)
    loop
      for v_child in execute format('update app.%I set deleted_at = null where %I = $1 and deleted_at = $2 returning id',
        v_fk.child_table, v_fk.child_column) using v_id, v_deleted
      loop
        v_total := v_total + 1;
        v_queue_tables := v_queue_tables || v_fk.child_table;
        v_queue_ids := v_queue_ids || v_child;
        v_depths := v_depths || (v_depth + 1);
      end loop;
    end loop;
  end loop;

  perform app.record_trash_restore(v_terms.table_name, p_subject_id, v_total);
  return v_total;
end;
$$;

comment on function app.restore_trash_item(text, uuid) is 'Restores a soft-deleted row from Trash. The caller must read the row; the table''s update policy and guards decide, or, for a table members never update directly, the rule of the people who manage the row (app.restore_trash_row_by_rule). Refuses a table not in Trash, a live row and a row past its retention period. Rows that reference it and were deleted with it (the same deleted_at) are restored too, three levels deep, in the tables whose deleted_at the caller may update, except tables whose rows never come back. Emits trash.restored. Returns how many rows were restored.';
revoke all on function app.restore_trash_item(text, uuid) from public, anon;
grant execute on function app.restore_trash_item(text, uuid) to authenticated, service_role;

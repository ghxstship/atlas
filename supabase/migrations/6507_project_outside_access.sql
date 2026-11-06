-- 6507_project_outside_access.sql
-- B2 (RRR-226, ADR 0141; parity gap G-81). One list of everything that reaches a project from outside the org, for
-- the Outside access section of Project Settings: P1's live view and display links (2780), file share links (1380),
-- advance links (0430), signing links (0769), R4's roster invitations (2636), stakeholder pack recipients (6500),
-- vendor intake links (6504), public form links (6506) and the project's current and recent engagements. Before this
-- each lived on its own page, and a project had no one place to see and revoke them.
--   * app.project_outside_access is a security invoker view: a union in which each source's own row level security and
--     column grants decide what a member sees, and every row is also limited to members of the owner org, so a partner
--     org reaching the project through a project share sees none of it.
--   * Nothing shows a password, code or token: XOS stores none readably. Only P1 links and intake and form links have a
--     token hint; only live links, file links and pack recipients have opens. A file share link's project comes from its
--     file's subject through private.share_link_project_id, since private.subject_row is not the caller's to call. That
--     lookup runs per row, so the data function always filters by project and the view is never read unfiltered.
--   * Revoking from the section calls each source's existing RPC. Member calendar feeds stay in Me, Calendar Feeds.
--   * viewer_can_manage answers, per row, the same check that source's revoke or regenerate RPC makes, so a control shows
--     only to someone the RPC would accept. private.can_manage_live_link is the one lookup a member cannot make alone.
--   * label is what people wrote: a note, a title, a name. A source with no words of its own answers null and the screen
--     names it from the source, in the reader's language.

create or replace function private.share_link_project_id(p_share_link_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select (private.subject_row(a.subject_table, a.subject_id) ->> 'project_id')::uuid
  from app.share_links l join app.attachments a on a.id = l.attachment_id
  where l.id = p_share_link_id;
$$;

comment on function private.share_link_project_id(uuid) is 'Project of a file share link: its file''s subject''s project, or null for a file not on a project. Read by app.project_outside_access only on share links the caller''s row level security already returns.';
revoke all on function private.share_link_project_id(uuid) from public, anon;
grant execute on function private.share_link_project_id(uuid) to authenticated, service_role;

create or replace function private.can_manage_live_link(p_live_link_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select l.created_by = private.current_person_id()
      or coalesce((select private.can_on_project(l.project_id, c.share_capability) from private.live_view_collections c
        where c.collection_key = private.live_link_collection_key(l.link_kind, l.saved_view_id)), false)
    from app.live_links l
    where l.id = p_live_link_id and l.deleted_at is null and private.is_member(l.org_id)), false);
$$;

comment on function private.can_manage_live_link(uuid) is 'Whether the signed-in person may regenerate or revoke a live link, the check private.manageable_live_link (2780) makes: a member of its org who made it or holds its collection''s share capability on the project. Read by app.project_outside_access.';
revoke all on function private.can_manage_live_link(uuid) from public, anon;
grant execute on function private.can_manage_live_link(uuid) to authenticated, service_role;

create view app.project_outside_access with (security_invoker = true) as
-- P1 live links: views and display screens.
select l.project_id, case l.link_kind when 'View' then 'Live view link' else 'Display link' end as source, l.id as source_id,
  l.note as label,
  null::text as recipient_email, l.token_hint, st.link_state, l.expires_at, l.open_count::bigint as open_count, l.last_opened_at,
  l.created_at, l.created_by, private.can_manage_live_link(l.id) as viewer_can_manage
from app.live_links l
join app.live_link_states st on st.id = l.id
where l.deleted_at is null and private.is_member(l.org_id)
union all
-- File share links, on files of the project.
select x.project_id, 'File link', s.id, coalesce(s.note, a.title), s.recipient_email, null::text,
  case when s.revoked_at is not null then 'Revoked' when s.expires_at is not null and s.expires_at <= now() then 'Expired'
       when s.failed_attempts >= 5 then 'Locked' else 'Active' end,
  s.expires_at, s.open_count::bigint, s.last_opened_at, s.created_at, s.created_by,
  coalesce(s.created_by = private.current_person_id(), false) or private.has_capability(s.org_id, 'data.export.confidential')
from app.share_links s
join app.attachments a on a.id = s.attachment_id
cross join lateral (select private.share_link_project_id(s.id) as project_id) x
where s.deleted_at is null and x.project_id is not null and private.is_member(s.org_id)
union all
-- Advance links of the project's packets.
select p.project_id, 'Advance link', t.id, p.title, t.recipient_email, null::text,
  case when t.revoked_at is not null then 'Revoked' when t.used_at is not null then 'Used' when t.expires_at <= now() then 'Expired'
       when t.failed_attempts >= 5 then 'Locked' else 'Active' end,
  t.expires_at, null::bigint, null::timestamptz, t.created_at, t.created_by,
  p.project_id in (select private.project_ids_with('advancing.packet.send'))
from app.advance_recipient_tokens t
join app.advance_recipients r on r.id = t.advance_recipient_id
join app.advance_packets p on p.id = r.advance_packet_id
where t.deleted_at is null and private.is_member(t.org_id)
union all
-- Signing links of the project's engagement documents.
select e.project_id, 'Signing link', t.id, d.title, t.recipient_email, null::text,
  case when t.revoked_at is not null then 'Revoked' when t.used_at is not null then 'Used' when t.expires_at <= now() then 'Expired'
       when t.failed_attempts >= 5 then 'Locked' else 'Active' end,
  t.expires_at, null::bigint, null::timestamptz, t.created_at, t.created_by,
  e.project_id in (select private.project_ids_with('opportunities.engagement.write'))
from app.engagement_document_tokens t
join app.engagement_documents d on d.id = t.engagement_document_id
join app.engagements e on e.id = d.engagement_id
where t.deleted_at is null and private.is_member(t.org_id)
union all
-- R4 roster invitations of the project's engagements.
select e.project_id, 'Roster invitation', i.id, null::text, i.email, null::text,
  case when i.revoked_at is not null then 'Revoked' when i.claimed_at is not null then 'Claimed'
       when i.declined_at is not null then 'Declined' when i.expires_at <= now() then 'Expired' else 'Pending' end,
  i.expires_at, null::bigint, null::timestamptz, i.created_at, i.created_by, false
from app.roster_invitations i
join app.engagement_roster_entries re on re.id = i.roster_entry_id
join app.engagements e on e.id = re.engagement_id
where i.deleted_at is null and private.is_member(i.org_id)
union all
-- Stakeholder pack recipients.
select p.project_id, 'Pack recipient', r.id, p.name || ' · ' || r.full_name, r.email, null::text,
  case when r.revoked_at is not null or p.revoked_at is not null then 'Revoked' when p.expires_at <= now() then 'Expired'
       when r.failed_attempts >= 5 then 'Locked' else 'Active' end,
  p.expires_at, coalesce(a.opens, 0), a.last_opened_at, r.created_at, r.created_by,
  p.project_id in (select private.project_ids_with('projects.settings.write'))
from app.stakeholder_pack_recipients r
join app.stakeholder_packs p on p.id = r.stakeholder_pack_id
left join app.stakeholder_pack_recipient_activity a on a.recipient_id = r.id
where r.deleted_at is null and p.deleted_at is null and private.is_member(r.org_id)
union all
-- Vendor intake links.
select v.project_id, 'Intake link', v.id, v.title, null::text, v.token_hint,
  case when v.revoked_at is not null then 'Revoked' when v.expires_at <= now() then 'Expired'
       when v.failed_attempts >= 5 then 'Locked' else 'Active' end,
  v.expires_at, null::bigint, null::timestamptz, v.created_at, v.created_by,
  v.project_id in (select private.project_ids_with('opportunities.engagement.write'))
from app.vendor_intake_links v
where v.deleted_at is null and private.is_member(v.org_id)
union all
-- Public form links that name the project.
select f.project_id, 'Form link', f.id, coalesce(f.note, t.name), null::text, f.token_hint,
  case when f.revoked_at is not null then 'Revoked' when f.expires_at <= now() then 'Expired'
       when f.failed_attempts >= 5 then 'Locked' else 'Active' end,
  f.expires_at, null::bigint, null::timestamptz, f.created_at, f.created_by,
  private.has_capability(f.org_id, 'knowledge.sop.publish')
from app.form_links f
join app.form_templates t on t.id = f.form_template_id
where f.deleted_at is null and private.is_member(f.org_id)
union all
-- Engagements: current, and those that ended in the last 18 months. Not links; the party and the state.
select b.project_id, 'Engagement', b.engagement_id, b.party_name, null::text, null::text, b.engagement_state::text,
  null::timestamptz, null::bigint, null::timestamptz, e.created_at, e.created_by, false
from app.engagement_board b
join app.engagements e on e.id = b.engagement_id
where private.is_member(b.org_id)
  and (b.engagement_state in ('Onboarding', 'Blocked', 'Active', 'Closing') or e.updated_at > now() - interval '18 months');

call private.describe('app.project_outside_access', 'Everything that reaches a project from outside the org (ADR 0141), for the Outside access section of Project Settings: live view and display links, file share links, advance links, signing links, roster invitations, stakeholder pack recipients, vendor intake links, public form links and the project''s current and recent engagements. A security invoker union: each source''s row level security and column grants decide, and only members of the owner org see any row. No password, code or token is shown; none is stored readably.', array[
  'project_id', 'Project reached.',
  'source', 'Live view link, Display link, File link, Advance link, Signing link, Roster invitation, Pack recipient, Intake link, Form link or Engagement.',
  'source_id', 'Id of the row in its source table, for its own revoke or regenerate RPC.',
  'label', 'What the row is, in the words people wrote: the link''s note or title, the file, the packet or document, the pack and recipient, or the engaged party. Null for a live link with no note and for a roster invitation; the screen names those from the source.',
  'recipient_email', 'Who it was sent to, when the source names one.',
  'token_hint', 'Last four characters of the token: live, intake and form links only.',
  'link_state', 'Active, Locked, Expired, Revoked or Used for links; Pending, Claimed, Declined, Revoked or Expired for roster invitations; the engagement state for an engagement.',
  'expires_at', 'When it stops working; null for an engagement.',
  'open_count', 'Successful opens: live links, file links and pack recipients only.',
  'last_opened_at', 'Last successful open: live links, file links and pack recipients only.',
  'created_at', 'When it was made.',
  'created_by', 'Person who made it.',
  'viewer_can_manage', 'Whether the reader may revoke or regenerate it: the check that source''s RPC makes. False for roster invitations and engagements, which are managed on the engagement.'
]);
-- recipient_email shows a Confidential column under another name (2030).
insert into private.view_column_sources (view_name, column_name, source_table, source_column) values
  ('app.project_outside_access', 'recipient_email', 'app.stakeholder_pack_recipients', 'email')
on conflict do nothing;
revoke all on app.project_outside_access from public, anon;
grant select on app.project_outside_access to authenticated, service_role;
revoke select on app.project_outside_access from xos_backup;

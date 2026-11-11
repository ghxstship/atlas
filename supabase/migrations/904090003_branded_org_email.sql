-- Every email an org sends wears its brand (Section 12, A138): the 4.9 email branding audit. Notification email already
-- read app.email_brand_for_org (3310); guest emails, guest passes, scheduled reports and stakeholder packs did not.
--   * app.email_brand_for_org also answers suppress_powered_by, so an org that hides "Powered by XOS" on its pages
--     (private.public_brand, only while white label is in force) hides "Delivered by XOS" on its email too.
--   * app.document_brand_for_org: the brand a guest pass the guest-email worker attaches carries, the same one Atlas
--     prints on a pass it downloads (loadDocumentBrand): the display name, the legal entity, the accent and the light
--     logo. Documents wear an org's brand whatever its plan, as they do in Atlas; email follows the white label gate.
--   * app.mint_stakeholder_pack_link answers the email brand: the brand name, From name, reply-to, logo and accent
--     while white label is in force, with partner inheritance, rather than the org's display name on every plan.
--   * party invitations (roster, talent pool, account) name the inviting org, so they wear its email brand too.
--   * app.report_delivery answers the recipient person, the org slug, the report a recipient may open (as
--     app.finish_report_delivery's notice decides, 1621) and whether the org's suppression list stops the email (a hard
--     bounce, complaint, STOP or manual entry, or an unsubscribe from reports or from all email), so the worker sends a
--     branded email with a working one-click unsubscribe and never mails an address that asked to stop.

-- Email brand ----------------------------------------------------------------------------------------------------------

drop function app.email_brand_for_org(uuid);

create function app.email_brand_for_org(p_org_id uuid)
returns table (
  brand_name text,
  sender_name text,
  reply_to text,
  logo_path text,
  accent_hex text,
  suppress_powered_by boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select pb.name,
    coalesce(b.email_sender_name, pb.name),
    b.support_email,
    pb.logo_light_path,
    pb.accent_hex,
    pb.suppress_powered_by
  from app.organizations o
  cross join lateral private.public_brand(o.id) pb
  left join app.org_brands b on b.org_id = o.id and b.deleted_at is null
  where o.id = p_org_id and o.deleted_at is null
    and private.white_label_in_force(o.id, 'white_label');
$$;

comment on function app.email_brand_for_org(uuid) is 'Worker API (service role): the brand an org''s email wears while white label is in force (Section 12): the brand name, the From name (email_sender_name, else the brand name), the support address replies go to, the light logo''s path in the org-brand bucket, the accent after partner inheritance and whether "Delivered by XOS" is hidden (the org''s suppress_powered_by, private.public_brand). No row without white label in force; the email then wears the platform brand. The worker drops an accent that fails the email contrast check.';
revoke all on function app.email_brand_for_org(uuid) from public, anon, authenticated;
grant execute on function app.email_brand_for_org(uuid) to service_role;

-- Document brand -------------------------------------------------------------------------------------------------------

create function app.document_brand_for_org(p_org_id uuid)
returns table (
  name text,
  legal_entity text,
  accent_hex text,
  logo_path text
)
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(nullif(btrim(b.display_name), ''), o.name),
    coalesce(nullif(btrim(b.legal_entity_name), ''), nullif(btrim(private.org_setting_text(o.id, 'org.legal_name')), '')),
    b.accent_hex,
    b.logo_light_path
  from app.organizations o
  left join app.org_brands b on b.org_id = o.id and b.deleted_at is null
  where o.id = p_org_id and o.deleted_at is null;
$$;

comment on function app.document_brand_for_org(uuid) is 'Worker API (service role): the brand a document a worker renders for an org carries, as Atlas prints it (loadDocumentBrand): the display name (else the org''s name), the white-label legal entity name (else the registered legal name, setting org.legal_name), the accent and the light logo''s path in the org-brand bucket. The guest-email worker puts it on the guest pass it attaches.';
revoke all on function app.document_brand_for_org(uuid) from public, anon, authenticated;
grant execute on function app.document_brand_for_org(uuid) to service_role;

-- Stakeholder pack email -----------------------------------------------------------------------------------------------

create or replace function app.mint_stakeholder_pack_link(p_delivery_id uuid)
returns table (token text, unsubscribe_token text, expires_at timestamptz, email jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_delivery app.stakeholder_pack_deliveries;
  v_recipient app.stakeholder_pack_recipients;
  v_pack app.stakeholder_packs;
  v_token text := 'xpkl_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_unsubscribe text := 'xpku_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_expires timestamptz;
  v_skip text;
  v_locale text;
begin
  select * into v_delivery from app.stakeholder_pack_deliveries d where d.id = p_delivery_id and d.deleted_at is null for update;
  if v_delivery.id is null or v_delivery.delivery_status <> 'Queued' then
    return;
  end if;
  select * into v_recipient from app.stakeholder_pack_recipients r where r.id = v_delivery.recipient_id;
  select * into v_pack from app.stakeholder_packs p where p.id = v_delivery.stakeholder_pack_id;
  v_skip := case
    when v_pack.revoked_at is not null or v_pack.deleted_at is not null then 'The pack was revoked before the email went out.'
    when v_pack.expires_at <= now() then 'The pack expired before the email went out.'
    when v_recipient.revoked_at is not null or v_recipient.deleted_at is not null then 'The recipient was revoked before the email went out.'
    when v_recipient.unsubscribed_at is not null then 'The recipient stopped these emails.'
    when private.pack_email_suppressed(v_pack.org_id, v_recipient.email) then 'The address is on the organization''s suppression list.'
  end;
  -- Links of earlier attempts of this delivery stop (ADR 0106 decision 5); links past their pack's expiry by 30 days go.
  update private.stakeholder_pack_links l set revoked_at = now()
  where l.stakeholder_pack_delivery_id = v_delivery.id and l.revoked_at is null;
  delete from private.stakeholder_pack_links l
  using app.stakeholder_pack_recipients r, app.stakeholder_packs p
  where l.recipient_id = r.id and p.id = r.stakeholder_pack_id and p.expires_at < now() - interval '30 days';
  if v_skip is not null then
    update app.stakeholder_pack_deliveries set delivery_status = 'Skipped', last_error = v_skip where id = v_delivery.id;
    return;
  end if;

  v_expires := least(now() + interval '7 days', v_pack.expires_at);
  insert into private.stakeholder_pack_links (org_id, stakeholder_pack_delivery_id, recipient_id, token_hash, token_hint, unsubscribe_hash, expires_at)
  values (v_pack.org_id, v_delivery.id, v_recipient.id, private.share_token_hash(v_token), right(v_token, 4),
    private.share_token_hash(v_unsubscribe), v_expires);
  v_locale := private.org_setting_text(v_pack.org_id, 'locale.language');
  return query
  select v_token, v_unsubscribe, v_expires, jsonb_build_object(
    'recipient_name', v_recipient.full_name,
    'recipient_email', v_recipient.email,
    'locale', case when v_locale in ('en-US', 'es-US') then v_locale else 'en-US' end,
    'org_id', o.id,
    'org_name', o.name,
    -- The email brand while white label is in force (app.email_brand_for_org), else the org's own name.
    'brand_name', coalesce(eb.brand_name, o.name),
    'white_label', eb.brand_name is not null,
    'brand_sender_name', eb.sender_name,
    'reply_to', eb.reply_to,
    'logo_path', eb.logo_path,
    'accent_hex', eb.accent_hex,
    'suppress_powered_by', coalesce(eb.suppress_powered_by, false),
    'pack_name', v_pack.name,
    'message', v_pack.message,
    'item_titles', coalesce((select jsonb_agg(i.title order by i.position, i.id) from app.stakeholder_pack_items i
                             where i.stakeholder_pack_id = v_pack.id and i.deleted_at is null), '[]'::jsonb),
    'sender_name', (select pe.full_name from app.people pe where pe.id = v_pack.created_by),
    'expires_at', v_expires,
    'time_zone', coalesce((select nullif(btrim(p.time_zone), '') from app.projects p where p.id = v_pack.project_id),
      private.org_setting_text(v_pack.org_id, 'locale.time_zone'), 'UTC'))
  from app.organizations o
  left join lateral app.email_brand_for_org(o.id) eb on true
  where o.id = v_pack.org_id;
end;
$$;

comment on function app.mint_stakeholder_pack_link(uuid) is 'Worker API (service role): mints the sign-in link of one queued stakeholder pack delivery (ADR 0141): an xpkl_ token valid until the earlier of 7 days and the pack''s expiry, and an xpku_ unsubscribe token; only their hashes are kept. Revokes the links of earlier attempts of the same delivery (ADR 0106 decision 5) and deletes links whose pack expired more than 30 days ago. Answers the tokens and what the email says (recipient name and email, locale, the org, whether white label is in force and the email brand while it is (app.email_brand_for_org: brand and From name, reply-to, logo, accent, whether "Delivered by XOS" is hidden), pack name and message, item titles, sender''s name, expiry and the project''s time zone to show it in), never the access code. A delivery whose pack or recipient was revoked, whose pack expired, whose recipient unsubscribed or whose address is on the org''s suppression list is marked Skipped and answers nothing.';
revoke all on function app.mint_stakeholder_pack_link(uuid) from public, anon, authenticated;
grant execute on function app.mint_stakeholder_pack_link(uuid) to service_role;

-- Scheduled report email -----------------------------------------------------------------------------------------------

drop function app.report_delivery(uuid);

create function app.report_delivery(p_delivery_id uuid)
returns table (
  delivery_id uuid,
  org_id uuid,
  org_name text,
  report_name text,
  export_format app.export_format,
  storage_object_path text,
  row_count integer,
  unpriced_count integer,
  recipient_email text,
  recipient_name text,
  delivery_status text,
  scheduled_for timestamptz,
  recipient_person_id uuid,
  org_slug text,
  report_definition_id uuid,
  suppressed boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.org_id, o.name, def.name, r.export_format, r.storage_object_path, r.row_count, r.unpriced_count,
    u.email::text, p.full_name, d.delivery_status, d.scheduled_for, p.id, o.slug,
    -- The report, for a recipient who may open it (app.finish_report_delivery, 1621): its owner, or anyone who may read
    -- reports on its source once it is shared. Anyone else's email carries the file and no link.
    case when def.deleted_at is null and (
        exists (select 1 from app.memberships om where om.id = def.membership_id and om.person_id = p.id)
        or (def.shared
            and private.person_capability_reach(p.id, def.org_id, 'reports.report.read', true) = 'organization'
            and private.person_capability_reach(p.id, def.org_id,
                  (select s.read_capability from private.report_sources s where s.code = def.source_code), true) = 'organization'))
      then def.id end,
    u.email is not null and exists (
      select 1 from app.suppression_list s
      where s.org_id = d.org_id and s.channel = 'Email' and s.address = lower(btrim(u.email::text))
        and s.lifted_at is null and s.deleted_at is null
        and (s.reason in ('Hard Bounce', 'Complaint', 'STOP', 'Manual')
             or (s.reason = 'Unsubscribe' and (s.category_code is null or s.category_code = 'reports'))))
  from app.report_deliveries d
  join app.organizations o on o.id = d.org_id
  join app.report_runs r on r.id = d.report_run_id
  join app.report_definitions def on def.id = r.report_definition_id
  join app.memberships m on m.id = d.membership_id
  join app.people p on p.id = m.person_id
  left join auth.users u on u.id = p.user_id
  where d.id = p_delivery_id and d.deleted_at is null;
$$;

comment on function app.report_delivery(uuid) is 'Worker API (service role): what the delivery worker needs to email one scheduled report: the run''s file, the report and org names, the org slug, the recipient''s address, name and person, the report definition when the recipient may open it (as app.finish_report_delivery''s notice decides, else null), and whether the org''s suppression list stops the email (a hard bounce, complaint, STOP or manual entry, or an unsubscribe from reports or from all email).';
revoke all on function app.report_delivery(uuid) from public, anon, authenticated;
grant execute on function app.report_delivery(uuid) to service_role;


-- Party invitations ----------------------------------------------------------------------------------------------------
-- An org's invitation of an outside party onto a crew roster or into its talent pool, and an account's invitation of a
-- member, name the inviting org (org_id) so the platform email worker sends it under that org's brand while white
-- label is in force (app.email_brand_for_org); otherwise it stays the platform's email, as before. The three functions
-- are their latest definitions (2630, 4731, 6525) with org_id added to the email's arguments.

create or replace function app.invite_account_member(
  p_account_id uuid,
  p_email text,
  p_role app.account_role,
  p_valid_for interval default interval '14 days'
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_email text;
  v_id uuid;
begin
  perform private.assert_account_admin(p_account_id);
  v_email := private.normalized_invitation_email(p_email);
  if p_role is null then
    perform private.refuse('account_role_required', 'Choose the account role the invitee receives.');
  end if;
  if p_role = 'Account Owner' and not exists (select 1 from private.account_role(p_account_id) r where r = 'Account Owner') then
    perform private.refuse('account_role_band', 'Only an Account Owner offers Account Owner.');
  end if;
  if v_email = (select lower(u.email) from auth.users u join app.people p on p.user_id = u.id where p.id = v_me) then
    perform private.refuse('sod_self_grant', 'A person cannot grant themselves a role or capability.');
  end if;
  perform private.assert_invitation_validity(p_valid_for);
  update app.account_invitations set revoked_at = now()
  where org_id = p_account_id and email = v_email and accepted_at is null and declined_at is null and revoked_at is null
    and deleted_at is null;
  insert into app.account_invitations (org_id, email, account_role, invited_by, expires_at)
  values (p_account_id, v_email, p_role, v_me, now() + p_valid_for)
  returning id into v_id;
  perform private.queue_party_invitation_email('account', v_email, jsonb_build_object(
    'org_id', p_account_id,
    'account_name', (select o.name from app.organizations o where o.id = p_account_id),
    'account_role', p_role,
    'inviter_name', (select p.full_name from app.people p where p.id = v_me),
    'expires_at', now() + p_valid_for), p_account_id);
  return v_id;
end;
$$;

create or replace function private.issue_roster_invitation(p_roster_entry_id uuid, p_email text, p_valid_for interval, p_token_id uuid default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := case when p_token_id is null then private.current_person_id() end;
  v_id uuid;
begin
  perform private.assert_invitation_validity(p_valid_for);
  update app.roster_invitations set revoked_at = now()
  where roster_entry_id = p_roster_entry_id and claimed_at is null and declined_at is null and revoked_at is null and deleted_at is null;
  insert into app.roster_invitations (roster_entry_id, email, invited_by, advance_recipient_token_id, expires_at)
  values (p_roster_entry_id, p_email, v_me, p_token_id, now() + p_valid_for)
  returning id into v_id;
  perform private.queue_party_invitation_email('roster', p_email, (
    select jsonb_build_object(
      'org_id', o.id,
      'org_name', o.name,
      'project_name', p.name,
      'party_name', coalesce(a.name, ep.full_name),
      'job_title', xr.job_title,
      -- Through an advance link nobody signed in invites: the party does.
      'inviter_name', coalesce((select ip.full_name from app.people ip where ip.id = v_me), a.name, ep.full_name),
      'expires_at', now() + p_valid_for)
    from app.engagement_roster_entries r
    join app.engagements e on e.id = r.engagement_id
    join app.organizations o on o.id = e.org_id
    join app.projects p on p.id = e.project_id
    left join app.counterparties c on c.id = e.counterparty_id
    left join app.organizations a on a.id = c.organization_id
    left join app.people ep on ep.id = e.person_id
    left join xpms.role xr on xr.role_code = r.role_code
    where r.id = p_roster_entry_id), private.roster_entry_account(p_roster_entry_id));
  return v_id;
end;
$$;

create or replace function private.queue_pool_invitation_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and not (new.expires_at > old.expires_at and new.claimed_at is null and new.declined_at is null
                                and new.revoked_at is null and new.deleted_at is null) then
    return null;
  end if;
  -- A whole file can turn into email here, so an org's daily volume is capped on every path.
  if private.rate_limit_exceeded('pool_invitation_email', new.org_id::text, 2000, interval '24 hours') then
    perform private.refuse('pool_invitation_daily_limit', 'This organization reached 2000 invitation emails in 24 hours. Try again tomorrow.');
  end if;
  perform private.note_rate_event('pool_invitation_email', new.org_id::text);
  perform private.queue_party_invitation_email('pool', new.email, (
    select jsonb_build_object(
      'org_id', o.id,
      'org_name', o.name,
      'job_title', xr.job_title,
      'inviter_name', ip.full_name,
      'expires_at', new.expires_at)
    from app.organizations o
    left join xpms.role xr on xr.role_code = new.role_code
    left join app.people ip on ip.id = new.invited_by
    where o.id = new.org_id), null);
  return null;
end;
$$;

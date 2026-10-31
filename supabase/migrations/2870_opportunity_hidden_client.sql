-- 2870_opportunity_hidden_client.sql
-- P10 (RRR-224), gap G-128, Section 4.4.3 and Section 4.5.6 item 27: a posting can keep its client and event hidden from
-- crew until they are booked.
--   * app.opportunities.hide_client_until_booked: the org's choice. "Booked" is computed, never stored: the viewer's
--     side holds an Accepted application on the opportunity (private.my_application_ids, 0720, which covers their
--     own application, their account's and a represented artist's)
--   * app.opportunity_defaults.hide_client_until_booked (2290): the create form starts with the org's choice
--   * private.guard_opportunity_hidden_client (trigger t46): the flag goes on only while the posting is Draft or
--     Pending Approval, since a published listing already showed its names, and while it is on the title and the
--     description cannot name the project, its client or the venue. Turning it off is allowed in any state
--   * private.opportunity_disclosed_to_me: whether the signed-in person may see the client and event of a listing.
--     2871 applies it to every projection an external person reads before booking
-- The event is the project (app.projects.name) and its venue; the client is the project's client counterparty. None
-- of the external projections selects the project name or the client; the venue name and point, and the org's own
-- free text, are what identify the event before booking.
--
-- Decision: the posting org stays named on a hidden listing. It is the employer of record, the white-label Gateway
-- filters match it, its verified badge is the trust signal on every card, and the frozen v1 field
-- MarketplaceListing.org_name is a required string, so hiding it would not be additive. A brand that must stay
-- anonymous posts through its agency's org.
--
-- Residual gaps, recorded and not built: position labels, question prompts, requirement descriptions, interview and
-- audition location_text and offer version messages are org-authored text an applicant can read before booking and
-- are not name-checked; renaming the project, the venue or the client organization after the posting is saved does
-- not run the name check again. The Gateway help article states them.
-- No new table, so ADR 0110's Trash sync does not apply; no foreign key, array or counted column is added.

-- Columns --------------------------------------------------------------------------------------------------------------

alter table app.opportunities add column hide_client_until_booked boolean not null default false;
grant insert (hide_client_until_booked), update (hide_client_until_booked) on app.opportunities to authenticated;
comment on column app.opportunities.hide_client_until_booked is 'True while crew should not learn the client or the event before they are booked (2870): external projections hide the venue name and round the venue point to 1 decimal until the viewer holds an Accepted application, and the title and description cannot name the project, its client or the venue. Turned on only while Draft or Pending Approval.';

alter table app.opportunity_defaults add column hide_client_until_booked boolean not null default false;
comment on column app.opportunity_defaults.hide_client_until_booked is 'Whether a new opportunity starts with its client and event hidden until booked (2870).';

-- The guard ------------------------------------------------------------------------------------------------------------

create or replace function private.guard_opportunity_hidden_client()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state app.opportunity_state;
  v_name text;
begin
  -- The state the listing was in: names shown once published cannot be taken back by the flag.
  v_state := case when tg_op = 'INSERT' then new.opportunity_state else old.opportunity_state end;
  if new.hide_client_until_booked and (tg_op = 'INSERT' or not old.hide_client_until_booked)
     and v_state not in ('Draft', 'Pending Approval') then
    perform private.refuse('opportunity_hidden_client_published',
      'The client and event were already shown on this listing. Hide them on a new posting while it is a draft.');
  end if;
  if not new.hide_client_until_booked then
    return new;
  end if;
  -- Names are read directly, not through app.counterparty_name, which answers only for a member session: the
  -- check must hold for the service role, API keys and jobs too. Names of 3 characters or fewer are ignored, and
  -- strpos matches literally, so % and _ in a name are not wildcards.
  select btrim(n.name) into v_name
  from (
    select p.name, 1 as ord from app.projects p where p.id = new.project_id
    union all
    select o.name, 2 from app.projects p
    join app.counterparties c on c.id = p.client_counterparty_id
    join app.organizations o on o.id = c.organization_id
    where p.id = new.project_id
    union all
    select v.name, 3 from app.projects p
    join app.venues v on v.id = coalesce(new.venue_id, p.venue_id)
    where p.id = new.project_id
  ) n
  where char_length(btrim(n.name)) > 3
    and (strpos(lower(new.title), lower(btrim(n.name))) > 0
      or strpos(lower(coalesce(new.description, '')), lower(btrim(n.name))) > 0)
  order by n.ord
  limit 1;
  if v_name is not null then
    perform private.refuse('opportunity_hidden_client_named',
      format('While the client and event are hidden, the title and description cannot name %s. Remove it, or show the client and event.', v_name));
  end if;
  return new;
end;
$$;

comment on function private.guard_opportunity_hidden_client() is 'Opportunities with the client and event hidden until booked (2870): the flag goes on only while the posting is Draft or Pending Approval (opportunity_hidden_client_published), and while it is on the title and description cannot contain, ignoring case, the project name, the client organization''s name or the venue name (the opportunity''s venue, else the project''s) when the name is longer than 3 characters (opportunity_hidden_client_named). Turning the flag off is allowed in any state.';
revoke all on function private.guard_opportunity_hidden_client() from public, anon, authenticated;

create trigger t46_guard_opportunity_hidden_client
  before insert or update of hide_client_until_booked, title, description, project_id, venue_id on app.opportunities
  for each row execute function private.guard_opportunity_hidden_client();

-- Disclosure -----------------------------------------------------------------------------------------------------------

create or replace function private.opportunity_disclosed_to_me(p_opportunity_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select not o.hide_client_until_booked
      or o.project_id in (select private.project_ids_with('opportunities.posting.read'))
      or exists (
        select 1 from app.applications a
        where a.opportunity_id = o.id and a.deleted_at is null and a.application_state = 'Accepted'
          and a.id in (select private.my_application_ids()))
    from app.opportunities o
    where o.id = p_opportunity_id), false);
$$;

comment on function private.opportunity_disclosed_to_me(uuid) is 'True when the signed-in person may see the client and event of the opportunity (2870): its flag hide_client_until_booked is off, they read postings on its project (opportunities.posting.read), or their side holds an Accepted application on it (private.my_application_ids: their own, their account''s or a represented artist''s). False for an unknown opportunity.';
revoke all on function private.opportunity_disclosed_to_me(uuid) from public, anon;
grant execute on function private.opportunity_disclosed_to_me(uuid) to authenticated, service_role;

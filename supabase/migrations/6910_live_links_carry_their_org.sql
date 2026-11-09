-- 6910_live_links_carry_their_org.sql
-- RRR-243. P1's private live link state (3780) had no org: private.live_link_channels and private.live_link_grants
-- reference app.live_links but carry no org_id, so an org's purge (1351) and a sandbox's (1530) met rows that reference
-- the org's marked links without being the org's own, and an org that ever made a live link could not finish its
-- deletion. B3 found it and made showcaller links carry their org (6243); this does the same for live links, the way
-- 6502 did for download tickets:
--   * Both tables gain org_id, filled from the link for the rows already there, then not null, with a foreign key to
--     the organization and an index for the purge.
--   * A trigger stamps the org from the link on insert, so the writers keep their latest definitions (insert_live_link
--     in 3780 for the channel, open_live_link in 6280 for the grant), and no row can name another org than its link's.
--   * private.retired_live_link_tokens holds only hashes and has no foreign key, so it never stops a purge.
-- Links tied to a project still end when the project is Complete, Canceled, archived or in Trash (6280): nothing here
-- touches the open, the reader or private.project_link_open.

alter table private.live_link_channels add column org_id uuid references app.organizations (id);
alter table private.live_link_grants add column org_id uuid references app.organizations (id);

update private.live_link_channels c set org_id = l.org_id from app.live_links l where l.id = c.live_link_id;
update private.live_link_grants g set org_id = l.org_id from app.live_links l where l.id = g.live_link_id;

alter table private.live_link_channels alter column org_id set not null;
alter table private.live_link_grants alter column org_id set not null;

create index live_link_channels_org_idx on private.live_link_channels (org_id);
create index live_link_grants_org_idx on private.live_link_grants (org_id);

create or replace function private.stamp_live_link_state_org()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.org_id := (select l.org_id from app.live_links l where l.id = new.live_link_id);
  return new;
end;
$$;

comment on function private.stamp_live_link_state_org() is 'Before insert on live link channels and device grants: the row''s org is its live link''s, so deleting the org or a sandbox takes the row with it (1351, 1530; 6910).';
revoke all on function private.stamp_live_link_state_org() from public, anon, authenticated;

create trigger t05_stamp_org before insert on private.live_link_channels
  for each row execute function private.stamp_live_link_state_org();
create trigger t05_stamp_org before insert on private.live_link_grants
  for each row execute function private.stamp_live_link_state_org();

comment on column private.live_link_channels.org_id is 'Org of the live link, stamped by the database (6910); deleting the org takes the channel key with it.';
comment on column private.live_link_grants.org_id is 'Org of the live link, stamped by the database (6910); deleting the org takes the grant with it.';

-- 1033_org_state_labels.sql
-- A33 Platform workflow (RRR-77). Org state labels (Section 4.10 workflow engine: "org_state_labels
-- (orgs may relabel the nine record states for display without minting a new lifecycle)").
--
--   * A label renames one of the nine canon record states (xpms.dim_record_state) for display in one
--     org, such as In Review shown as With Client. The stored state, the transition rules and every
--     query keep the canon value; only what people read changes.
--   * A label never reuses another state's canon name, and two states of one org never share a label,
--     so a relabeled board stays unambiguous.
--   * app.record_state_display gives each org the display label of every state, its own or canon.
--   * Labels are edited by holders of org.views.write (the Views and Defaults settings, A30's page,
--     through A33's settings contribution).

insert into private.domain_event_types (code, subject, description) values
  ('state_label.changed', 'org_state_labels', 'An org relabeled a record state for display, or removed its label.')
on conflict (code) do nothing;

create table app.org_state_labels (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  record_state text not null references xpms.dim_record_state (record_state),
  label text not null,
  deleted_at timestamptz,
  constraint org_state_labels_label_length check (char_length(btrim(label)) between 1 and 40 and label = btrim(label))
);

create index org_state_labels_record_state_idx on app.org_state_labels (record_state);
create unique index org_state_labels_one_per_state on app.org_state_labels (org_id, record_state) where deleted_at is null;
create unique index org_state_labels_distinct_label on app.org_state_labels (org_id, lower(label)) where deleted_at is null;

call private.install_domain_table('app.org_state_labels');
call private.describe('app.org_state_labels', 'An org''s display labels for the nine canon record states (Section 4.10). Display only: stored states, transition rules and filters keep the canon value.', array[
  'record_state', 'Canon record state relabeled. Never changes; remove the label and add another instead.',
  'label', 'What the org''s people see instead of the canon name. Unique in the org and never another state''s canon name.'
]);

create or replace function private.guard_org_state_label()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.record_state <> old.record_state then
    perform private.refuse('state_label_state_immutable', 'A label keeps its state; remove it and label the other state instead.');
  end if;
  if exists (select 1 from xpms.dim_record_state s
             where lower(s.record_state) = lower(new.label) and s.record_state <> new.record_state) then
    perform private.refuse('state_label_collides', format('%s is the name of another record state; choose a label no state already has.', new.label));
  end if;
  return new;
end;
$$;

comment on function private.guard_org_state_label() is 'A label keeps its state and never takes another state''s canon name.';
revoke all on function private.guard_org_state_label() from public, anon, authenticated;

create trigger t40_guard_org_state_label before insert or update on app.org_state_labels
  for each row execute function private.guard_org_state_label();

call private.install_policies('app.org_state_labels',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('org.views.write'))$$);

create trigger t90_emit_state_label_changed after insert or update on app.org_state_labels
  for each row execute function private.emit_row_event('state_label.changed', '-', 'record_state', 'label', 'deleted_at');

create view app.record_state_display with (security_invoker = true) as
select o.org_id, s.record_state, s.ordinal, coalesce(l.label, s.record_state) as label, l.id is not null as relabeled
from (select m.org_id from app.memberships m
      where m.person_id = (select private.current_person_id()) and m.deleted_at is null
        and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
      group by m.org_id) o
cross join xpms.dim_record_state s
left join app.org_state_labels l on l.org_id = o.org_id and l.record_state = s.record_state and l.deleted_at is null;

comment on view app.record_state_display is 'The display label of each of the nine record states in each org the reader belongs to: the org''s own label, or the canon name.';
comment on column app.record_state_display.org_id is 'Org.';
comment on column app.record_state_display.record_state is 'Canon record state, as stored.';
comment on column app.record_state_display.ordinal is 'Canon display order of the state.';
comment on column app.record_state_display.label is 'What the org shows for the state.';
comment on column app.record_state_display.relabeled is 'True when the org set its own label.';

revoke all on app.record_state_display from public, anon;
grant select on app.record_state_display to authenticated, service_role;

call private.install_default_retention('app.org_state_labels');
select private.sync_trash_tables();

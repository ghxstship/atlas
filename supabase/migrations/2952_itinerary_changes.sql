-- 2952_itinerary_changes.sql
--
-- B6 (RRR-230, G-65; ADR 0145). Gateway's Travel and Lodging and Hospitality tabs, and Compass Travel and lodging, show a
-- whole-stay itinerary with the rows changed since the person last looked marked. The last look is an 'Itinerary' seen
-- mark on the engagement (2950); what changed is computed from the ledger against it, leaving out the person's own
-- edits. External viewers get the names of their own view's columns only, never a value from the ledger:
--   * travel: the person's rows of api_external.travel on the engagement, with the route, times and booking fields.
--     A change to the fare or its currency marks nothing;
--   * lodging: rows of api_external.lodging on the engagement's project (a person on a roster sees only their own),
--     with the check-in and check-out dates and the block, reported as 'hotel';
--   * set_time: the engagement's own set times (app.engagement_cues), with the cue's label, planned time and length.
--     Calling a cue (called_at) marks nothing;
--   * removed travel segments and room assignments, under the predicates of their views without deleted_at, titled
--     by the route or the hotel.
-- Known limit (ADR 0145): a room assignment or travel segment whose person moves away from a visible person after the
-- baseline does not appear as removed.

create or replace function private.my_itinerary_changes()
returns table (
  subject_kind text,
  subject_id uuid,
  engagement_id uuid,
  project_id uuid,
  change_kind text,
  changed_fields text[],
  changed_at timestamptz,
  baseline_at timestamptz,
  title text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.current_person_id();
  v_mark record;
  v_project uuid;
  v_principal boolean;
begin
  if v_person is null then
    return;
  end if;
  for v_mark in
    select m.scope_id, private.effective_seen_baseline(m.baseline_at, m.visit_started_at) as baseline_at
    from app.seen_marks m
    where m.person_id = v_person and m.surface = 'Itinerary' and m.deleted_at is null
  loop
    continue when v_mark.baseline_at is null or not private.seen_scope_open('Itinerary', v_mark.scope_id);
    select e.project_id into v_project from app.engagements e where e.id = v_mark.scope_id and e.deleted_at is null;
    continue when v_project is null;
    v_principal := v_mark.scope_id in (select private.my_engagement_ids('operational'));

    -- Travel on the engagement, live.
    return query
    select 'travel'::text, t.id, v_mark.scope_id, t.project_id, x.change_kind, x.fields, x.changed_at, v_mark.baseline_at, null::text
    from api_external.travel t
    cross join lateral private.audit_changes_since('app.travel_segments', t.id, v_mark.baseline_at, v_person,
      array['travel_mode', 'operator_name', 'service_identifier', 'confirmation_identifier', 'departs_from', 'departs_at',
            'departs_time_zone', 'arrives_at_place', 'arrives_at', 'arrives_time_zone']) x
    where t.engagement_id = v_mark.scope_id;

    -- Rooms on the engagement's project, live; a person on a roster sees only their own.
    return query
    select 'lodging'::text, l.id, v_mark.scope_id, l.project_id, x.change_kind,
      array(select case f when 'accommodation_block_id' then 'hotel' else f end from unnest(x.fields) f order by 1),
      x.changed_at, v_mark.baseline_at, null::text
    from api_external.lodging l
    cross join lateral private.audit_changes_since('app.accommodation_assignments', l.id, v_mark.baseline_at, v_person,
      array['check_in_on', 'check_out_on', 'accommodation_block_id']) x
    where l.project_id = v_project and (v_principal or l.person_id = v_person);

    -- The engagement's own set times.
    return query
    select 'set_time'::text, c.id, v_mark.scope_id, c.project_id, x.change_kind, x.fields, x.changed_at, v_mark.baseline_at,
      null::text
    from app.engagement_cues ec
    join app.cues c on c.id = ec.cue_id and c.deleted_at is null
    cross join lateral private.audit_changes_since('app.cues', c.id, v_mark.baseline_at, v_person,
      array['label', 'planned_at', 'duration']) x
    where ec.engagement_id = v_mark.scope_id and ec.deleted_at is null
      and c.id in (select private.my_set_cue_ids());

    -- Travel removed since the baseline, under api_external.travel's predicates without deleted_at.
    return query
    select 'travel'::text, t.id, v_mark.scope_id, t.project_id, 'removed'::text, '{}'::text[], x.changed_at, v_mark.baseline_at,
      t.departs_from || ' → ' || t.arrives_at_place
    from app.travel_segments t
    cross join lateral private.audit_changes_since('app.travel_segments', t.id, v_mark.baseline_at, v_person) x
    where t.engagement_id = v_mark.scope_id and t.deleted_at is not null and x.change_kind = 'removed'
      and ((t.engagement_id in (select private.my_engagement_ids('operational'))
            and (t.person_id = v_person or private.engagement_principal(t.engagement_id)))
        or (t.person_id = v_person and private.my_roster_allocation(t.allocation_id)));

    -- Rooms removed since the baseline, under api_external.lodging's predicates without deleted_at.
    return query
    select 'lodging'::text, a.id, v_mark.scope_id, b.project_id, 'removed'::text, '{}'::text[], x.changed_at, v_mark.baseline_at,
      coalesce(o.name, b.title)
    from app.accommodation_assignments a
    join app.accommodation_blocks b on b.id = a.accommodation_block_id and b.deleted_at is null
    left join app.counterparties cp on cp.id = b.counterparty_id
    left join app.organizations o on o.id = cp.organization_id
    cross join lateral private.audit_changes_since('app.accommodation_assignments', a.id, v_mark.baseline_at, v_person) x
    where b.project_id = v_project and a.deleted_at is not null and x.change_kind = 'removed'
      and (v_principal or a.person_id = v_person)
      and (private.party_person_visible(b.project_id, a.person_id)
        or (a.person_id = v_person and private.my_roster_allocation(a.allocation_id)));
  end loop;
end;
$$;

comment on function private.my_itinerary_changes() is 'B6 (G-65, ADR 0145): what changed on the signed-in person''s itineraries since they last looked, one row per changed, added or removed travel segment, room assignment or set time, for each of their Itinerary seen marks whose engagement is still open to them and whose baseline exists. Compares against that baseline with the person''s own edits left out, names only the columns of their own views (lodging''s block as hotel), never a value, and never a price. Serves api_external.itinerary_changes.';
revoke all on function private.my_itinerary_changes() from public, anon;
-- Function calls inside a view run with the caller's execute privilege, so signed-in users need this.
grant execute on function private.my_itinerary_changes() to authenticated, service_role;

-- api_external sits outside 1650's default grant to the backup reader, so this view needs no revoke from xos_backup.
create or replace view api_external.itinerary_changes as
select c.subject_kind, c.subject_id, c.engagement_id, c.project_id, c.change_kind, c.changed_fields, c.changed_at, c.baseline_at,
  c.title
from private.my_itinerary_changes() c;

comment on view api_external.itinerary_changes is 'B6 (G-65, ADR 0145): the rows of the caller''s itineraries (Gateway Travel and Lodging and Hospitality, Compass Travel and lodging) that changed since they last looked at each engagement''s itinerary, from the audit ledger: travel, lodging and set times, added, changed or removed, naming the fields of the caller''s own views that changed and never a value or a price. No rows before the caller''s second visit, and none of the caller''s own edits.';
comment on column api_external.itinerary_changes.subject_kind is 'travel (api_external.travel), lodging (api_external.lodging) or set_time (api_external.cues).';
comment on column api_external.itinerary_changes.subject_id is 'Id of the row in its view.';
comment on column api_external.itinerary_changes.engagement_id is 'Engagement whose itinerary the row belongs to.';
comment on column api_external.itinerary_changes.project_id is 'Project of the row.';
comment on column api_external.itinerary_changes.change_kind is 'added, changed or removed since the baseline.';
comment on column api_external.itinerary_changes.changed_fields is 'Columns of the row''s view that changed; a block change of a room reads hotel. Empty for a removed row.';
comment on column api_external.itinerary_changes.changed_at is 'When the latest change was saved.';
comment on column api_external.itinerary_changes.baseline_at is 'The instant compared against: the caller''s previous visit to the itinerary, or when they marked it all as seen.';
comment on column api_external.itinerary_changes.title is 'For a removed row, its route (from → to) or hotel; NULL otherwise.';

revoke all on api_external.itinerary_changes from public, anon;
grant select on api_external.itinerary_changes to authenticated, service_role;

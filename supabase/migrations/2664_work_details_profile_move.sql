-- 2664_work_details_profile_move.sql
-- R6a (RRR-185, ADR 0102 decision 2; owner decision 2 of 2026-10-28). Uniform sizes and travel preferences leave the
-- profile: from now on a production asks for them on each roster entry (R5, 2654 and 2655) and keeps them only for that
-- project. This is the expand step: the ten columns stay, always NULL, until R6b drops them, while API v1 keeps its fields.
--
--   * The retired columns: shirt_size, jacket_size, pants_size, shoe_size, glove_size, hat_size, uniform_notes,
--     seat_preference, meal_preference and home_airport.
--   * private.move_profile_work_details() deletes every existing value, once. Each person whose row held one gets an
--     access log entry (work_details.fields_removed, with the column names, never the values) and, with a sign-in, the
--     account.work_details_moved notice. The values are not kept anywhere and are never offered back as suggestions.
--     Shares naming Uniform Sizes lose it; a share left with nothing is closed as a revocation, withdrawing the org's
--     consent with its last live share.
--   * private.guard_person_work_details refuses a non-null value in a retired column (work_detail_field_moved), and
--     app.share_work_details refuses Uniform Sizes (work_detail_category_retired). Uniform Sizes stays a value of
--     app.work_detail_category because the access log keeps rows that name it for seven years; no live share names it
--     (work_detail_shares_no_retired_category).
--   * Contact (2661) is shared with at least one other category: app.share_work_details refuses it alone
--     (work_detail_share_contact_alone) and no live share names only Contact (work_detail_shares_contact_not_alone).
--     API v1 carries Contact beside a frozen category list whose minItems is 1 (ADR 0105 section 5), so a share of
--     Contact alone would read back with no categories.
-- Functions start from their latest definitions: 1340_work_details.sql for the guard and the change log,
-- 2638_roster_work_detail_shares.sql for app.share_work_details.

-- Writes to the retired columns -------------------------------------------------------------------------------------------

create or replace function private.guard_person_work_details()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT' and (new.passport_number is not null or new.passport_number_last4 is not null))
     or (tg_op = 'UPDATE' and (new.passport_number is distinct from old.passport_number
                               or new.passport_number_last4 is distinct from old.passport_number_last4)) then
    if not private.in_trusted_operation('passport_number_write') then
      perform private.refuse('passport_number_rpc_only', 'A passport number is written only through app.set_my_passport_number, which encrypts it.');
    end if;
  end if;
  -- R6a: uniform sizes and travel preferences are entered per roster entry now; the profile columns stay NULL.
  if not private.in_trusted_operation('work_details_profile_move') and (
       (tg_op = 'INSERT' and num_nonnulls(new.shirt_size, new.jacket_size, new.pants_size, new.shoe_size, new.glove_size,
          new.hat_size, new.uniform_notes, new.seat_preference, new.meal_preference, new.home_airport) > 0)
       or (tg_op = 'UPDATE' and (
          (new.shirt_size is not null and new.shirt_size is distinct from old.shirt_size)
          or (new.jacket_size is not null and new.jacket_size is distinct from old.jacket_size)
          or (new.pants_size is not null and new.pants_size is distinct from old.pants_size)
          or (new.shoe_size is not null and new.shoe_size is distinct from old.shoe_size)
          or (new.glove_size is not null and new.glove_size is distinct from old.glove_size)
          or (new.hat_size is not null and new.hat_size is distinct from old.hat_size)
          or (new.uniform_notes is not null and new.uniform_notes is distinct from old.uniform_notes)
          or (new.seat_preference is not null and new.seat_preference is distinct from old.seat_preference)
          or (new.meal_preference is not null and new.meal_preference is distinct from old.meal_preference)
          or (new.home_airport is not null and new.home_airport is distinct from old.home_airport)))) then
    perform private.refuse('work_detail_field_moved',
      'Uniform sizes and travel preferences are no longer kept on your profile; enter them on each project you are rostered on.');
  end if;
  -- Each need once, in enum order, so a diff shows a real change.
  new.dietary_needs := coalesce((select array_agg(distinct d order by d) from unnest(new.dietary_needs) d), '{}');
  new.accessibility_needs := coalesce((select array_agg(distinct a order by a) from unnest(new.accessibility_needs) a), '{}');
  return new;
end;
$$;

comment on function private.guard_person_work_details() is 'Person work details: the passport number and its last four change only inside the encrypting RPC; the retired uniform size and travel preference columns take no value (work_detail_field_moved, R6a) outside the one-time move; dietary and accessibility needs are kept once each, in enum order.';
revoke all on function private.guard_person_work_details() from public, anon, authenticated;

create or replace function private.log_work_detail_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_skip text[] := array['id', 'person_id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'passport_number', 'passport_number_last4'];
  v_old jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  v_new jsonb := to_jsonb(new);
  v_changed text[];
  v_verb text := lower(tg_op);
begin
  -- The erasure and the R6a move log their own entry.
  if private.in_trusted_operation('work_details_erase') or private.in_trusted_operation('work_details_profile_move') then
    return null;
  end if;
  select coalesce(array_agg(k order by k), '{}') into v_changed
  from jsonb_object_keys(v_new) k
  where k <> all (v_skip) and (v_new -> k) is distinct from (v_old -> k)
    and (tg_op = 'UPDATE' or (v_new -> k) not in ('null'::jsonb, '[]'::jsonb));
  if tg_op = 'UPDATE' and new.deleted_at is not null and old.deleted_at is null then
    v_verb := 'delete';
    v_changed := '{}';
  elsif tg_op = 'UPDATE' and cardinality(v_changed) = 0 then
    return null;
  end if;
  perform private.log_work_detail_event(new.person_id, tg_table_name || '.' || v_verb, null, null, '{}', v_changed, null);
  return null;
end;
$$;

comment on function private.log_work_detail_change() is 'After insert or update on the person-owned work detail tables: logs the change to app.work_detail_events with the names of the changed columns, never their values. A soft delete is logged as delete; the passport number is logged by its own RPC, and the erasure and the R6a profile move by theirs.';
revoke all on function private.log_work_detail_change() from public, anon, authenticated;

-- Sharing refuses the retired category -------------------------------------------------------------------------------------

create or replace function app.share_work_details(
  p_engagement_id uuid,
  p_categories app.work_detail_category[],
  p_notice_version text default '1.0.0'
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_engagement app.engagements;
  v_entry app.engagement_roster_entries;
  v_categories app.work_detail_category[] := (select array_agg(distinct c order by c) from unnest(p_categories) c where c is not null);
  v_share app.work_detail_shares;
  v_consent uuid;
begin
  select * into v_engagement from app.engagements e where e.id = p_engagement_id and e.deleted_at is null;
  if v_engagement.id is not null then
    select r.* into v_entry from app.engagement_roster_entries r
    where r.engagement_id = v_engagement.id and r.deleted_at is null and r.entry_state <> 'Withdrawn'
      and ((r.is_self and v_engagement.person_id = v_me) or (not r.is_self and r.person_id = v_me));
  end if;
  if v_entry.id is null then
    perform private.refuse('work_detail_share_not_yours', 'Only a person on an engagement''s roster shares their work details with it.');
  end if;
  if 'Uniform Sizes' = any (v_categories) then
    perform private.refuse('work_detail_category_retired',
      'Uniform sizes are no longer shared from your profile; enter them on the project''s roster entry.');
  end if;
  if v_categories = array['Contact']::app.work_detail_category[] then
    perform private.refuse('work_detail_share_contact_alone', 'Share your contact together with at least one other category.');
  end if;
  if not v_entry.is_self and v_entry.person_response <> 'Accepted' then
    perform private.refuse('roster_entry_not_accepted', 'Accept the roster entry before sharing your work details with it.');
  end if;
  if not private.engagement_shares_work_details(v_engagement.engagement_state) then
    perform private.refuse('work_detail_share_closed', 'This engagement is complete or canceled, so nothing more is shared with it.');
  end if;
  if private.org_read_only(v_engagement.org_id) then
    perform private.refuse('org_read_only', 'This organization is canceled and read-only, so nothing more is shared with it.');
  end if;
  if coalesce(cardinality(v_categories), 0) = 0 then
    perform private.refuse('work_detail_share_categories', 'Choose at least one category to share, or revoke the share.');
  end if;

  select * into v_share from app.work_detail_shares s
  where s.roster_entry_id = v_entry.id and s.revoked_at is null and s.deleted_at is null;

  if v_share.id is not null then
    if v_share.categories = v_categories then
      return v_share.id;
    end if;
    update app.work_detail_shares s set categories = v_categories where s.id = v_share.id;
    perform private.log_work_detail_event(v_me, 'work_details.share_changed', v_engagement.org_id, v_engagement.id, v_categories, '{}', null, v_entry.id);
    return v_share.id;
  end if;

  select r.id into v_consent from app.consent_records r
  where r.org_id = v_engagement.org_id and r.person_id = v_me and r.purpose_code = 'work_details_sharing'
    and r.withdrawn_at is null and r.deleted_at is null;
  if v_consent is null then
    insert into app.consent_records (org_id, person_id, purpose_code, notice_version, source)
    values (v_engagement.org_id, v_me, 'work_details_sharing', coalesce(nullif(btrim(p_notice_version), ''), '1.0.0'), 'Web')
    returning id into v_consent;
  end if;
  insert into app.work_detail_shares (engagement_id, person_id, consent_record_id, categories, roster_entry_id)
  values (v_engagement.id, v_me, v_consent, v_categories, v_entry.id)
  returning * into v_share;
  perform private.log_work_detail_event(v_me, 'work_details.shared', v_engagement.org_id, v_engagement.id, v_categories, '{}', null, v_entry.id);
  return v_share.id;
end;
$$;

comment on function app.share_work_details(uuid, app.work_detail_category[], text) is 'A person on an engagement''s roster shares chosen categories of their work details on their own entry (the self entry for the engaged person; any other entry once they accepted it, else roster_entry_not_accepted), recording work_details_sharing consent for the producing org when none stands. The share serves the producing org and the company that rosters them. The retired Uniform Sizes is refused (work_detail_category_retired, R6a), and so is Contact alone (work_detail_share_contact_alone, R6a: API v1 lists categories beside it, at least one). A second call replaces the categories (fewer is a partial revocation). Refused once the engagement is Complete or Canceled. Returns the share id.';
revoke all on function app.share_work_details(uuid, app.work_detail_category[], text) from public, anon;
grant execute on function app.share_work_details(uuid, app.work_detail_category[], text) to authenticated, service_role;

-- The one-time move ---------------------------------------------------------------------------------------------------------

create or replace function private.move_profile_work_details()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uniform constant text[] := array['glove_size', 'hat_size', 'jacket_size', 'pants_size', 'shirt_size', 'shoe_size', 'uniform_notes'];
  v_travel constant text[] := array['home_airport', 'meal_preference', 'seat_preference'];
  v_row record;
  v_share app.work_detail_shares;
  v_columns text[];
  v_moved text;
  v_categories app.work_detail_category[];
  v_count integer := 0;
begin
  perform private.begin_trusted_operation('work_details_profile_move');
  for v_row in
    select w.id, w.person_id, p.user_id, to_jsonb(w) as j
    from app.person_work_details w
    join app.people p on p.id = w.person_id
    where w.deleted_at is null
      and num_nonnulls(w.shirt_size, w.jacket_size, w.pants_size, w.shoe_size, w.glove_size, w.hat_size, w.uniform_notes,
        w.seat_preference, w.meal_preference, w.home_airport) > 0
    order by w.person_id
    for update of w
  loop
    -- The names of the columns that held a value, never the values.
    select array_agg(k order by k) into v_columns
    from unnest(v_uniform || v_travel) k where v_row.j -> k <> 'null'::jsonb;
    v_moved := case
      when v_columns && v_uniform and v_columns && v_travel then 'both'
      when v_columns && v_uniform then 'uniform'
      else 'travel' end;
    v_categories := case v_moved
      when 'both' then array['Uniform Sizes', 'Travel Profile']::app.work_detail_category[]
      when 'uniform' then array['Uniform Sizes']::app.work_detail_category[]
      else array['Travel Profile']::app.work_detail_category[] end;

    update app.person_work_details w set
      shirt_size = null, jacket_size = null, pants_size = null, shoe_size = null, glove_size = null, hat_size = null,
      uniform_notes = null, seat_preference = null, meal_preference = null, home_airport = null
    where w.id = v_row.id;
    perform private.log_work_detail_event(v_row.person_id, 'work_details.fields_removed', null, null, v_categories, v_columns, null);
    if v_row.user_id is not null then
      begin
        perform private.notify_account(v_row.user_id, 'account.work_details_moved', jsonb_build_object('moved', v_moved));
      exception when others then
        raise warning 'account.work_details_moved (%) was not sent to sign-in %: %', v_moved, v_row.user_id, sqlerrm;
      end;
    end if;
    v_count := v_count + 1;
  end loop;
  perform private.end_trusted_operation('work_details_profile_move');

  -- Shares lose the retired category; one left with nothing is a revocation.
  for v_share in
    select * from app.work_detail_shares s
    where s.revoked_at is null and s.deleted_at is null and 'Uniform Sizes' = any (s.categories)
    order by s.shared_at, s.id
    for update
  loop
    v_categories := array_remove(v_share.categories, 'Uniform Sizes');
    if cardinality(v_categories) = 0 then
      perform private.close_work_detail_share(v_share, 'work_details.share_revoked');
    else
      update app.work_detail_shares s set categories = v_categories where s.id = v_share.id;
      perform private.log_work_detail_event(v_share.person_id, 'work_details.share_changed', v_share.org_id, v_share.engagement_id,
        v_categories, '{}', null, v_share.roster_entry_id);
    end if;
  end loop;
  return v_count;
end;
$$;

comment on function private.move_profile_work_details() is 'R6a (2664): deletes every uniform size and travel preference on the profile, logging work_details.fields_removed with the names of the columns that held a value (never the values) and sending account.work_details_moved (moved: uniform, travel or both) to each person with a sign-in, a failure being a warning only; then removes Uniform Sizes from every live share, closing a share left empty as a revocation. Returns how many people it changed. Run once by 2664; kept so pgTAP can exercise it.';
revoke all on function private.move_profile_work_details() from public, anon, authenticated;

select private.move_profile_work_details();

alter table app.work_detail_shares add constraint work_detail_shares_no_retired_category
  check (revoked_at is not null or deleted_at is not null or not ('Uniform Sizes' = any (categories)));
alter table app.work_detail_shares add constraint work_detail_shares_contact_not_alone
  check (revoked_at is not null or deleted_at is not null or categories <> array['Contact']::app.work_detail_category[]);

-- Comments ----------------------------------------------------------------------------------------------------------------------

comment on type app.work_detail_category is 'Categories of a person''s work details that are shared with an engaging org one by one (Section 4.5.6 item 10). Contact is the person''s verified sign-in email and phone (R6a). Uniform Sizes is retired (R6a): sizes are entered per roster entry, no live share names it, and it stays for the access log rows that do. Travel Profile now means loyalty programs; Passport is the passport details, kept separate so loyalty programs can be shared without them.';

comment on column app.person_work_details.shirt_size is 'Retired (R6a): always NULL; dropped by R6b.';
comment on column app.person_work_details.jacket_size is 'Retired (R6a): always NULL; dropped by R6b.';
comment on column app.person_work_details.pants_size is 'Retired (R6a): always NULL; dropped by R6b.';
comment on column app.person_work_details.shoe_size is 'Retired (R6a): always NULL; dropped by R6b.';
comment on column app.person_work_details.glove_size is 'Retired (R6a): always NULL; dropped by R6b.';
comment on column app.person_work_details.hat_size is 'Retired (R6a): always NULL; dropped by R6b.';
comment on column app.person_work_details.uniform_notes is 'Retired (R6a): always NULL; dropped by R6b.';
comment on column app.person_work_details.seat_preference is 'Retired (R6a): always NULL; dropped by R6b.';
comment on column app.person_work_details.meal_preference is 'Retired (R6a): always NULL; dropped by R6b.';
comment on column app.person_work_details.home_airport is 'Retired (R6a): always NULL; dropped by R6b.';
comment on table app.person_work_details is 'A person''s work details (Section 4.5.6 item 10): dietary needs and allergies, accessibility needs and the passport; loyalty programs and emergency contacts sit beside them. Uniform sizes and travel preferences are entered per roster entry since R6a, and their columns here stay NULL until R6b drops them. Owned and read only by the person; an engaging org sees a category only while the person shares it with that engagement (app.work_detail_shares, app.shared_work_details). The passport number and allergies are Restricted; the passport number is encrypted.';

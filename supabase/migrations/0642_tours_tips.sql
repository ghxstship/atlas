-- 0642_tours_tips.sql
-- A31 guided tours and contextual tips (Section 11.16, Section 7.3 "tour_progress, tip_dismissals").
-- A tour is offered once, can be replayed from Help and is never forced; a tip appears the first time
-- a person meets a complex feature and is shown once. Tours and tips themselves are help content
-- (apps/atlas/help); these tables hold only each person's progress, keyed by the content's key.

create type app.tour_state as enum ('Offered', 'Started', 'Completed', 'Dismissed');
comment on type app.tour_state is 'Where a person is with a guided tour: Offered (shown the offer once), Started, Completed or Dismissed. A replay from Help starts again from Started.';

-- Tour progress ---------------------------------------------------------------------------------------------

create table app.tour_progress (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  membership_id uuid not null references app.memberships (id),
  tour_key text not null,
  tour_state app.tour_state not null default 'Offered',
  step smallint not null default 0,
  constraint tour_progress_key_format check (tour_key ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$' and char_length(tour_key) <= 100),
  constraint tour_progress_step_range check (step between 0 and 50)
);

create index tour_progress_membership_idx on app.tour_progress (membership_id);

call private.install_domain_table('app.tour_progress', 'app.memberships', 'membership_id');
create unique index tour_progress_one_per_tour on app.tour_progress (membership_id, tour_key) where deleted_at is null;
call private.describe('app.tour_progress', 'A person''s progress through one guided tour (Section 11.16). The row exists once the tour has been offered, so it is never offered again unasked.', array[
  'membership_id', 'Member the progress belongs to.',
  'tour_key', 'Tour key from the help content, such as atlas.getting-started or module.crew.',
  'tour_state', 'Offered, Started, Completed or Dismissed.',
  'step', 'Last step reached, from 0.'
]);

call private.install_policies('app.tour_progress',
  $$membership_id in (select private.my_membership_ids())$$,
  $$membership_id in (select private.my_membership_ids())$$);

-- A tour keeps its key; a completed tour's step never goes back except through a replay (Started at 0).
create or replace function private.guard_tour_progress()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.tour_key <> old.tour_key then
    perform private.refuse('tour_key_immutable', 'Tour progress keeps its tour.');
  end if;
  if tg_op = 'UPDATE' and old.tour_state = 'Completed' and new.tour_state = 'Completed' and new.step < old.step then
    perform private.refuse('tour_completed_step', 'A completed tour keeps its last step; replay it to start again.');
  end if;
  if tg_op = 'UPDATE' and new.tour_state = 'Offered' and old.tour_state <> 'Offered' then
    perform private.refuse('tour_offered_once', 'A tour is offered once; replay it from Help instead.');
  end if;
  return new;
end;
$$;

comment on function private.guard_tour_progress() is 'Tour progress: the tour key never changes, a tour is offered only once and a completed tour keeps its last step until replayed.';
revoke all on function private.guard_tour_progress() from public, anon, authenticated;
create trigger t41_guard_tour_progress before insert or update on app.tour_progress
  for each row execute function private.guard_tour_progress();

-- Tip dismissals ---------------------------------------------------------------------------------------------

create table app.tip_dismissals (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  membership_id uuid not null references app.memberships (id),
  tip_key text not null,
  constraint tip_dismissals_key_format check (tip_key ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$' and char_length(tip_key) <= 100)
);

create index tip_dismissals_membership_idx on app.tip_dismissals (membership_id);

call private.install_domain_table('app.tip_dismissals', 'app.memberships', 'membership_id');
create unique index tip_dismissals_one_per_tip on app.tip_dismissals (membership_id, tip_key) where deleted_at is null;
call private.describe('app.tip_dismissals', 'A contextual tip a person has seen and dismissed (Section 11.16). A dismissed tip is never shown again; resetting tips soft deletes the rows.', array[
  'membership_id', 'Member who dismissed the tip.',
  'tip_key', 'Tip key from the help content, such as gates or spreadsheet-grid.'
]);

call private.install_policies('app.tip_dismissals',
  $$membership_id in (select private.my_membership_ids())$$,
  $$membership_id in (select private.my_membership_ids())$$);

create or replace function private.guard_tip_dismissal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.tip_key <> old.tip_key or (old.deleted_at is not null and new.deleted_at is null)) then
    perform private.refuse('tip_dismissal_immutable', 'A tip dismissal is kept or reset, never changed.');
  end if;
  return new;
end;
$$;

comment on function private.guard_tip_dismissal() is 'Tip dismissals: the tip never changes and a reset dismissal is not revived (dismiss again instead).';
revoke all on function private.guard_tip_dismissal() from public, anon, authenticated;
create trigger t41_guard_tip_dismissal before update on app.tip_dismissals
  for each row execute function private.guard_tip_dismissal();

call private.install_default_retention('app.tour_progress');
call private.install_default_retention('app.tip_dismissals');

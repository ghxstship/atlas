-- 4.11 fix (4.9 surface crawl): a roster entry its person declined is neither submitted nor accepted. The submit moved
-- every Draft or Returned entry naming a person to Submitted, whatever the person had answered, and the review never
-- read person_response, so a staffing agency's lead submitted someone who had said no, the production accepted them
-- (entry_state Accepted, person_response Declined) and the person lost the engagement they had declined to work.
--
--   * private.submit_roster_entries, recreated from 4731: an entry whose person declined stays where it is, for the
--     lead to replace or withdraw (2642 already tells the roster's managers of the decline). A roster with nothing left
--     to submit refuses roster_empty_submit, as before.
--   * private.review_roster_entry_core, recreated from 2635: accepting an entry whose person declined refuses
--     roster_entry_declined (the rule 4654's project fact writes already use). Returning it stays possible, so an entry
--     submitted before its person declined goes back to the lead. app.review_roster_entry and the bulk row both call it.
-- Gateway's Crew tab counts only the entries that will move (apps/gateway/lib/roster.ts, rosterEntriesToSubmit).

create or replace function private.submit_roster_entries(p_engagement_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_entry app.engagement_roster_entries;
  v_count integer := 0;
  v_locked boolean := private.roster_locked(p_engagement_id);
  v_drafts_held integer := 0;
begin
  for v_entry in
    select * from app.engagement_roster_entries r
    where r.engagement_id = p_engagement_id and r.deleted_at is null and not r.is_self and r.person_id is not null
      and r.entry_state in ('Draft', 'Returned')
      -- The person said no: the lead replaces or withdraws the entry; it never goes for review.
      and r.person_response is distinct from 'Declined'
    order by r.created_at, r.id
    for update
  loop
    -- Under a names lock a Draft stays a Draft; a Returned entry is still resubmitted.
    if v_locked and v_entry.entry_state = 'Draft' then
      v_drafts_held := v_drafts_held + 1;
      continue;
    end if;
    perform private.transition_lifecycle('roster_entry', 'app.engagement_roster_entries', 'entry_state',
      'app.roster_entry_state_transitions', 'roster_entry_id', v_entry.id, v_entry.entry_state::text, 'Submitted', 'Submitted.');
    v_count := v_count + 1;
  end loop;
  if v_count = 0 and v_drafts_held > 0 then
    perform private.refuse('roster_locked', 'Names are locked on this engagement. Ask the producing organization to change the roster.');
  end if;
  if v_count = 0 then
    perform private.refuse('roster_empty_submit', 'Add or change someone on the roster before submitting it.');
  end if;
  return v_count;
end;
$$;

comment on function private.submit_roster_entries(uuid) is 'The roster submit of an engagement (R4, from 4656), after the caller authorized: every non-self Draft or Returned entry naming a person who has not declined it moves to Submitted (an unclaimed invitation stays Draft; a declined entry stays for the lead to replace or withdraw, 904110601). Under a names lock (R5) only Returned entries move; it refuses roster_locked when nothing Returned is left and a Draft was held back, and roster_empty_submit when there is nothing to submit. app.submit_roster and api_public.submit_advance_roster (R10) call it. Returns how many were submitted.';
revoke all on function private.submit_roster_entries(uuid) from public, anon, authenticated;

create or replace function private.review_roster_entry_core(p_roster_entry_id uuid, p_outcome app.roster_entry_state, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.current_person_id();
  v_entry app.engagement_roster_entries;
  v_project uuid;
  v_submitter uuid;
begin
  select * into v_entry from app.engagement_roster_entries r where r.id = p_roster_entry_id and r.deleted_at is null for update;
  select e.project_id into v_project from app.engagements e where e.id = v_entry.engagement_id and e.deleted_at is null;
  if v_entry.id is null or v_project is null or not private.can_on_project(v_project, 'advancing.submission.review') then
    raise exception using errcode = '42501', message = 'advancing.submission.review is required on the engagement''s project';
  end if;
  if p_outcome is null or p_outcome not in ('Accepted', 'Returned') then
    perform private.refuse('roster_review_outcome', 'A reviewer accepts or returns a roster entry.');
  end if;
  if v_entry.entry_state <> 'Submitted' then
    perform private.refuse('roster_entry_not_submitted', 'Only a submitted roster entry is reviewed.');
  end if;
  -- Nobody is accepted onto a crew they declined; the entry is returned so the lead names someone else.
  if p_outcome = 'Accepted' and v_entry.person_response = 'Declined' then
    perform private.refuse('roster_entry_declined', 'This person declined their place on the roster. Return the entry so the company can name someone else.');
  end if;
  select t.created_by into v_submitter from app.roster_entry_state_transitions t
  where t.roster_entry_id = v_entry.id and t.to_state = 'Submitted'
  order by t.created_at desc, t.id desc limit 1;
  if v_me = private.roster_entry_creator(v_entry.id) or v_me = v_submitter then
    perform private.refuse('sod_roster_reviewer', 'Someone other than the person who added or submitted a roster entry reviews it.');
  end if;
  if p_outcome = 'Returned' and char_length(btrim(coalesce(p_reason, ''))) not between 1 and 500 then
    perform private.refuse('roster_review_reason', 'Say what to change, in 1 to 500 characters.');
  end if;
  return private.transition_lifecycle('roster_entry', 'app.engagement_roster_entries', 'entry_state',
    'app.roster_entry_state_transitions', 'roster_entry_id', v_entry.id, 'Submitted', p_outcome::text,
    coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'Accepted.'));
end;
$$;

comment on function private.review_roster_entry_core(uuid, app.roster_entry_state, text) is 'The review of one roster entry, shared by app.review_roster_entry and the bulk row: advancing.submission.review on the project, a Submitted entry, Accepted or Returned, never Accepted once its person declined (roster_entry_declined, 904110601), a reviewer other than its creator and its latest submitter (sod_roster_reviewer), and a reason of 1 to 500 characters to return. Returns the ledger entry id.';
revoke all on function private.review_roster_entry_core(uuid, app.roster_entry_state, text) from public, anon, authenticated;

comment on function app.review_roster_entry(uuid, app.roster_entry_state, text) is 'A reviewer of the producing org (advancing.submission.review) accepts a submitted roster entry or returns it with a reason of 1 to 500 characters. Refuses roster_review_outcome, roster_entry_not_submitted, roster_entry_declined (accepting someone who declined, 904110601), sod_roster_reviewer and roster_review_reason.';

-- private.pause_months (6893): a pause counts the months chosen, including one that resumes on a shorter month's last day.
begin;
select plan(8);

select is(private.pause_months('2026-11-30 12:00Z', private.pause_resume_at('2026-11-30 12:00Z', 3)), 3,
  'three months from the 30th of November resume on the 28th of February and still count 3');
select is(private.pause_months('2027-01-31 00:00Z', private.pause_resume_at('2027-01-31 00:00Z', 1)), 1,
  'one month from the 31st of January counts 1');
select is(private.pause_months('2028-01-31 08:30Z', private.pause_resume_at('2028-01-31 08:30Z', 1)), 1,
  'one month into a leap February counts 1');
select is(private.pause_months('2026-08-31 23:59Z', private.pause_resume_at('2026-08-31 23:59Z', 6)), 6,
  'six months from the 31st of August count 6');
select is(private.pause_months('2026-05-15 10:00Z', private.pause_resume_at('2026-05-15 10:00Z', 2)), 2,
  'a mid-month pause counts as before');
select is(private.pause_months('2026-05-15 10:00Z', '2026-07-20 10:00Z'), 2,
  'a pause whose dates Stripe set falls back to whole months of age');
select is(private.pause_months('2026-05-15 10:00Z', null), null::integer,
  'an open-ended pause has no months');
select ok(not has_function_privilege('authenticated', 'private.pause_months(timestamptz, timestamptz)', 'execute'),
  'only the definer functions read it');

select * from finish();
rollback;

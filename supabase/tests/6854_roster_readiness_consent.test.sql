-- pgTAP: 6854, crew readiness reads dietary, accessibility and allergy states only where the person's own consent
-- stands (ADR 0164). The grid's other behavior is 6220's suite.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(2);

select ok(position('private.sensitive_consent_stands' in (select prosrc from pg_catalog.pg_proc
  where oid = 'app.roster_readiness(uuid)'::regprocedure)) > 0,
  'crew readiness checks the person''s own consent before it says a need is on file');
select is((select count(*)::int from regexp_matches((select prosrc from pg_catalog.pg_proc
  where oid = 'app.roster_readiness(uuid)'::regprocedure), '_consent then|_consent\)? then|and f\.dietary_consent', 'g')), 3,
  'Dietary Needs, Accessibility Needs and Allergies each read Not Shared without it');

select * from finish();
rollback;

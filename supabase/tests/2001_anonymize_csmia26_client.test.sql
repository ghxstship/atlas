-- pgTAP: migration 2001, owner decision of 2026-10-24 on Linear RRR-67. The canon names nobody from the client of the
-- CSMIA26 activation, and private.rrr67_anonymize applies the ruling's table in order.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(7);

create function pg_temp.canon_mentions() returns integer
language plpgsql as $$
declare
  v_column record;
  v_count integer := 0;
  v_found integer;
begin
  for v_column in
    select c.table_name, c.column_name
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'xpms' and t.table_type = 'BASE TABLE' and c.data_type in ('text', 'character varying')
  loop
    execute format('select count(*) from xpms.%1$I where %2$I ~* %3$L', v_column.table_name, v_column.column_name,
      'spotify|isabella acker|isabella@') into v_found;
    v_count := v_count + v_found;
  end loop;
  return v_count;
end $$;

select is(pg_temp.canon_mentions(), 0, 'no canon text names the client of the CSMIA26 activation');
select is(private.rrr67_anonymize('Formal welcome remarks by Isabella Acker (Spotify) and Ashley Sumner (Tigre)'),
  'Formal welcome remarks by the client lead and Ashley Sumner (Tigre)', 'a longer phrase is replaced before a shorter one');
select is(private.rrr67_anonymize('Casa Spotify Wynwood Brand Toolkit & Style Guide'),
  'Brand House Wynwood Brand Toolkit & Style Guide', 'the activation is named Brand House');
select is(private.rrr67_anonymize('Acker'), 'Lead', 'a whole value is replaced whole');
select is(private.rrr67_anonymize('Hackers'), 'Hackers', 'a whole-value entry never touches a longer value');
select is(private.rrr67_anonymize('Truss steel is not delivered.'), 'Truss steel is not delivered.', 'other text is unchanged');
select ok(not has_function_privilege('authenticated', 'private.rrr67_anonymize(text)', 'execute'),
  'signed-in callers cannot run the anonymizer');

select * from finish();
rollback;

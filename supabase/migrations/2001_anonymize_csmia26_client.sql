-- Owner decision of 2026-10-24 on Linear RRR-67: everything relating to the client of the CSMIA26 activation is
-- anonymized. The canon importer now writes the seed with the client anonymized (canon/rulings/rrr-67.yaml,
-- canon/import/src/rrr67.ts), so a database built from 0150 today holds none of it. A database that applied the
-- earlier 0150, staging and production among them, still names the client in seven canon items, one sightline,
-- the Production Template's cells and four withheld Standard Library rows; this migration rewrites them.
--
-- The owner also decided that every org receives all 34 Standard Library SOPs and 34 documents, so the rows written
-- from the activation are generalized too (migration 2002 then releases them): private.rrr67_generalize makes their
-- site, the agencies that permitted it and its permit numbers generic, in xpms.std_sop and xpms.std_document_library
-- only. Elsewhere the canon keeps its real jurisdictions, Miami-Dade among them.
--
-- private.rrr67_anonymize holds the ruling's table: a whole value is replaced first, then each phrase in the
-- ruling's order. The update walks every stored text column of every xpms table (a generated column follows its
-- source) and changes only values that match, so it is a no-op on a database seeded by the regenerated 0150. Org copies (migration 1612) never carried the
-- client: the four rows that name it are on private.standard_library_withheld and were never copied.
--
-- Second migration of the orchestrator's fourth block, 2000 to 2009 (ADR 0022 amendment of 2026-10-24).

create or replace function private.rrr67_anonymize(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_value
    when 'Isabella' then 'Client'
    when 'Acker' then 'Lead'
    when 'Izzy' then 'Client'
    when '13-4029182' then '00-0000000'
    else
      replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
      replace(replace(replace(replace(replace(p_value,
        'isabella@spotify.com', 'client.lead@example.com'),
        'https://www.spotify.com', 'https://www.example.com'),
        'Isabella Acker (Spotify)', 'the client lead'),
        'Isabella Acker', 'Client Lead'),
        'Casa Spotify Brand Toolkit', 'Brand House Toolkit'),
        'Casa Spotify Wynwood', 'Brand House Wynwood'),
        'Casa Spotify Miami', 'Brand House Miami'),
        'Casa Spotify', 'Brand House'),
        'Spotify House Austin', 'Brand House Austin'),
        'Spotify Branding Integration Elements', 'Client Branding Integration Elements'),
        'Spotify-green', 'brand-green'),
        'official Spotify logo bugs', 'official client logo bugs'),
        'GHXSTSHIP, Spotify, and Venue Owner', 'GHXSTSHIP, the client, and Venue Owner'),
        'permitting led by Spotify', 'permitting led by the client'),
        'BY OWNER (Spotify)', 'BY OWNER (client)'),
        'SPOTIFY', 'CLIENT'),
        'Spotify', 'Client'),
        'spotify', 'client')
  end;
$$;

comment on function private.rrr67_anonymize(text) is 'The RRR-67 ruling (canon/rulings/rrr-67.yaml): a canon value with the client of the CSMIA26 activation anonymized. A whole value is replaced first, then each phrase in order.';
revoke all on function private.rrr67_anonymize(text) from public, anon, authenticated;

create or replace function private.rrr67_generalize(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select
      replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(p_value,
        'Permit EL-2026-04421 on file', 'Electrical permit on file'),
        'Permit EL-2026-04421 with master electrician', 'Electrical permit with master electrician'),
        'Assembly permit BD-2026-08914 approved', 'Assembly permit approved'),
        'Permit BD-2026-08914 issued under', 'Assembly permit issued under'),
        'toward Biscayne property boundary', 'toward the nearest property boundary'),
        'and Biscayne perimeter SPL', 'and perimeter SPL'),
        'along Biscayne Blvd', 'along the property boundary'),
        'to satisfy Wynwood / Biscayne perimeter noise curfew', 'to satisfy the perimeter noise curfew'),
        'rideshare dispatch hub on 76th St.', 'rideshare dispatch hub on the adjacent street.'),
        'City of Miami / FDOT MOT permit active', 'City and state DOT MOT permit active'),
        'deployed along 76th St.', 'deployed along the closed street.'),
        'City of Miami Public Works / FDOT curb-lane closure permit and traffic control staging for 76th St.', 'Public works and state DOT curb-lane closure permit and traffic control staging for the closed street.'),
        'using Brand House Wynwood LUT', 'using the client brand LUT'),
        'Brand House Wynwood Brand Toolkit & Style Guide', 'Client Brand Toolkit & Style Guide'),
        '& Wynwood Perimeter SPL Curfew Enforcement', '& Perimeter SPL Curfew Enforcement'),
        'across Wynwood venue airspace', 'across the venue airspace'),
        'City of Miami Fire-Rescue permit active', 'Fire-rescue permit active'),
        'Miami Fire watch on duty', 'fire watch on duty'),
        'City of Miami Chapter 36 Noise Ordinance and perimeter', 'Local noise ordinance and perimeter'),
        'Miami-Dade Fire Rescue medical plan active', 'County fire rescue medical plan active'),
        'transfer to Miami-Dade Fire Rescue ALS transport unit', 'transfer to the county fire rescue ALS transport unit'),
        'City of Miami approved security overlay', 'City-approved security overlay'),
        'loaded with Miami broadcast exclusions', 'loaded with local broadcast exclusions'),
        '& Miami-Dade DERM temporary fuel transfer protocol', '& county environmental temporary fuel transfer protocol'),
        '& Miami-Dade WASD temporary potable water', '& county water utility temporary potable water'),
        'direct dispatch link to Miami 911 PSAP', 'direct dispatch link to the local 911 PSAP'),
        'responding Miami Fire/Police commanders', 'responding fire and police commanders'),
        'City of Miami Special Assembly Occupancy Permit', 'Special Assembly Occupancy Permit'),
        'Miami Fire-Rescue Special Effects & Flame Effects Permit', 'Fire-Rescue Special Effects & Flame Effects Permit'),
        'City of Miami Fire-Rescue NFPA 160', 'Fire-rescue NFPA 160'),
        'City of Miami Code Compliance Noise Variance', 'Code Compliance Noise Variance'),
        '& Miami-Dade EMS Detail', '& County EMS Detail'),
        'Miami-Dade Fire Rescue approved EMS plan', 'County fire rescue approved EMS plan'),
        'EPA / Miami-Dade DERM secondary containment', 'EPA and county environmental secondary containment'),
        'naming City of Miami and Client as additional insureds', 'naming the city and the client as additional insureds'),
        'Miami-Dade WASD backflow prevention', 'County water utility backflow prevention');
$$;

comment on function private.rrr67_generalize(text) is 'The library part of the RRR-67 ruling (canon/rulings/rrr-67.yaml, library_replacements): a Standard Library SOP or document value, already anonymized, with the activation''s site, the agencies that permitted it and its permit numbers made generic, so every org can receive it.';
revoke all on function private.rrr67_generalize(text) from public, anon, authenticated;

do $$
declare
  v_column record;
begin
  for v_column in
    select c.table_name, c.column_name
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'xpms' and t.table_type = 'BASE TABLE' and c.data_type in ('text', 'character varying')
      and c.is_generated = 'NEVER'
    order by c.table_name, c.column_name
  loop
    if v_column.table_name in ('std_sop', 'std_document_library') then
      execute format(
        'update xpms.%1$I set %2$I = private.rrr67_generalize(private.rrr67_anonymize(%2$I)) where %2$I is distinct from private.rrr67_generalize(private.rrr67_anonymize(%2$I))',
        v_column.table_name, v_column.column_name);
    else
      execute format(
        'update xpms.%1$I set %2$I = private.rrr67_anonymize(%2$I) where %2$I is distinct from private.rrr67_anonymize(%2$I)',
        v_column.table_name, v_column.column_name);
    end if;
  end loop;
end $$;

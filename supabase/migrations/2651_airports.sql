-- 2651_airports.sql
-- R5 Project facts (RRR-184, ADR 0102 section 1). The airports a travel request names: a platform reference table, one
-- row per IATA code, seeded by 2652 from packages/schemas/airports/airports.csv (`pnpm --filter @xos/schemas
-- generate:airports`). app.roster_travel_requests (2654) references it for the inbound and outbound airport, so a code
-- is checked once, here, and the name a coordinator reads is never copied onto the request.
--
-- Platform data, not tenant data: no org_id and no audit columns (registered in docs/adr/denormalization-register.yaml
-- under tenant_exceptions). Every signed-in person reads the active rows; nobody writes them but migrations.

create table app.airports (
  iata_code char(3) primary key,
  name text not null,
  municipality text,
  country_code char(2) not null,
  is_active boolean not null default true,
  constraint airports_iata_code_format check (iata_code ~ '^[A-Z]{3}$'),
  constraint airports_name_length check (char_length(btrim(name)) between 1 and 200),
  constraint airports_municipality_length check (municipality is null or char_length(btrim(municipality)) between 1 and 120),
  constraint airports_country_code_format check (country_code ~ '^[A-Z]{2}$')
);

create index airports_name_lower_idx on app.airports (lower(name));
create index airports_country_code_idx on app.airports (country_code);

comment on table app.airports is 'Airports with scheduled passenger service, by IATA code (R5, ADR 0102): the inbound and outbound airport of a roster travel request. Platform reference data seeded by migration from packages/schemas/airports/airports.csv, not tenant data.';
comment on column app.airports.iata_code is 'Three-letter IATA airport code, uppercase.';
comment on column app.airports.name is 'Airport name as published, for example Miami International Airport.';
comment on column app.airports.municipality is 'City or town the airport serves; NULL when the source gives none.';
comment on column app.airports.country_code is 'ISO 3166-1 alpha-2 country code of the airport.';
comment on column app.airports.is_active is 'False for an airport no longer offered for new travel requests; existing requests keep their reference.';

alter table app.airports enable row level security;
revoke all on app.airports from public, anon, authenticated;
grant select on app.airports to authenticated, service_role;
-- Active rows only; the signed-in check keeps the policy in the shape invariant 5 requires (pgTAP 0205).
create policy airports_read on app.airports for select to authenticated using ((select auth.uid()) is not null and is_active);

# ADR 0002: Schema Conventions

- Status: Accepted (part of the Wave 1 contract freeze)
- Date: 2026-10-08
- Decider: Orchestrator (Wave 0)

## Context

Sections 3, 7.1 and 7.5 set product law for the database. Every data agent (A01, A02, A03, A18, A19, A25, A28, A29, A30) writes migrations against the same rules, so the rules live in one place.

## Decision

### Schemas

| Schema         | Holds                                             | Exposed through the API |
| -------------- | ------------------------------------------------- | ----------------------- |
| `xpms`         | Canon, populated only by the importer             | Yes, read-only          |
| `app`          | Tenant operational data                           | Yes, under RLS          |
| `api_public`   | Column-scoped projections for `anon`              | Yes                     |
| `api_external` | Column-allowlisted projections for external users | Yes                     |
| `private`      | RLS helpers, plan limits, invariant helpers       | Never                   |
| `extensions`   | Relocatable extensions                            | Never                   |

`pg_cron` and `supabase_vault` are not relocatable, so they stay in the schemas their control files fix (`pg_catalog` with `cron`, and `vault`). Every other extension in Section 5 lives in `extensions`. Created in `0001_foundation.sql`.

### Keys and identity

- Primary keys on non-canon tables are `uuid` defaulting to `private.uuid_v7()`. Postgres 17 has no native generator, so the foundation migration provides one (RFC 9562, version 7, millisecond time prefix).
- Canon tables use their natural codes as primary keys: `dept_code`, `disc_code`, `cat_urid`, `phase_code`, `criterion_id`.
- Display keys (`{projectKey}-{sequence}`) and item IDs (`{URID}-{ORG}-{SEQ}`) come only from `next_sequence`.

### Tenant tables

- Columns on every tenant table: `org_id uuid not null`, `created_at`, `created_by`, `updated_at`, `updated_by`, `deleted_at`.
- `org_id` is derived from the parent row by trigger on insert and never accepted from the caller. A second trigger refuses any change of `org_id`. A third refuses cross-org foreign keys on insert and update.
- Every foreign key has a supporting index. Every column used by an RLS policy is indexed.
- Soft delete sets `deleted_at`. Each table states its retention in `app.retention_policies`; a pg_cron job purges.

### Values

- Money is `bigint` minor units plus a `char(3)` ISO 4217 code. The exponent comes from one currency reference table.
- NULL means unpriced. Money columns never carry a default. Aggregates of NULL are NULL with an unpriced count beside them.
- Instants are `timestamptz`. A typed local time is stored with the IANA zone it was entered in.
- Closed lists are Postgres enums or reference tables. Display labels come from i18n catalogs keyed by the stored value.
- No arrays of identifiers. Relationships use junction tables. JSON columns only for rich text documents, audit diffs and provider payloads.

### Lifecycles

- Each lifecycle in Section 3.12 and 4.4.4 has a `*_state` column and a `*_state_transitions` ledger written only by its transition RPC. Transitions use compare-and-set on the expected current state.
- `status` is a permitted identifier for sync status, delivery status and derived health (Section 3.6). The importer does not carry the Bible tab 17 ban into lint rules or constraints.

### Functions and policies

- Every function sets `search_path = ''` and schema-qualifies every reference.
- SECURITY DEFINER functions are revoked from `anon`, except named token RPCs.
- RLS policies call `(select auth.uid())` in a subselect, use helpers from `private`, and pair read and write halves that agree.

### Normal form and documentation

- Third Normal Form. Derived values are views, generated columns or registered materialized views (`docs/adr/denormalization-register.md`).
- Every table and column carries `comment on`. Comments feed the generated data dictionary.
- Coded lists sort in numeric code order by default.
- No em dash in canon or verbiage text; check constraints enforce it.

## Alternatives considered

- `pg_uuidv7` extension: rejected, because it is not available on hosted Supabase.
- Separate `xos` schema for 4.0 grammar: rejected by Section 3.1.

## Consequences

A22 reviews every migration against this ADR (Section 18, gate 29). A change to any rule here after the contract freeze needs a superseding ADR.

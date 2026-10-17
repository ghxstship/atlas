-- 1114_a42_foreign_key_indexes.sql
-- A42: every foreign key is backed by an index led by its column (pgTAP 0202 and 0369). Covers the two
-- foreign keys the A42 private tables added: the capability a project role grants (1110) and the person a
-- deleted account belonged to (1112).

create index project_role_capabilities_capability_code_idx on private.project_role_capabilities (capability_code);
create index account_deletions_person_id_idx on private.account_deletions (person_id);

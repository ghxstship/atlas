-- 0363_medical_notes_encryption.sql
-- A03 Domain Data (RRR-71, requested by A14 under Sections 9 and 14.3). Field-level encryption of the
-- Restricted medical treatment notes on app.medical_encounters, following the tax identifier pattern
-- (0730): pgcrypto symmetric encryption under a key held in Vault.
--   * treatment_notes becomes bytea ciphertext; any existing plaintext is encrypted in place
--   * plaintext enters only through app.record_medical_encounter and app.update_medical_encounter;
--     signed-in callers cannot insert or update the column, and a trigger refuses any change outside
--     those RPCs
--   * plaintext leaves only through app.medical_encounters_masked, for holders of
--     data.restricted.read.medical in the encounter's org
-- The decrypting helper takes column values (org and ciphertext) as arguments and never re-reads the
-- table (ADR 0016 crash rule). The column keeps its name, so its Restricted classification and the
-- export exclusion (0530) stay in force.

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'xos_medical_notes_key') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'xos_medical_notes_key',
      'Symmetric key that encrypts medical treatment notes on app.medical_encounters (Sections 8.3, 9 and 14.3).');
  end if;
end $$;

create or replace function private.medical_notes_key()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'xos_medical_notes_key';
$$;

comment on function private.medical_notes_key() is 'The Vault key that encrypts medical treatment notes. Never granted to signed-in callers.';
revoke all on function private.medical_notes_key() from public, anon, authenticated;

-- Encrypt the column in place ------------------------------------------------------------------------------

drop view app.medical_encounters_masked;

alter table app.medical_encounters
  alter column treatment_notes type bytea
  using case when treatment_notes is null then null else extensions.pgp_sym_encrypt(treatment_notes, private.medical_notes_key()) end;

comment on column app.medical_encounters.treatment_notes is 'Treatment given, encrypted with pgp_sym_encrypt under the Vault key xos_medical_notes_key. Restricted (data.restricted.read.medical): never selectable or writable by signed-in callers; written through app.record_medical_encounter and app.update_medical_encounter and read decrypted through app.medical_encounters_masked.';
comment on table app.medical_encounters is 'Medical encounters at an incident. Treatment notes are Restricted (data.restricted.read.medical) and field-encrypted: written only through app.record_medical_encounter and app.update_medical_encounter, read only through app.medical_encounters_masked.';

-- Signed-in callers write the other columns directly but never the notes.
revoke insert, update on app.medical_encounters from authenticated;
grant insert (incident_id, patient_description, disposition) on app.medical_encounters to authenticated;
grant update (patient_description, disposition, deleted_at) on app.medical_encounters to authenticated;

create or replace function private.guard_medical_notes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT' and new.treatment_notes is not null)
     or (tg_op = 'UPDATE' and new.treatment_notes is distinct from old.treatment_notes) then
    if not private.in_trusted_operation('medical_notes_write') then
      perform private.refuse('medical_notes_rpc_only', 'Treatment notes are written only through app.record_medical_encounter or app.update_medical_encounter, which encrypt them.');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_medical_notes() is 'Medical encounters: treatment notes change only inside the encrypting RPCs, so plaintext never reaches the column.';
revoke all on function private.guard_medical_notes() from public, anon, authenticated;

create trigger t41_guard_medical_notes before insert or update on app.medical_encounters
  for each row execute function private.guard_medical_notes();

-- Decryption ----------------------------------------------------------------------------------------------------

create or replace function private.medical_notes_plaintext(p_org_id uuid, p_ciphertext bytea)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when p_ciphertext is not null and private.has_capability(p_org_id, 'data.restricted.read.medical')
              then extensions.pgp_sym_decrypt(p_ciphertext, private.medical_notes_key()) end;
$$;

comment on function private.medical_notes_plaintext(uuid, bytea) is 'Decrypts treatment notes for a holder of data.restricted.read.medical in the given org; NULL for everyone else. Takes the org and ciphertext as values (ADR 0016 crash rule). Signed-in callers cannot select the ciphertext, so they reach it only through app.medical_encounters_masked.';
revoke all on function private.medical_notes_plaintext(uuid, bytea) from public, anon;
grant execute on function private.medical_notes_plaintext(uuid, bytea) to authenticated, service_role;

create view app.medical_encounters_masked as
select m.id, m.org_id, m.incident_id, m.patient_description, m.disposition,
  private.medical_notes_plaintext(m.org_id, m.treatment_notes) as treatment_notes,
  not private.has_capability(m.org_id, 'data.restricted.read.medical') as is_masked
from app.medical_encounters m
where m.deleted_at is null
  and m.incident_id in (select i.id from app.incidents i where i.project_id in (select private.project_ids_with('safety.incident.read')));

call private.describe('app.medical_encounters_masked', 'Medical encounters with the Restricted, encrypted treatment notes decrypted only for holders of data.restricted.read.medical; masked (NULL, is_masked true) for everyone else.', array[
  'id', 'Encounter.', 'org_id', 'Org.', 'incident_id', 'Incident.', 'patient_description', 'Who was treated.', 'disposition', 'Outcome.',
  'treatment_notes', 'Treatment given, decrypted, or NULL when masked or unrecorded.', 'is_masked', 'True when the notes are withheld from the caller.'
]);
revoke all on app.medical_encounters_masked from public, anon;
grant select on app.medical_encounters_masked to authenticated, service_role;

-- Write path --------------------------------------------------------------------------------------------------------

create or replace function app.record_medical_encounter(p_incident_id uuid, p_patient_description text,
  p_treatment_notes text default null, p_disposition text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project uuid := (select i.project_id from app.incidents i where i.id = p_incident_id and i.deleted_at is null);
  v_id uuid;
begin
  perform private.require_person();
  if v_project is null or not private.can_on_project(v_project, 'safety.incident.write') then
    raise exception using errcode = '42501', message = 'safety.incident.write is required on the incident''s project';
  end if;
  if p_treatment_notes is not null and char_length(btrim(p_treatment_notes)) = 0 then
    perform private.refuse('medical_notes_blank', 'Leave treatment notes out rather than recording them blank.');
  end if;
  perform private.begin_trusted_operation('medical_notes_write');
  insert into app.medical_encounters (incident_id, patient_description, treatment_notes, disposition)
  values (p_incident_id, p_patient_description,
    case when p_treatment_notes is null then null else extensions.pgp_sym_encrypt(btrim(p_treatment_notes), private.medical_notes_key()) end,
    p_disposition)
  returning id into v_id;
  perform private.end_trusted_operation('medical_notes_write');
  return v_id;
end;
$$;

comment on function app.record_medical_encounter(uuid, text, text, text) is 'Records a medical encounter at an incident, encrypting the treatment notes before they reach the table. Needs safety.incident.write on the incident''s project. Returns the encounter id.';

create or replace function app.update_medical_encounter(p_medical_encounter_id uuid, p_patient_description text default null,
  p_treatment_notes text default null, p_disposition text default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project uuid := (select i.project_id from app.medical_encounters m join app.incidents i on i.id = m.incident_id
                     where m.id = p_medical_encounter_id and m.deleted_at is null);
begin
  perform private.require_person();
  if v_project is null or not private.can_on_project(v_project, 'safety.incident.write') then
    raise exception using errcode = '42501', message = 'safety.incident.write is required on the incident''s project';
  end if;
  if p_treatment_notes is not null and char_length(btrim(p_treatment_notes)) = 0 then
    perform private.refuse('medical_notes_blank', 'Leave treatment notes out rather than recording them blank.');
  end if;
  perform private.begin_trusted_operation('medical_notes_write');
  update app.medical_encounters set
    patient_description = coalesce(p_patient_description, patient_description),
    disposition = coalesce(p_disposition, disposition),
    treatment_notes = case when p_treatment_notes is null then treatment_notes
                           else extensions.pgp_sym_encrypt(btrim(p_treatment_notes), private.medical_notes_key()) end
  where id = p_medical_encounter_id;
  perform private.end_trusted_operation('medical_notes_write');
end;
$$;

comment on function app.update_medical_encounter(uuid, text, text, text) is 'Updates a medical encounter; a NULL argument keeps the current value. New treatment notes are encrypted before they reach the table. Needs safety.incident.write on the incident''s project.';

revoke all on function app.record_medical_encounter(uuid, text, text, text) from public, anon;
revoke all on function app.update_medical_encounter(uuid, text, text, text) from public, anon;
grant execute on function app.record_medical_encounter(uuid, text, text, text) to authenticated, service_role;
grant execute on function app.update_medical_encounter(uuid, text, text, text) to authenticated, service_role;

-- 0639_integration_connection_removal.sql
-- A19 Integrations. Removing a connection (the API's integrations.delete and the settings page):
--   * a connection is removed (soft deleted) only once it is Disconnected, so its Vault secret is always destroyed
--     first and no credential outlives a removed connection (Section 9)
--   * a Disconnected connection stays frozen except for that removal
-- Replaces private.guard_integration_connection from 0600; every other rule of 0600 is unchanged.

create or replace function private.guard_integration_connection()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_feature app.plan_feature_code;
  v_removal_only boolean;
begin
  if tg_op = 'INSERT' then
    select p.required_feature into v_feature from private.integration_providers p where p.provider_code = new.provider_code;
    if v_feature is not null and not private.org_has_feature(new.org_id, v_feature) then
      perform private.refuse('integration_plan_feature',
        format('Connecting %s needs a plan with the %s feature.', new.provider_code, v_feature));
    end if;
    if not private.in_trusted_operation('integration_credential') then
      new.credential_kind := null;
      new.credential_stored_at := null;
      new.credential_expires_at := null;
    end if;
    new.last_synced_at := null;
    new.last_error_code := null;
    new.last_error_message := null;
    return new;
  end if;
  if new.provider_code <> old.provider_code then
    perform private.refuse('integration_provider_fixed', 'A connection keeps its provider; connect the other provider separately.');
  end if;
  if new.deleted_at is not null and old.deleted_at is null and old.connection_state <> 'Disconnected' then
    perform private.refuse('integration_disconnect_first', 'Disconnect the connection before removing it, so its credential is destroyed.');
  end if;
  v_removal_only := (to_jsonb(new) - array['deleted_at', 'updated_at', 'updated_by']) = (to_jsonb(old) - array['deleted_at', 'updated_at', 'updated_by']);
  if old.connection_state = 'Disconnected' and not private.in_trusted_operation('integration_connection_transition') and not v_removal_only then
    perform private.refuse('integration_disconnected', 'A disconnected connection is kept for its history and cannot change.');
  end if;
  if not private.in_trusted_operation('integration_credential')
     and (new.credential_kind is distinct from old.credential_kind
       or new.credential_stored_at is distinct from old.credential_stored_at
       or new.credential_expires_at is distinct from old.credential_expires_at) then
    perform private.refuse('integration_credential_rpc_only', 'Credential details change only through app.store_integration_credential.');
  end if;
  if not private.in_trusted_operation('integration_sync_runner')
     and (new.last_synced_at is distinct from old.last_synced_at
       or new.last_error_code is distinct from old.last_error_code
       or new.last_error_message is distinct from old.last_error_message) then
    perform private.refuse('integration_sync_fields_runner_only', 'Sync results are written only by the integration runner.');
  end if;
  return new;
end;
$$;

comment on function private.guard_integration_connection() is 'Connections: the provider''s plan feature is required on insert; the provider is fixed; only a Disconnected connection is removed, and otherwise it is frozen; credential metadata changes only through app.store_integration_credential and sync results only through the runner RPCs.';

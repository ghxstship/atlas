-- 2280_separation_of_duties_options.sql
-- A135 (RRR-197), trace row S4.5.6-23, Section 8.2: "an org may tighten separation of duties but never remove it".
-- The rules every org keeps stay as they are (0320, 1150). This adds the stricter options an org may switch on, and
-- the per-org record of which are on (ADR 0113).
--   * private.separation_of_duties_rules gains tightens: NULL for a built-in rule, and for an option the built-in
--     rule it tightens. Options live in the same registry, so the 1150 catalog check (every sod_ code a function
--     refuses with is registered) covers them, and their refusals name the code and sentence the same way.
--   * app.separation_of_duties_rules lists only the built-in rules, as before; app.separation_of_duties_options
--     lists the options.
--   * app.org_separation_of_duties_options: one row per option an org has switched on. A built-in rule never has a
--     row, so there is nothing to switch off. Written through app.set_separation_of_duties_option or directly,
--     under org.separation_of_duties.write; every change is audited.
-- The checks that read the options are 2281.

-- Registry ----------------------------------------------------------------------------------------------------------

alter table private.separation_of_duties_rules
  add column tightens text references private.separation_of_duties_rules (code);

alter table private.separation_of_duties_rules
  add constraint separation_of_duties_rules_tightens_other check (tightens is distinct from code);
create index separation_of_duties_rules_tightens_idx on private.separation_of_duties_rules (tightens);

comment on table private.separation_of_duties_rules is 'The separation of duties rules (Section 8.2). Each is a database check whose refusal names the rule code. Built-in rules (tightens NULL) hold for every org and cannot be removed; options (tightens set) hold only where an org switched them on (app.org_separation_of_duties_options).';
comment on column private.separation_of_duties_rules.tightens is 'For an option an org may switch on, the built-in rule it tightens; NULL for a built-in rule, which every org keeps.';

insert into private.separation_of_duties_rules (code, enforced_on, description, tightens) values
  ('sod_document_creator', 'Purchase orders, change orders, invoices, requisitions, expenses, payroll runs, settlements',
   'Whoever created an approvable document cannot approve it or decide a step of its approval.', 'sod_approval_requester'),
  ('sod_receiver_po_approver', 'Goods receipts',
   'Goods are received by someone other than a person who approved the purchase order or a change to it.', 'sod_po_creator'),
  ('sod_change_order_requester_steps', 'Change orders',
   'The requester of a change order cannot decide any step of its approval.', 'sod_change_order_requester')
on conflict (code) do nothing;

create or replace view app.separation_of_duties_rules as
select r.code, r.enforced_on, r.description from private.separation_of_duties_rules r
where r.tightens is null;

comment on view app.separation_of_duties_rules is 'The separation of duties rules the database enforces for every org, with the rule codes refusals name. Options an org may add are app.separation_of_duties_options.';
comment on column app.separation_of_duties_rules.code is 'Rule code.';
comment on column app.separation_of_duties_rules.enforced_on is 'Documents the rule covers.';
comment on column app.separation_of_duties_rules.description is 'The rule.';

create view app.separation_of_duties_options as
select r.code, r.tightens, r.enforced_on, r.description from private.separation_of_duties_rules r
where r.tightens is not null;

comment on view app.separation_of_duties_options is 'The stricter separation of duties options an org may switch on (Section 8.2, ADR 0113). Which are on is app.org_separation_of_duties_options.';
comment on column app.separation_of_duties_options.code is 'Option code, the prefix of its refusal.';
comment on column app.separation_of_duties_options.tightens is 'The built-in rule the option tightens.';
comment on column app.separation_of_duties_options.enforced_on is 'Documents the option covers.';
comment on column app.separation_of_duties_options.description is 'The option in a sentence, as its refusal says it.';

revoke all on app.separation_of_duties_options from public, anon;
grant select on app.separation_of_duties_options to authenticated, service_role;
revoke select on app.separation_of_duties_options from xos_backup;

-- Options an org switched on ----------------------------------------------------------------------------------------

create table app.org_separation_of_duties_options (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  rule_code text not null references private.separation_of_duties_rules (code)
);

call private.install_domain_table('app.org_separation_of_duties_options');
create unique index org_separation_of_duties_options_key on app.org_separation_of_duties_options (org_id, rule_code)
  where deleted_at is null;
create index org_separation_of_duties_options_rule_code_idx on app.org_separation_of_duties_options (rule_code);
call private.describe('app.org_separation_of_duties_options', 'A stricter separation of duties option the org switched on (Section 8.2, ADR 0113). Only options can have a row; the built-in rules hold for every org and are never switched. Switching an option off soft-deletes its row. Set in Settings, Separation of Duties.', array[
  'rule_code', 'Option code (app.separation_of_duties_options), never a built-in rule.'
]);

call private.install_policies('app.org_separation_of_duties_options',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('org.separation_of_duties.write'))$$);
call private.install_audit_trail('app.org_separation_of_duties_options');

create or replace function private.guard_org_separation_of_duties_option()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.rule_code <> old.rule_code then
    perform private.refuse('separation_option_immutable', 'An option row keeps its option; switch it off and switch on another.');
  end if;
  if not exists (select 1 from private.separation_of_duties_rules r where r.code = new.rule_code and r.tightens is not null) then
    perform private.refuse('separation_option_unknown',
      format('%s is not an option an org can switch; the built-in rules are always on.', new.rule_code));
  end if;
  return new;
end;
$$;

comment on function private.guard_org_separation_of_duties_option() is 'Org separation of duties options: only an option (never a built-in rule) can have a row, and a row keeps its option.';

create trigger t40_guard_org_separation_of_duties_option before insert or update on app.org_separation_of_duties_options
  for each row execute function private.guard_org_separation_of_duties_option();

-- Helpers -------------------------------------------------------------------------------------------------------------

create or replace function private.separation_option_on(p_org_id uuid, p_rule_code text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.org_separation_of_duties_options o
    where o.org_id = p_org_id and o.rule_code = p_rule_code and o.deleted_at is null
  );
$$;

comment on function private.separation_option_on(uuid, text) is 'True when the org switched on the separation of duties option (app.org_separation_of_duties_options).';
revoke all on function private.separation_option_on(uuid, text) from public, anon, authenticated;

-- RPC -----------------------------------------------------------------------------------------------------------------

create or replace function app.set_separation_of_duties_option(p_org_id uuid, p_rule_code text, p_on boolean)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_person();
  if p_org_id is null or p_org_id not in (select private.orgs_with_capability('org.separation_of_duties.write')) then
    raise exception using errcode = '42501', message = 'org.separation_of_duties.write is required to change separation of duties options';
  end if;
  if p_on is null then
    perform private.refuse('separation_option_choice', 'Say whether the option is on or off.');
  end if;
  if not exists (select 1 from private.separation_of_duties_rules r where r.code = p_rule_code and r.tightens is not null) then
    perform private.refuse('separation_option_unknown',
      format('%s is not an option an org can switch; the built-in rules are always on.', coalesce(p_rule_code, 'An empty code')));
  end if;
  if p_on then
    insert into app.org_separation_of_duties_options (org_id, rule_code)
    select p_org_id, p_rule_code
    where not exists (select 1 from app.org_separation_of_duties_options o
                      where o.org_id = p_org_id and o.rule_code = p_rule_code and o.deleted_at is null);
  else
    update app.org_separation_of_duties_options set deleted_at = now()
    where org_id = p_org_id and rule_code = p_rule_code and deleted_at is null;
  end if;
  return p_on;
end;
$$;

comment on function app.set_separation_of_duties_option(uuid, text, boolean) is 'Switches a stricter separation of duties option on or off for an org (Section 8.2, ADR 0113; org.separation_of_duties.write). Only options switch: a built-in rule code is refused (separation_option_unknown). Repeating a choice changes nothing. Each change is audited. Returns the option''s new state.';

-- Retention -----------------------------------------------------------------------------------------------------------

call private.install_default_retention('app.org_separation_of_duties_options', interval '90 days');

-- Privileges ----------------------------------------------------------------------------------------------------------

revoke all on function private.guard_org_separation_of_duties_option() from public, anon, authenticated;
revoke all on function app.set_separation_of_duties_option(uuid, text, boolean) from public, anon;
grant execute on function app.set_separation_of_duties_option(uuid, text, boolean) to authenticated;

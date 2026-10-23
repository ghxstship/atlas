-- 1541_canon_label_translations.sql
--
-- A97 (RRR-142, A65-028, WP21; ADR 0053). Section 15: "Canon labels are translatable through xpms.dim_locale and
-- translation tables. Codes are never translated."
--   * xpms.canon_vocabulary: the vocabularies whose labels people read (departments, disciplines, categories,
--     phases, tiers, teams, roles, job titles, record kinds, classes, states and subtypes, worker
--     classifications, grades, GL accounts, emergency codes, Standard Library enumerations, regions, cost
--     center templates and counterparty types), each naming the canon table, code column and label column.
--   * xpms.canon_label: one translated label per vocabulary, canon code and locale (xpms.dim_locale). en-US is
--     never stored: the canon tables hold it.
--   * xpms.canon_labels(vocabulary, locale) and xpms.canon_label_of(vocabulary, code, locale): the one way to
--     read a label, the locale's translation when there is one and en-US otherwise.
--   * xpms.put_canon_labels: how migrations load a locale's labels for a vocabulary, from
--     packages/i18n/canon/<locale>/<vocabulary>.json (`pnpm --filter @xos/i18n canon:sql`).
--   * es-US is seeded from the labels the app catalogs already held for canon codes: phases, record kinds,
--     classes, states and subtypes, and worker classifications. The rest arrive through the Google Translate
--     pipeline (ADR 0037, the `canon` surface) and a later migration.
-- Canon stays read-only to authenticated users and is written only by the migration owner and service_role, as
-- 0199 gives every xpms table.

create table xpms.canon_vocabulary (
  vocabulary xpms.canon_code not null,
  ordinal integer not null check (ordinal > 0),
  source_table regclass not null,
  code_column xpms.canon_code not null,
  parent_column xpms.canon_code,
  label_column xpms.canon_code not null,
  description xpms.canon_text not null,
  primary key (vocabulary),
  unique (ordinal)
);
comment on table xpms.canon_vocabulary is 'Canon vocabularies whose labels are translated (Section 15, ADR 0053): where each one''s codes and English labels live. The vocabulary id names its label file in packages/i18n/canon/<locale>/.';
comment on column xpms.canon_vocabulary.vocabulary is 'Vocabulary id, for example department or jobTitle.';
comment on column xpms.canon_vocabulary.ordinal is 'Display order.';
comment on column xpms.canon_vocabulary.source_table is 'The canon table holding the codes and their English labels.';
comment on column xpms.canon_vocabulary.code_column is 'Column holding the code. Codes are never translated.';
comment on column xpms.canon_vocabulary.parent_column is 'For a two-column key, the column that scopes the code; the stored code is <parent>/<code> (record subtypes, scoped by kind). NULL otherwise.';
comment on column xpms.canon_vocabulary.label_column is 'Column holding the English (en-US) label.';
comment on column xpms.canon_vocabulary.description is 'What the vocabulary is, in English.';

create table xpms.canon_label (
  vocabulary xpms.canon_code not null references xpms.canon_vocabulary (vocabulary),
  code xpms.canon_code not null,
  locale_code xpms.canon_code not null references xpms.dim_locale (locale_code),
  label xpms.canon_text not null check (btrim(label) <> ''),
  provenance xpms.canon_code not null check (provenance in ('catalog', 'machine', 'human')),
  updated_at timestamptz not null default now(),
  primary key (vocabulary, code, locale_code),
  check (locale_code <> 'en-US')
);
comment on table xpms.canon_label is 'Translated canon labels, one per vocabulary, canon code and locale (Section 15, ADR 0053). Codes are never translated, and en-US is never stored here: it is the canon table''s own label. Read through xpms.canon_labels or xpms.canon_label_of, which fall back to en-US.';
comment on column xpms.canon_label.vocabulary is 'The vocabulary (xpms.canon_vocabulary).';
comment on column xpms.canon_label.code is 'The canon code the label is for, as the vocabulary stores it (<parent>/<code> for a two-column key).';
comment on column xpms.canon_label.locale_code is 'The locale of the label (xpms.dim_locale), never en-US.';
comment on column xpms.canon_label.label is 'The label in that locale.';
comment on column xpms.canon_label.provenance is 'Who wrote it: catalog (copied from the app catalogs), machine (the Google Translate pipeline, ADR 0037) or human.';
comment on column xpms.canon_label.updated_at is 'When the label was last loaded.';

create index canon_label_locale_idx on xpms.canon_label (locale_code, vocabulary);

do $$
declare
  t text;
begin
  foreach t in array array['canon_vocabulary', 'canon_label'] loop
    execute format('revoke all on table xpms.%I from public, anon, authenticated', t);
    execute format('grant all on table xpms.%I to service_role', t);
    execute format('grant select on table xpms.%I to authenticated', t);
    execute format('alter table xpms.%I enable row level security', t);
    execute format('create policy %I on xpms.%I for select to authenticated using (true)', t || '_canon_read', t);
  end loop;
end;
$$;

-- The SQL expression for a vocabulary's stored code over its canon table aliased s.
create function xpms.canon_code_expression(p_vocabulary text)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when v.parent_column is null then format('s.%I::text', v.code_column)
    else format('s.%I::text || ''/'' || s.%I::text', v.parent_column, v.code_column)
  end
  from xpms.canon_vocabulary v
  where v.vocabulary = p_vocabulary;
$$;
comment on function xpms.canon_code_expression(text) is 'The SQL expression for a vocabulary''s stored code over its canon table aliased s: the code column, or <parent>/<code> for a two-column key. Internal to the canon label functions.';

-- A label is for a code its vocabulary has.
create function xpms.canon_label_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v xpms.canon_vocabulary;
  found boolean;
begin
  select * into v from xpms.canon_vocabulary where vocabulary = new.vocabulary;
  execute format('select exists (select 1 from %s s where %s = $1)', v.source_table, xpms.canon_code_expression(new.vocabulary))
    into found using new.code::text;
  if not found then
    raise exception using errcode = '23503',
      message = format('canon_label: %s is not a code of %s', new.code, new.vocabulary);
  end if;
  new.updated_at := now();
  return new;
end;
$$;
comment on function xpms.canon_label_guard() is 'Refuses a translated label for a code its vocabulary does not have, and stamps updated_at.';

create trigger canon_label_guard before insert or update on xpms.canon_label
  for each row execute function xpms.canon_label_guard();

-- Every code of a vocabulary with its label in a locale, en-US where it has no translation.
create function xpms.canon_labels(p_vocabulary text, p_locale text)
returns table (code text, label text, locale_code text, translated boolean)
language plpgsql
stable
set search_path = ''
as $$
declare
  v xpms.canon_vocabulary;
begin
  select * into v from xpms.canon_vocabulary where vocabulary = p_vocabulary;
  if not found then
    raise exception using errcode = '22023', message = format('canon_labels: unknown vocabulary %s', p_vocabulary);
  end if;
  return query execute format($q$
    select src.code, coalesce(t.label::text, src.label), coalesce(t.locale_code::text, 'en-US'), t.label is not null
    from (select %s as code, s.%I::text as label from %s s) src
    left join xpms.canon_label t
      on t.vocabulary = $1 and t.code = src.code and t.locale_code = $2
    order by src.code collate "C"
  $q$, xpms.canon_code_expression(p_vocabulary), v.label_column, v.source_table)
  using p_vocabulary, p_locale;
end;
$$;
comment on function xpms.canon_labels(text, text) is 'Every code of a canon vocabulary with its label in a locale (Section 15, ADR 0053): the translation in xpms.canon_label when there is one, otherwise the canon table''s en-US label, so a label is never missing and a code is never shown in its place. locale_code says which locale answered; translated is false for an en-US fallback. Codes are never translated.';

-- One code's label in a locale, en-US where it has no translation; NULL for a code the vocabulary lacks.
create function xpms.canon_label_of(p_vocabulary text, p_code text, p_locale text)
returns text
language sql
stable
set search_path = ''
as $$
  select l.label from xpms.canon_labels(p_vocabulary, p_locale) l where l.code = p_code;
$$;
comment on function xpms.canon_label_of(text, text, text) is 'One canon code''s label in a locale, falling back to en-US (Section 15, ADR 0053); NULL when the vocabulary has no such code.';

-- Loads a locale's labels for a vocabulary, replacing what was there (migrations, from canon:sql).
create function xpms.put_canon_labels(p_vocabulary text, p_locale text, p_provenance text, p_labels jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  n integer;
begin
  create temporary table if not exists canon_label_incoming (code text primary key, label text not null) on commit drop;
  truncate canon_label_incoming;
  insert into canon_label_incoming (code, label)
  select e.key, e.value #>> '{}'
  from jsonb_each(p_labels) e
  where jsonb_typeof(e.value) = 'string'
  union all
  select e.key || '/' || c.key, c.value #>> '{}'
  from jsonb_each(p_labels) e, jsonb_each(e.value) c
  where jsonb_typeof(e.value) = 'object' and jsonb_typeof(c.value) = 'string';
  delete from xpms.canon_label l
  where l.vocabulary = p_vocabulary and l.locale_code = p_locale
    and not exists (select 1 from canon_label_incoming i where i.code = l.code::text);
  insert into xpms.canon_label (vocabulary, code, locale_code, label, provenance)
  select p_vocabulary, i.code, p_locale, i.label, p_provenance from canon_label_incoming i
  on conflict (vocabulary, code, locale_code) do update
    set label = excluded.label, provenance = excluded.provenance
    where xpms.canon_label.label is distinct from excluded.label
       or xpms.canon_label.provenance is distinct from excluded.provenance;
  select count(*)::integer into n from canon_label_incoming;
  drop table canon_label_incoming;
  return n;
end;
$$;
comment on function xpms.put_canon_labels(text, text, text, jsonb) is 'Loads one locale''s translated labels for a canon vocabulary from a JSON object of code to label (parent code to code to label for a two-column key), replacing the locale''s previous labels for it. Migrations call it with the statements `pnpm --filter @xos/i18n canon:sql` prints. Returns how many labels it loaded.';

revoke all on function xpms.canon_code_expression(text) from public, anon, authenticated;
revoke all on function xpms.canon_label_guard() from public, anon, authenticated;
revoke all on function xpms.put_canon_labels(text, text, text, jsonb) from public, anon, authenticated;
revoke all on function xpms.canon_labels(text, text) from public, anon;
revoke all on function xpms.canon_label_of(text, text, text) from public, anon;
grant execute on function xpms.canon_code_expression(text) to authenticated, service_role;
grant execute on function xpms.canon_labels(text, text) to authenticated, service_role;
grant execute on function xpms.canon_label_of(text, text, text) to authenticated, service_role;
grant execute on function xpms.put_canon_labels(text, text, text, jsonb) to service_role;

insert into xpms.canon_vocabulary (vocabulary, ordinal, source_table, code_column, parent_column, label_column, description) values
  ('department', 1, 'xpms.dim_department', 'dept_code', null, 'department', 'Departments.'),
  ('discipline', 2, 'xpms.dim_discipline', 'disc_code', null, 'discipline', 'Disciplines within departments.'),
  ('category', 3, 'xpms.dim_category', 'cat_urid', null, 'category', 'Categories within disciplines.'),
  ('phase', 4, 'xpms.dim_phase', 'phase_code', null, 'phase', 'Project phases, each ending at a gate.'),
  ('tier', 5, 'xpms.dim_tier', 'tier_code', null, 'tier', 'Project tiers.'),
  ('team', 6, 'xpms.dim_team', 'team_id', null, 'team', 'Teams within departments.'),
  ('role', 7, 'xpms.dim_role', 'role_code', null, 'role', 'Workforce roles (Bible tab 27).'),
  ('jobTitle', 8, 'xpms.role', 'role_code', null, 'job_title', 'Job titles of the Roles Library.'),
  ('recordKind', 9, 'xpms.dim_record_kind', 'record_kind', null, 'record_kind', 'Record kinds.'),
  ('recordClass', 10, 'xpms.dim_record_class', 'record_class', null, 'record_class', 'Record classes.'),
  ('recordState', 11, 'xpms.dim_record_state', 'record_state', null, 'record_state', 'Record states.'),
  ('recordSubtype', 12, 'xpms.dim_record_subtype', 'record_subtype', 'record_kind', 'record_subtype', 'Record subtypes, scoped by record kind.'),
  ('workerClassification', 13, 'xpms.worker_classification', 'code', null, 'label', 'Worker classifications.'),
  ('grade', 14, 'xpms.grade', 'code', null, 'label', 'Price grades.'),
  ('glAccount', 15, 'xpms.dim_gl_account', 'account_code', null, 'account_name', 'General ledger accounts.'),
  ('emergencyCode', 16, 'xpms.emergency_code', 'code', null, 'label', 'Emergency codes.'),
  ('enumeration', 17, 'xpms.std_enumeration', 'record_id', null, 'enum_label', 'Standard Library enumeration values.'),
  ('region', 18, 'xpms.dim_region', 'region_code', null, 'name', 'Pricing regions.'),
  ('costCenter', 19, 'xpms.dim_cost_center_template', 'cost_center_id', null, 'cost_center', 'Cost center templates.'),
  ('counterpartyType', 20, 'xpms.dim_counterparty_type', 'counterparty_type', null, 'counterparty_type', 'Counterparty types.');

-- es-US labels the app catalogs already held for canon codes (`pnpm --filter @xos/i18n canon:sql`).
select xpms.put_canon_labels('phase', 'es-US', 'catalog', '{"ADV":"Avance","AMP":"Amplificación","BLD":"Construcción","CLS":"Cierre","ENG":"Contratación","INS":"Instalación","OPR":"Operación","PRC":"Compras","SCP":"Alcance"}'::jsonb);
select xpms.put_canon_labels('recordClass', 'es-US', 'catalog', '{"Artifact":"Artefacto","Commitment":"Compromiso","Control":"Control","Time":"Tiempo","Work":"Trabajo"}'::jsonb);
select xpms.put_canon_labels('recordKind', 'es-US', 'catalog', '{"Approval":"Aprobación","Booking":"Reserva","Build":"Montaje","Compliance":"Cumplimiento","Contract":"Contrato","Deadline":"Fecha Límite","Decision":"Decisión","Distribution":"Distribución","Document":"Documento","Event":"Evento","Goal":"Objetivo","Inspection":"Inspección","Meeting":"Reunión","Milestone":"Hito","Payment":"Pago","Permit":"Permiso","Recruitment":"Reclutamiento","Rehearsal":"Ensayo","Report":"Informe","Risk":"Riesgo","Shift":"Turno","Strike":"Desmontaje","Supply":"Suministro","Task":"Tarea","Timeline":"Cronograma","Training":"Capacitación"}'::jsonb);
select xpms.put_canon_labels('recordState', 'es-US', 'catalog', '{"Active":"Activo","Blocked":"Bloqueado","Canceled":"Cancelado","Complete":"Completo","Deferred":"Diferido","In Review":"En Revisión","Proposed":"Propuesto","Ready":"Listo","Scheduled":"Programado"}'::jsonb);
select xpms.put_canon_labels('recordSubtype', 'es-US', 'catalog', '{"Approval":{"Booking":"Reserva","Budget":"Presupuesto","Content":"Contenido","Design":"Diseño","Plan":"Plan"},"Booking":{"Catering":"Catering","Crew":"Equipo de Trabajo","Equipment":"Equipamiento","Freight":"Carga","Space":"Espacio","Talent":"Talento","Travel":"Viaje"},"Build":{"Commissioning":"Puesta en Marcha","Dress":"Ambientación","Scenic":"Escenografía","Structural":"Estructural","Systems":"Sistemas"},"Compliance":{"Certificate":"Certificado","License":"Licencia","Plan":"Plan","Policy":"Política","Register":"Registro"},"Contract":{"Insurance":"Seguro","Lease":"Arrendamiento","License":"Licencia","Service Agreement":"Acuerdo de Servicio","Sponsorship":"Patrocinio","Supply Agreement":"Acuerdo de Suministro","Talent Agreement":"Acuerdo de Talento"},"Deadline":{"Authority Owed":"Debido a la Autoridad","Client Owed":"Debido al Cliente","Internal":"Interno","Vendor Owed":"Debido al Proveedor"},"Decision":{"Commercial":"Comercial","Creative":"Creativa","Operational":"Operativa"},"Distribution":{"Internal":"Interna","On-sale":"Venta al Público","Press":"Prensa","Social":"Redes Sociales"},"Document":{"Brief":"Resumen","Package":"Paquete","Plan":"Plan","Policy":"Política","Register":"Registro","Report":"Informe","Run of Show":"Guion del Show","Specification":"Especificación"},"Event":{"After Party":"Fiesta Posterior","Campaign Launch":"Lanzamiento de Campaña","Flagship Activation":"Activación Principal","Listening Party":"Fiesta de Escucha","Standing Operations":"Operaciones Permanentes"},"Goal":{"Commercial":"Comercial","Compliance":"Cumplimiento","Experience":"Experiencia","Operational":"Operativo"},"Inspection":{"Readiness":"Preparación","Restoration":"Restauración","Safety":"Seguridad","Systems":"Sistemas"},"Meeting":{"Recurring":"Recurrente","Series":"Serie","Single":"Única"},"Milestone":{"Handover":"Entrega","Opening":"Apertura","Term":"Plazo"},"Payment":{"Deposit":"Depósito","Progress":"Avance","Reconciliation":"Conciliación","Settlement":"Liquidación"},"Permit":{"Alcohol":"Alcohol","Building":"Construcción","Fire & Life Safety":"Incendios y Seguridad Humana","Occupancy":"Ocupación","Sound":"Sonido","Special Event":"Evento Especial"},"Recruitment":{"Contracted":"Contratado","Crewed":"Con Equipo","Hourly":"Por Hora","Salaried":"Asalariado"},"Rehearsal":{"Full Run":"Ensayo Completo","Stream Test":"Prueba de Transmisión","Technical":"Técnico"},"Report":{"Compliance":"Cumplimiento","Event Recap":"Resumen del Evento","Financial":"Financiero","Operations":"Operaciones"},"Risk":{"Commercial":"Comercial","Operational":"Operativo","Reputational":"Reputacional","Safety":"Seguridad","Schedule":"Cronograma"},"Shift":{"Load-in":"Carga","Load-out":"Descarga","Overnight":"Nocturno","Show":"Show","Standing":"Permanente"},"Strike":{"Full Restoration":"Restauración Completa","Show Strike":"Desmontaje del Show"},"Supply":{"Audio":"Audio","Bar & Beverage":"Bar y Bebidas","Catering & Kitchen":"Catering y Cocina","Facilities & Janitorial":"Instalaciones y Limpieza","Guest & Front of House":"Invitados y Recepción","Lighting & Video":"Iluminación y Video","Power & Staging":"Energía y Escenarios","Safety & Emergency":"Seguridad y Emergencias","Signage & Wayfinding":"Señalización","Technology":"Tecnología"},"Task":{"Assess":"Evaluar","Coordinate":"Coordinar","Define":"Definir","Execute":"Ejecutar","Issue":"Emitir","Produce":"Producir","Verify":"Verificar"},"Timeline":{"Gate Window":"Ventana de Compuerta","Program Month":"Mes del Programa","Show Cycle":"Ciclo del Show"},"Training":{"Induction":"Inducción","Refresher":"Actualización","Role-specific":"Específica del Rol","Safety":"Seguridad"}}'::jsonb);
select xpms.put_canon_labels('workerClassification', 'es-US', 'catalog', '{"EMPLOYEE":"Empleado","INDEPENDENT_CONTRACTOR":"Contratista independiente","UNPAID_INTERN":"Pasante no remunerado","VENDOR_SUPPLIED":"Aportado por proveedor","VOLUNTEER":"Voluntario"}'::jsonb);

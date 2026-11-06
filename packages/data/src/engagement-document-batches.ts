import type { Database, XosClient } from "./client.ts";
import {
  mergeEngagementDocument,
  usesRate,
  type MergeFacts,
  type MergedDocument,
  type MergeShift,
} from "./engagement-document-merge.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Agreement templates and batches (B10, G-130, ADR 0149 decision 4). One template becomes one engagement document per
 * person: the data layer merges the text as the caller, so the batch trusts a caller who already holds engagement write,
 * and a rate or a shift the caller cannot read is missing rather than empty. Written through 2993's table policies and
 * 2994's RPCs; the party's reads and writes are in gateway-external.ts.
 */

type Enums = Database["app"]["Enums"];
export type EngagementDocumentKind = Enums["engagement_document_kind"];
export type EngagementDocumentState = Enums["engagement_document_state"];

export interface AgreementTemplate {
  readonly id: string;
  readonly name: string;
  readonly kind: EngagementDocumentKind;
  readonly locale: string;
  readonly titleTemplate: string;
  readonly bodyTemplate: string;
  readonly usesRate: boolean;
}

function templateOf(r: {
  id: string;
  name: string;
  document_kind: EngagementDocumentKind;
  locale: string;
  title_template: string;
  body_template: string;
}): AgreementTemplate {
  return {
    id: r.id,
    name: r.name,
    kind: r.document_kind,
    locale: r.locale,
    titleTemplate: r.title_template,
    bodyTemplate: r.body_template,
    usesRate: usesRate(r.body_template),
  };
}

export async function listTemplates(
  db: XosClient,
  orgId: string,
): Promise<Result<AgreementTemplate[]>> {
  const { data, error } = await db
    .from("engagement_document_templates")
    .select("id, name, document_kind, locale, title_template, body_template")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("name");
  if (error) return fail(toDataError(error));
  return ok((data ?? []).map(templateOf));
}

export interface TemplateInput {
  readonly orgId: string;
  readonly id?: string | null;
  readonly name: string;
  readonly kind: EngagementDocumentKind;
  readonly locale: string;
  readonly titleTemplate: string;
  readonly bodyTemplate: string;
}

/** Creates a template or changes one; the database refuses other wording once a batch uses it (document_template_in_use). */
export async function saveTemplate(
  db: XosClient,
  input: TemplateInput,
): Promise<Result<{ id: string }>> {
  const row = {
    name: input.name.trim(),
    document_kind: input.kind,
    locale: input.locale,
    title_template: input.titleTemplate,
    body_template: input.bodyTemplate,
  };
  const query = input.id
    ? db.from("engagement_document_templates").update(row).eq("id", input.id).select("id").single()
    : db
        .from("engagement_document_templates")
        .insert({ ...row, org_id: input.orgId })
        .select("id")
        .single();
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Copies a template, the way to change wording a batch already uses. */
export async function duplicateTemplate(
  db: XosClient,
  input: { orgId: string; id: string; name: string },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("engagement_document_templates")
    .select("document_kind, locale, title_template, body_template")
    .eq("id", input.id)
    .single();
  if (error) return fail(toDataError(error));
  return saveTemplate(db, {
    orgId: input.orgId,
    name: input.name,
    kind: data.document_kind,
    locale: data.locale,
    titleTemplate: data.title_template,
    bodyTemplate: data.body_template,
  });
}

export async function removeTemplate(db: XosClient, id: string): Promise<Result<null>> {
  const { error } = await db
    .from("engagement_document_templates")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return fail(toDataError(error));
  return ok(null);
}

// Merging ------------------------------------------------------------------------------------------------------------

/** A person engagement the batch form offers, in a state a document can go to. */
export interface BatchPerson {
  readonly engagementId: string;
  readonly name: string;
  readonly jobTitle: string | null;
}

export async function listBatchPeople(
  db: XosClient,
  projectId: string,
): Promise<Result<BatchPerson[]>> {
  const { data, error } = await db
    .from("engagement_resolved")
    .select("engagement_id, person_id, counterparty_id, job_title, engagement_state")
    .eq("project_id", projectId)
    .in("engagement_state", ["Onboarding", "Blocked", "Active", "Closing"])
    .not("person_id", "is", null)
    .is("counterparty_id", null);
  if (error) return fail(toDataError(error));
  const rows = data ?? [];
  const names = await partyNames(
    db,
    rows.flatMap((r) => (r.engagement_id ? [r.engagement_id] : [])),
  );
  return ok(
    rows
      .flatMap((r) =>
        r.engagement_id
          ? [
              {
                engagementId: r.engagement_id,
                name: names.get(r.engagement_id) ?? "",
                jobTitle: r.job_title,
              },
            ]
          : [],
      )
      .filter((p) => p.name !== "")
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
}

async function partyNames(db: XosClient, ids: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  await Promise.all(
    ids.map(async (id) => {
      const { data } = await db.rpc("engaged_person_name", { p_engagement_id: id });
      if (typeof data === "string") names.set(id, data);
    }),
  );
  return names;
}

export interface PreviewRow extends MergedDocument {
  readonly engagementId: string;
  readonly name: string;
}

/** What the batch form previews: every person's merged text, read as the caller, writing nothing. */
export async function previewBatch(
  db: XosClient,
  input: {
    readonly projectId: string;
    readonly template: Pick<AgreementTemplate, "titleTemplate" | "bodyTemplate" | "locale">;
    readonly engagementIds: readonly string[];
    /** The pay basis as the template's locale writes it. */
    readonly payBasisLabel?: (basis: string) => string;
    readonly now?: Date;
  },
): Promise<Result<PreviewRow[]>> {
  const facts = await loadFacts(
    db,
    input.projectId,
    input.engagementIds,
    input.template,
    input.payBasisLabel,
  );
  if (!facts.ok) return facts;
  return ok(
    input.engagementIds.flatMap((id) => {
      const f = facts.data.get(id);
      if (!f) return [];
      return [
        {
          engagementId: id,
          name: f.partyName ?? "",
          ...mergeEngagementDocument(
            { title: input.template.titleTemplate, body: input.template.bodyTemplate },
            f,
            input.template.locale,
            input.now,
          ),
        },
      ];
    }),
  );
}

async function loadFacts(
  db: XosClient,
  projectId: string,
  engagementIds: readonly string[],
  template: Pick<AgreementTemplate, "titleTemplate" | "bodyTemplate">,
  payBasisLabel: ((basis: string) => string) | undefined,
): Promise<Result<Map<string, MergeFacts>>> {
  const needsShifts = /\{\{\s*shifts\./.test(`${template.titleTemplate} ${template.bodyTemplate}`);
  const [project, engagements, opportunities, currencies, capabilities] = await Promise.all([
    db
      .from("projects")
      .select("name, project_key, time_zone, org_id, organizations:org_id (name)")
      .eq("id", projectId)
      .single(),
    db
      .from("engagement_resolved")
      .select(
        "engagement_id, job_title, rate_minor, rate_currency_code, is_masked, pay_basis, start_date, end_date",
      )
      .eq("project_id", projectId)
      .in("engagement_id", [...engagementIds]),
    db
      .from("engagements")
      .select("id, applications:application_id (opportunities:opportunity_id (title))")
      .in("id", [...engagementIds]),
    db.from("currencies").select("currency_code, minor_unit_exponent"),
    db.rpc("my_capabilities_on_project", {
      p_project_id: projectId,
      p_capabilities: ["crew.shift.read"],
    }),
  ]);
  if (project.error) return fail(toDataError(project.error));
  if (engagements.error) return fail(toDataError(engagements.error));
  if (opportunities.error) return fail(toDataError(opportunities.error));
  if (currencies.error) return fail(toDataError(currencies.error));
  if (capabilities.error) return fail(toDataError(capabilities.error));
  const canReadShifts = (capabilities.data ?? []).includes("crew.shift.read");
  const shiftsByEngagement = new Map<string, MergeShift[]>();
  if (needsShifts && canReadShifts) {
    const { data, error } = await db
      .from("shifts")
      .select("engagement_id, starts_at, ends_at, time_zone, role_code")
      .eq("project_id", projectId)
      .in("engagement_id", [...engagementIds])
      .in("shift_state", ["Published", "Accepted"])
      .is("deleted_at", null);
    if (error) return fail(toDataError(error));
    const codes = [...new Set((data ?? []).flatMap((s) => (s.role_code ? [s.role_code] : [])))];
    const titles = new Map<string, string>();
    if (codes.length > 0) {
      const roles = await db
        .schema("xpms")
        .from("role")
        .select("role_code, job_title")
        .in("role_code", codes);
      if (roles.error) return fail(toDataError(roles.error));
      for (const r of roles.data ?? []) if (r.job_title) titles.set(r.role_code, r.job_title);
    }
    for (const s of data ?? []) {
      if (!s.engagement_id) continue;
      const list = shiftsByEngagement.get(s.engagement_id) ?? [];
      list.push({
        startsAt: s.starts_at,
        endsAt: s.ends_at,
        timeZone: s.time_zone,
        jobTitle: (s.role_code ? titles.get(s.role_code) : null) ?? null,
      });
      shiftsByEngagement.set(s.engagement_id, list);
    }
  }
  const exponents = new Map(
    (currencies.data ?? []).flatMap((c) =>
      c.currency_code && c.minor_unit_exponent !== null
        ? [[c.currency_code.trim(), c.minor_unit_exponent] as const]
        : [],
    ),
  );
  const names = await partyNames(db, engagementIds);
  const opportunityOf = new Map(
    (
      (opportunities.data ?? []) as unknown as {
        id: string;
        applications: { opportunities: { title: string } | null } | null;
      }[]
    ).map((e) => [e.id, e.applications?.opportunities?.title ?? null]),
  );
  const organization = (project.data as unknown as { organizations: { name: string } | null })
    .organizations;
  const out = new Map<string, MergeFacts>();
  for (const e of engagements.data ?? []) {
    if (!e.engagement_id) continue;
    const currency = e.rate_currency_code?.trim() ?? null;
    const exponent = currency ? exponents.get(currency) : undefined;
    out.set(e.engagement_id, {
      partyName: names.get(e.engagement_id) ?? null,
      orgName: organization?.name ?? null,
      projectName: project.data.name,
      projectKey: project.data.project_key,
      projectTimeZone: project.data.time_zone,
      roleTitle: e.job_title,
      opportunityTitle: opportunityOf.get(e.engagement_id) ?? null,
      startDate: e.start_date,
      endDate: e.end_date,
      rate:
        e.is_masked || e.rate_minor === null || currency === null || exponent === undefined
          ? null
          : { minor: e.rate_minor, currency, exponent },
      payBasis: e.pay_basis ? (payBasisLabel?.(e.pay_basis) ?? e.pay_basis) : null,
      shifts: canReadShifts ? (shiftsByEngagement.get(e.engagement_id) ?? []) : null,
    });
  }
  return ok(out);
}

// Batches -------------------------------------------------------------------------------------------------------------

export interface BatchEntryResult {
  readonly engagementId: string;
  readonly documentId: string | null;
  readonly outcome: "created" | "refused";
  readonly code: string | null;
}

export async function createBatch(
  db: XosClient,
  input: {
    readonly projectId: string;
    readonly templateId: string;
    readonly requirementId?: string | null;
    readonly documents: readonly { engagementId: string; title: string; body: string }[];
  },
): Promise<Result<{ batchId: string | null; results: BatchEntryResult[] }>> {
  const { data, error } = await db.rpc("create_engagement_document_batch", {
    p_project_id: input.projectId,
    p_template_id: input.templateId,
    p_documents: input.documents.map((d) => ({
      engagement_id: d.engagementId,
      title: d.title,
      body: d.body,
    })),
    ...(input.requirementId ? { p_onboarding_requirement_id: input.requirementId } : {}),
  });
  if (error) return fail(toDataError(error));
  const answer = data as unknown as {
    batch_id: string | null;
    results: {
      engagement_id: string;
      engagement_document_id: string | null;
      outcome: "created" | "refused";
      code: string | null;
    }[];
  };
  return ok({
    batchId: answer.batch_id,
    results: answer.results.map((r) => ({
      engagementId: r.engagement_id,
      documentId: r.engagement_document_id,
      outcome: r.outcome,
      code: r.code,
    })),
  });
}

export async function sendBatch(db: XosClient, batchId: string): Promise<Result<{ sent: number }>> {
  const { data, error } = await db.rpc("send_engagement_document_batch", { p_batch_id: batchId });
  if (error) return fail(toDataError(error));
  return ok({ sent: data as number });
}

export async function countersignBatch(
  db: XosClient,
  batchId: string,
): Promise<Result<{ executed: number; refused: { id: string; code: string }[] }>> {
  const { data, error } = await db.rpc("countersign_engagement_document_batch", {
    p_batch_id: batchId,
  });
  if (error) return fail(toDataError(error));
  const answer = data as unknown as { executed: number; refused: { id: string; code: string }[] };
  return ok({ executed: answer.executed, refused: answer.refused });
}

export interface AgreementBatch {
  readonly id: string;
  readonly projectId: string;
  readonly projectName: string | null;
  readonly templateId: string;
  readonly templateName: string | null;
  readonly sentAt: string | null;
  readonly counts: Readonly<Partial<Record<EngagementDocumentState, number>>>;
}

/** Batches the caller reads, optionally for one project, with their documents' counts by state. */
export async function listBatches(
  db: XosClient,
  input: { readonly orgId: string; readonly projectId?: string | null },
): Promise<Result<AgreementBatch[]>> {
  let query = db
    .from("engagement_document_batches")
    .select(
      "id, project_id, sent_at, engagement_document_template_id, projects:project_id (name), engagement_document_templates:engagement_document_template_id (name)",
    )
    .eq("org_id", input.orgId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(100);
  if (input.projectId) query = query.eq("project_id", input.projectId);
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  const rows = (data ?? []) as unknown as {
    id: string;
    project_id: string;
    sent_at: string | null;
    engagement_document_template_id: string;
    projects: { name: string } | null;
    engagement_document_templates: { name: string } | null;
  }[];
  const texts = await db
    .from("engagement_document_text_list")
    .select("engagement_document_batch_id, engagement_document_state")
    .in(
      "engagement_document_batch_id",
      rows.map((r) => r.id),
    );
  if (texts.error) return fail(toDataError(texts.error));
  const counts = new Map<string, Partial<Record<EngagementDocumentState, number>>>();
  for (const t of texts.data ?? []) {
    if (!t.engagement_document_batch_id || !t.engagement_document_state) continue;
    const entry = counts.get(t.engagement_document_batch_id) ?? {};
    entry[t.engagement_document_state] = (entry[t.engagement_document_state] ?? 0) + 1;
    counts.set(t.engagement_document_batch_id, entry);
  }
  return ok(
    rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      projectName: r.projects?.name ?? null,
      templateId: r.engagement_document_template_id,
      templateName: r.engagement_document_templates?.name ?? null,
      sentAt: r.sent_at,
      counts: counts.get(r.id) ?? {},
    })),
  );
}

export interface OrgDocumentText {
  readonly documentId: string;
  readonly engagementId: string;
  readonly projectId: string;
  readonly title: string;
  readonly kind: EngagementDocumentKind;
  readonly state: EngagementDocumentState;
  readonly body: string | null;
  readonly bodyMasked: boolean;
  readonly bodySha256: string | null;
  readonly signedName: string | null;
  readonly signedBodySha256: string | null;
  readonly signedAt: string | null;
}

/** One generated document's text as an org reader sees it; a masked reader gets no body and no hash. */
export async function getOrgDocumentText(
  db: XosClient,
  documentId: string,
): Promise<Result<OrgDocumentText | null>> {
  const { data, error } = await db
    .from("engagement_document_text_list")
    .select(
      "engagement_document_id, engagement_id, project_id, title, document_kind, engagement_document_state, body, body_masked, body_sha256, signed_name, signed_body_sha256, signed_at",
    )
    .eq("engagement_document_id", documentId)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return ok(null);
  return ok({
    documentId: data.engagement_document_id as string,
    engagementId: data.engagement_id as string,
    projectId: data.project_id as string,
    title: data.title as string,
    kind: data.document_kind as EngagementDocumentKind,
    state: data.engagement_document_state as EngagementDocumentState,
    body: data.body,
    bodyMasked: data.body_masked === true,
    bodySha256: data.body_sha256,
    signedName: data.signed_name,
    signedBodySha256: data.signed_body_sha256,
    signedAt: data.signed_at,
  });
}

/** The live Electronic Signature requirements of an org, for the batch form. */
export async function listSignatureRequirements(
  db: XosClient,
  orgId: string,
): Promise<Result<{ id: string; name: string }[]>> {
  const { data, error } = await db
    .from("onboarding_requirements")
    .select("id, name")
    .eq("org_id", orgId)
    .eq("item_kind", "Electronic Signature")
    .is("deleted_at", null)
    .order("name");
  if (error) return fail(toDataError(error));
  return ok(data ?? []);
}

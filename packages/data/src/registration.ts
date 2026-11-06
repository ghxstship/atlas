import type { Database, XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Crew registration pages (B10, G-129, ADR 0149 decision 3), the org side. A public page fills a Talent pool; the pool is
 * never named outside the org, and registering needs an account (decision 54's 16+). The registrant's side is in
 * gateway-external.ts and the public read in gateway-public.ts.
 */

type Enums = Database["app"]["Enums"];
export type RegistrationPageState = Enums["registration_page_state"];
export type CrewRegistrationState = Enums["crew_registration_state"];

export interface RegistrationPage {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly intro: string | null;
  readonly poolId: string;
  readonly minimumAge: number;
  readonly state: RegistrationPageState;
  readonly openRegistrations: number;
}

export async function listRegistrationPages(db: XosClient, orgId: string): Promise<Result<RegistrationPage[]>> {
  const { data, error } = await db
    .from("registration_pages")
    .select("id, slug, title, intro, talent_pool_id, minimum_age, page_state, crew_registrations (registration_state, deleted_at)")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(
    ((data ?? []) as unknown as {
      id: string;
      slug: string;
      title: string;
      intro: string | null;
      talent_pool_id: string;
      minimum_age: number;
      page_state: RegistrationPageState;
      crew_registrations: { registration_state: CrewRegistrationState; deleted_at: string | null }[] | null;
    }[]).map((r) => ({
      id: r.id,
      slug: r.slug,
      title: r.title,
      intro: r.intro,
      poolId: r.talent_pool_id,
      minimumAge: r.minimum_age,
      state: r.page_state,
      openRegistrations: (r.crew_registrations ?? []).filter(
        (g) => g.deleted_at === null && g.registration_state === "Submitted",
      ).length,
    })),
  );
}

export interface RegistrationPageInput {
  readonly orgId: string;
  readonly id?: string | null;
  readonly slug: string;
  readonly title: string;
  readonly intro?: string | null;
  readonly poolId: string;
  readonly minimumAge: number;
}

export async function saveRegistrationPage(db: XosClient, input: RegistrationPageInput): Promise<Result<{ id: string }>> {
  const row = {
    slug: input.slug.trim().toLowerCase(),
    title: input.title.trim(),
    intro: input.intro?.trim() || null,
    talent_pool_id: input.poolId,
    minimum_age: input.minimumAge,
  };
  const query = input.id
    ? db.from("registration_pages").update(row).eq("id", input.id).select("id").single()
    : db.from("registration_pages").insert({ ...row, org_id: input.orgId }).select("id").single();
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

export async function transitionRegistrationPage(
  db: XosClient,
  input: { id: string; expected: RegistrationPageState; next: RegistrationPageState },
): Promise<Result<null>> {
  const { error } = await db.rpc("transition_registration_page", {
    p_page_id: input.id,
    p_expected: input.expected,
    p_next: input.next,
  });
  if (error) return fail(toDataError(error));
  return ok(null);
}

export interface RegistrationQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly sortOrder: number;
  readonly isRequired: boolean;
}

export async function listRegistrationQuestions(db: XosClient, pageId: string): Promise<Result<RegistrationQuestion[]>> {
  const { data, error } = await db
    .from("registration_page_questions")
    .select("id, prompt, sort_order, is_required")
    .eq("registration_page_id", pageId)
    .is("deleted_at", null)
    .order("sort_order");
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((q) => ({ id: q.id, prompt: q.prompt, sortOrder: q.sort_order, isRequired: q.is_required })),
  );
}

export async function addRegistrationQuestion(
  db: XosClient,
  input: { pageId: string; prompt: string; isRequired: boolean },
): Promise<Result<{ id: string }>> {
  const existing = await listRegistrationQuestions(db, input.pageId);
  if (!existing.ok) return existing;
  const next = existing.data.reduce((max, q) => Math.max(max, q.sortOrder), 0) + 1;
  const { data, error } = await db
    .from("registration_page_questions")
    .insert({
      registration_page_id: input.pageId,
      prompt: input.prompt.trim(),
      is_required: input.isRequired,
      sort_order: next,
    } as never)
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

export async function updateRegistrationQuestion(
  db: XosClient,
  input: { id: string; prompt: string; isRequired: boolean },
): Promise<Result<null>> {
  const { error } = await db
    .from("registration_page_questions")
    .update({ prompt: input.prompt.trim(), is_required: input.isRequired })
    .eq("id", input.id);
  if (error) return fail(toDataError(error));
  return ok(null);
}

export async function removeRegistrationQuestion(db: XosClient, id: string): Promise<Result<null>> {
  const { error } = await db
    .from("registration_page_questions")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return fail(toDataError(error));
  return ok(null);
}

export async function applyRegistrationTemplate(
  db: XosClient,
  input: { pageId: string; templateId: string },
): Promise<Result<{ copied: number }>> {
  const { data, error } = await db.rpc("apply_registration_question_template", {
    p_page_id: input.pageId,
    p_template_id: input.templateId,
  });
  if (error) return fail(toDataError(error));
  return ok({ copied: data as number });
}

export interface RegistrationRow {
  readonly id: string;
  readonly pageId: string;
  readonly pageTitle: string | null;
  readonly personName: string | null;
  readonly state: CrewRegistrationState;
  readonly submittedAt: string | null;
  readonly decidedAt: string | null;
  readonly confirmedMinimumAge: number | null;
  readonly profileShareId: string | null;
  readonly answers: readonly { prompt: string; answer: string }[];
}

export async function listRegistrations(
  db: XosClient,
  input: { orgId: string; pageId?: string | null },
): Promise<Result<RegistrationRow[]>> {
  let query = db
    .from("crew_registration_list")
    .select(
      "id, registration_page_id, page_title, full_name, registration_state, submitted_at, decided_at, confirmed_minimum_age, profile_share_id",
    )
    .eq("org_id", input.orgId)
    .order("submitted_at", { ascending: false })
    .limit(500);
  if (input.pageId) query = query.eq("registration_page_id", input.pageId);
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  const rows = data ?? [];
  const answers = await db
    .from("crew_registration_answers")
    .select("crew_registration_id, answer, registration_page_questions:registration_page_question_id (prompt, sort_order)")
    .in("crew_registration_id", rows.flatMap((r) => (r.id ? [r.id] : [])))
    .is("deleted_at", null);
  if (answers.error) return fail(toDataError(answers.error));
  const byRegistration = new Map<string, { prompt: string; answer: string; order: number }[]>();
  for (const a of (answers.data ?? []) as unknown as {
    crew_registration_id: string;
    answer: string;
    registration_page_questions: { prompt: string; sort_order: number } | null;
  }[]) {
    const list = byRegistration.get(a.crew_registration_id) ?? [];
    list.push({
      prompt: a.registration_page_questions?.prompt ?? "",
      answer: a.answer,
      order: a.registration_page_questions?.sort_order ?? 0,
    });
    byRegistration.set(a.crew_registration_id, list);
  }
  return ok(
    rows.map((r) => ({
      id: r.id as string,
      pageId: r.registration_page_id as string,
      pageTitle: r.page_title,
      personName: r.full_name,
      state: r.registration_state as CrewRegistrationState,
      submittedAt: r.submitted_at,
      decidedAt: r.decided_at,
      confirmedMinimumAge: r.confirmed_minimum_age,
      profileShareId: r.profile_share_id,
      answers: (byRegistration.get(r.id as string) ?? [])
        .sort((a, b) => a.order - b.order)
        .map(({ prompt, answer }) => ({ prompt, answer })),
    })),
  );
}

export interface DecisionResult {
  readonly id: string;
  readonly outcome: "applied" | "refused";
  readonly code: string | null;
}

export async function decideRegistrations(
  db: XosClient,
  input: { ids: readonly string[]; approve: boolean; reason?: string | null },
): Promise<Result<DecisionResult[]>> {
  const { data, error } = await db.rpc("decide_crew_registrations", {
    p_ids: [...input.ids],
    p_approve: input.approve,
    ...(input.reason ? { p_reason: input.reason } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok((data as unknown as DecisionResult[]) ?? []);
}

export async function inviteToRegistration(
  db: XosClient,
  input: { pageId: string; includePastCrew: boolean },
): Promise<Result<{ invited: number }>> {
  const { data, error } = await db.rpc("invite_to_registration_page", {
    p_page_id: input.pageId,
    p_include_past_crew: input.includePastCrew,
  });
  if (error) return fail(toDataError(error));
  return ok({ invited: data as number });
}

import type { XosClient } from "./client.ts";
import { ok, type Result } from "./result.ts";
import { untyped } from "./untyped.ts";
import {
  args,
  bool,
  call,
  callId,
  callRows,
  list,
  memberName,
  MEMBER_EMBED,
  num,
  numOrNull,
  rows,
  single,
  str,
  strings,
  strOrNull,
  type Raw,
} from "./workforce-shared.ts";

/**
 * Training, the handbook and the Assistant source (Section 4.9; migration 0804), imported as
 * `@xos/data/workforce-training`. Course editors (knowledge.sop.publish) build lessons and quizzes,
 * publish and assign; learners finish lessons and are graded server side, never reading the answer
 * keys. A verifier turns a pass into a certification record. Handbook articles are versioned on
 * publish and mandatory reads are acknowledged per version.
 */

export type TrainingCourseState = "Draft" | "Published" | "Retired";
export type TrainingLessonKind = "Reading" | "Video" | "Quiz";
export type HandbookArticleState = "Draft" | "Published" | "Archived";

export const TRAINING_LESSON_KINDS: readonly TrainingLessonKind[] = ["Reading", "Video", "Quiz"];

export interface QuizQuestion {
  readonly id: string;
  readonly position: number;
  readonly prompt: string;
  readonly options: readonly string[];
}

export interface TrainingLesson {
  readonly id: string;
  readonly position: number;
  readonly title: string;
  readonly kind: TrainingLessonKind;
  readonly body: string | null;
  readonly videoUrl: string | null;
  readonly questions: readonly QuizQuestion[];
}

export interface TrainingCourse {
  readonly id: string;
  readonly title: string;
  readonly summary: string | null;
  readonly roleCode: string | null;
  readonly certificationId: string | null;
  readonly gateCriterionId: string | null;
  readonly validityDays: number | null;
  readonly passPercent: number;
  readonly estimatedMinutes: number | null;
  readonly state: TrainingCourseState;
  readonly lessons: readonly TrainingLesson[];
}

function toCourse(r: Raw): TrainingCourse {
  return {
    id: str(r["id"]),
    title: str(r["title"]),
    summary: strOrNull(r["summary"]),
    roleCode: strOrNull(r["role_code"]),
    certificationId: strOrNull(r["certification_id"]),
    gateCriterionId: strOrNull(r["gate_criterion_id"]),
    validityDays: numOrNull(r["validity_days"]),
    passPercent: num(r["pass_percent"]),
    estimatedMinutes: numOrNull(r["estimated_minutes"]),
    state: str(r["course_state"]) as TrainingCourseState,
    lessons: list(r["training_lessons"])
      .filter((l) => l["deleted_at"] === null)
      .map((l) => ({
        id: str(l["id"]),
        position: num(l["position"]),
        title: str(l["title"]),
        kind: str(l["lesson_kind"]) as TrainingLessonKind,
        body: strOrNull(l["body"]),
        videoUrl: strOrNull(l["video_url"]),
        questions: list(l["training_quiz_questions"])
          .filter((q) => q["deleted_at"] === null)
          .map((q) => ({
            id: str(q["id"]),
            position: num(q["position"]),
            prompt: str(q["prompt"]),
            options: strings(q["options"]),
          }))
          .sort((a, b) => a.position - b.position),
      }))
      .sort((a, b) => a.position - b.position),
  };
}

const COURSE_COLUMNS = `id, title, summary, role_code, certification_id, gate_criterion_id, validity_days, pass_percent, estimated_minutes, course_state,
  training_lessons(id, position, title, lesson_kind, body, video_url, deleted_at, training_quiz_questions(id, position, prompt, options, deleted_at))`;

export async function listTrainingCourses(
  db: XosClient,
  orgId: string,
): Promise<Result<TrainingCourse[]>> {
  return rows(
    untyped(db)
      .from("training_courses")
      .select(COURSE_COLUMNS)
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .order("title"),
    toCourse,
  );
}

export interface TrainingCourseInput {
  readonly title: string;
  readonly summary?: string | null;
  readonly roleCode?: string | null;
  readonly certificationId?: string | null;
  readonly gateCriterionId?: string | null;
  readonly validityDays?: number | null;
  readonly passPercent?: number;
  readonly estimatedMinutes?: number | null;
}

function courseColumns(input: TrainingCourseInput): Raw {
  return {
    title: input.title,
    summary: input.summary ?? null,
    role_code: input.roleCode ?? null,
    certification_id: input.certificationId ?? null,
    gate_criterion_id: input.gateCriterionId ?? null,
    validity_days: input.validityDays ?? null,
    pass_percent: input.passPercent ?? 80,
    estimated_minutes: input.estimatedMinutes ?? null,
  };
}

export async function createTrainingCourse(
  db: XosClient,
  orgId: string,
  input: TrainingCourseInput,
): Promise<Result<{ id: string }>> {
  return single(
    untyped(db)
      .from("training_courses")
      .insert({ org_id: orgId, ...courseColumns(input) })
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
}

export async function updateTrainingCourse(
  db: XosClient,
  id: string,
  input: TrainingCourseInput,
): Promise<Result<{ id: string }>> {
  return single(
    untyped(db)
      .from("training_courses")
      .update(courseColumns(input))
      .eq("id", id)
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
}

export interface TrainingLessonInput {
  readonly position: number;
  readonly title: string;
  readonly kind: TrainingLessonKind;
  readonly body?: string | null;
  readonly videoUrl?: string | null;
}

export async function addTrainingLesson(
  db: XosClient,
  courseId: string,
  input: TrainingLessonInput,
): Promise<Result<{ id: string }>> {
  return single(
    untyped(db)
      .from("training_lessons")
      .insert({
        training_course_id: courseId,
        position: input.position,
        title: input.title,
        lesson_kind: input.kind,
        body: input.body ?? null,
        video_url: input.videoUrl ?? null,
      })
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
}

/** Removes a draft lesson. */
export async function removeTrainingLesson(
  db: XosClient,
  lessonId: string,
): Promise<Result<{ id: string }>> {
  return single(
    untyped(db)
      .from("training_lessons")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", lessonId)
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
}

/** Adds a quiz question with its answer key (editors only read the key). */
export async function addQuizQuestion(
  db: XosClient,
  lessonId: string,
  input: {
    readonly position: number;
    readonly prompt: string;
    readonly options: readonly string[];
    readonly correctOption: number;
  },
): Promise<Result<{ id: string }>> {
  const question = await single(
    untyped(db)
      .from("training_quiz_questions")
      .insert({
        training_lesson_id: lessonId,
        position: input.position,
        prompt: input.prompt,
        options: [...input.options],
      })
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
  if (!question.ok) return question;
  const key = await single(
    untyped(db)
      .from("training_quiz_keys")
      .insert({ training_quiz_question_id: question.data.id, correct_option: input.correctOption })
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
  return key.ok ? question : key;
}

export async function publishTrainingCourse(
  db: XosClient,
  id: string,
): Promise<Result<{ id: string }>> {
  return callId(db, "publish_training_course", { p_course_id: id });
}

export async function retireTrainingCourse(
  db: XosClient,
  id: string,
  reason: string,
): Promise<Result<{ id: string }>> {
  return callId(db, "retire_training_course", { p_course_id: id, p_reason: reason });
}

export async function assignTraining(
  db: XosClient,
  courseId: string,
  membershipIds: readonly string[],
  dueOn?: string | null,
  reason?: string | null,
): Promise<Result<number>> {
  return call<number>(
    db,
    "assign_training",
    args({
      p_course_id: courseId,
      p_membership_ids: [...membershipIds],
      p_due_on: dueOn ?? undefined,
      p_reason: reason ?? undefined,
    }),
  );
}

export interface TrainingAssignment {
  readonly id: string;
  readonly courseId: string;
  readonly membershipId: string;
  readonly name: string | null;
  readonly dueOn: string | null;
  readonly reason: string | null;
}

export async function listTrainingAssignments(
  db: XosClient,
  orgId: string,
): Promise<Result<TrainingAssignment[]>> {
  return rows(
    untyped(db)
      .from("training_assignments")
      .select(
        `id, training_course_id, membership_id, due_on, reason, membership:memberships!training_assignments_membership_id_fkey(${MEMBER_EMBED})`,
      )
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .order("due_on", { nullsFirst: false }),
    (r) => ({
      id: str(r["id"]),
      courseId: str(r["training_course_id"]),
      membershipId: str(r["membership_id"]),
      name: memberName(r["membership"]),
      dueOn: strOrNull(r["due_on"]),
      reason: strOrNull(r["reason"]),
    }),
  );
}

export async function completeTrainingLesson(
  db: XosClient,
  lessonId: string,
): Promise<Result<{ id: string }>> {
  return callId(db, "complete_training_lesson", { p_lesson_id: lessonId });
}

/** Lesson ids the viewer finished. */
export async function listMyLessonProgress(
  db: XosClient,
  myMembershipIds: readonly string[],
): Promise<Result<string[]>> {
  return rows(
    untyped(db)
      .from("training_lesson_progress")
      .select("training_lesson_id")
      .in("membership_id", [...myMembershipIds]),
    (r) => str(r["training_lesson_id"]),
  );
}

/** Submits quiz answers (option numbers from 1) for grading. */
export async function completeTraining(
  db: XosClient,
  courseId: string,
  answers: Readonly<Record<string, number>>,
): Promise<Result<{ id: string }>> {
  return callId(db, "complete_training", { p_course_id: courseId, p_answers: answers });
}

export interface TrainingCompletion {
  readonly id: string;
  readonly courseId: string;
  readonly membershipId: string;
  readonly name: string | null;
  readonly scorePercent: number | null;
  readonly passed: boolean;
  readonly completedAt: string;
  readonly expiresAt: string | null;
  readonly certificateNumber: string | null;
  readonly certificationHolderId: string | null;
}

export async function listTrainingCompletions(
  db: XosClient,
  orgId: string,
): Promise<Result<TrainingCompletion[]>> {
  return rows(
    untyped(db)
      .from("training_completions")
      .select(
        `id, training_course_id, membership_id, score_percent, passed, completed_at, expires_at, certificate_number, certification_holder_id,
         membership:memberships(${MEMBER_EMBED})`,
      )
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .order("completed_at", { ascending: false }),
    (r) => ({
      id: str(r["id"]),
      courseId: str(r["training_course_id"]),
      membershipId: str(r["membership_id"]),
      name: memberName(r["membership"]),
      scorePercent: numOrNull(r["score_percent"]),
      passed: bool(r["passed"]),
      completedAt: str(r["completed_at"]),
      expiresAt: strOrNull(r["expires_at"]),
      certificateNumber: strOrNull(r["certificate_number"]),
      certificationHolderId: strOrNull(r["certification_holder_id"]),
    }),
  );
}

export async function issueTrainingCertification(
  db: XosClient,
  completionId: string,
): Promise<Result<{ id: string }>> {
  return callId(db, "issue_training_certification", { p_completion_id: completionId });
}

/** A learner's standing on a course from their completions: current, expired, failed or none. */
export function trainingStanding(
  completions: readonly Pick<TrainingCompletion, "passed" | "expiresAt" | "completedAt">[],
  now: Date = new Date(),
): "current" | "expired" | "failed" | "none" {
  if (completions.length === 0) return "none";
  const passes = completions.filter((c) => c.passed);
  if (passes.length === 0) return "failed";
  return passes.some((c) => c.expiresAt === null || Date.parse(c.expiresAt) > now.getTime())
    ? "current"
    : "expired";
}

/** Share of reading and video lessons finished, as a whole percent. */
export function lessonProgress(
  course: Pick<TrainingCourse, "lessons">,
  finished: ReadonlySet<string>,
): number {
  const lessons = course.lessons.filter((l) => l.kind !== "Quiz");
  if (lessons.length === 0) return 100;
  return Math.round((100 * lessons.filter((l) => finished.has(l.id)).length) / lessons.length);
}

// Handbook ----------------------------------------------------------------------------------------

export interface HandbookSection {
  readonly id: string;
  readonly name: string;
  readonly position: number;
}

export interface HandbookArticle {
  readonly id: string;
  readonly sectionId: string | null;
  readonly title: string;
  readonly body: string;
  readonly mandatory: boolean;
  readonly state: HandbookArticleState;
  readonly version: number;
  readonly publishedAt: string | null;
  readonly updatedAt: string;
  /** The published text members read; null before the first publish. */
  readonly published: {
    readonly title: string;
    readonly body: string;
    readonly changeSummary: string | null;
  } | null;
  readonly acknowledgedByMe: boolean;
}

export async function listHandbookSections(
  db: XosClient,
  orgId: string,
): Promise<Result<HandbookSection[]>> {
  return rows(
    untyped(db)
      .from("handbook_sections")
      .select("id, name, position")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .order("position"),
    (r) => ({ id: str(r["id"]), name: str(r["name"]), position: num(r["position"]) }),
  );
}

export async function createHandbookSection(
  db: XosClient,
  orgId: string,
  name: string,
  position: number,
): Promise<Result<{ id: string }>> {
  return single(
    untyped(db)
      .from("handbook_sections")
      .insert({ org_id: orgId, name, position })
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
}

export async function listHandbookArticles(
  db: XosClient,
  orgId: string,
  myMembershipIds: readonly string[],
): Promise<Result<HandbookArticle[]>> {
  const [articles, acks] = await Promise.all([
    rows(
      untyped(db)
        .from("handbook_articles")
        .select(
          "id, handbook_section_id, title, body, is_mandatory, article_state, published_version, published_at, updated_at, handbook_article_versions(version, title, body, change_summary)",
        )
        .eq("org_id", orgId)
        .is("deleted_at", null)
        .order("title"),
      (r) => r,
    ),
    rows(
      untyped(db)
        .from("handbook_acknowledgments")
        .select("handbook_article_id, version")
        .in("membership_id", [...myMembershipIds]),
      (r) => `${str(r["handbook_article_id"])}:${num(r["version"])}`,
    ),
  ]);
  if (!articles.ok) return articles;
  if (!acks.ok) return acks;
  const acked = new Set(acks.data);
  return ok(
    articles.data.map((r): HandbookArticle => {
      const version = num(r["published_version"]);
      const current = list(r["handbook_article_versions"]).find(
        (v) => num(v["version"]) === version,
      );
      return {
        id: str(r["id"]),
        sectionId: strOrNull(r["handbook_section_id"]),
        title: str(r["title"]),
        body: str(r["body"]),
        mandatory: bool(r["is_mandatory"]),
        state: str(r["article_state"]) as HandbookArticleState,
        version,
        publishedAt: strOrNull(r["published_at"]),
        updatedAt: str(r["updated_at"]),
        published: current
          ? {
              title: str(current["title"]),
              body: str(current["body"]),
              changeSummary: strOrNull(current["change_summary"]),
            }
          : null,
        acknowledgedByMe: acked.has(`${str(r["id"])}:${version}`),
      };
    }),
  );
}

export interface HandbookArticleInput {
  readonly title: string;
  readonly body: string;
  readonly sectionId?: string | null;
  readonly mandatory?: boolean;
}

export async function createHandbookArticle(
  db: XosClient,
  orgId: string,
  input: HandbookArticleInput,
): Promise<Result<{ id: string }>> {
  return single(
    untyped(db)
      .from("handbook_articles")
      .insert({
        org_id: orgId,
        title: input.title,
        body: input.body,
        handbook_section_id: input.sectionId ?? null,
        is_mandatory: input.mandatory ?? false,
      })
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
}

/** Edits the working text; members keep reading the published version until the next publish. */
export async function updateHandbookArticle(
  db: XosClient,
  id: string,
  input: HandbookArticleInput,
): Promise<Result<{ id: string }>> {
  return single(
    untyped(db)
      .from("handbook_articles")
      .update({
        title: input.title,
        body: input.body,
        handbook_section_id: input.sectionId ?? null,
        is_mandatory: input.mandatory ?? false,
      })
      .eq("id", id)
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
}

export async function archiveHandbookArticle(
  db: XosClient,
  id: string,
): Promise<Result<{ id: string }>> {
  return single(
    untyped(db)
      .from("handbook_articles")
      .update({ article_state: "Archived" })
      .eq("id", id)
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
}

export async function publishHandbookArticle(
  db: XosClient,
  id: string,
  changeSummary?: string | null,
): Promise<Result<number>> {
  return call<number>(
    db,
    "publish_handbook_article",
    args({ p_article_id: id, p_change_summary: changeSummary ?? undefined }),
  );
}

export async function acknowledgeHandbookArticle(
  db: XosClient,
  id: string,
): Promise<Result<{ id: string }>> {
  return callId(db, "acknowledge_handbook_article", { p_article_id: id });
}

/** Whether the working text differs from what members read. */
export function handbookChanged(a: Pick<HandbookArticle, "title" | "body" | "published">): boolean {
  return a.published === null || a.published.title !== a.title || a.published.body !== a.body;
}

export interface HandbookAckStatus {
  readonly membershipId: string;
  readonly name: string;
  readonly acknowledgedAt: string | null;
}

export async function listHandbookAcknowledgmentStatus(
  db: XosClient,
  articleId: string,
): Promise<Result<HandbookAckStatus[]>> {
  return callRows(db, "handbook_acknowledgment_status", { p_article_id: articleId }, (r) => ({
    membershipId: str(r["membership_id"]),
    name: str(r["full_name"]),
    acknowledgedAt: strOrNull(r["acknowledged_at"]),
  }));
}

export interface MandatoryRead {
  readonly articleId: string;
  readonly title: string;
  readonly version: number;
  readonly publishedAt: string | null;
}

export async function listMyMandatoryReads(
  db: XosClient,
  orgId: string,
): Promise<Result<MandatoryRead[]>> {
  return callRows(db, "my_mandatory_reads", { p_org_id: orgId }, (r) => ({
    articleId: str(r["handbook_article_id"]),
    title: str(r["title"]),
    version: num(r["version"]),
    publishedAt: strOrNull(r["published_at"]),
  }));
}

// Assistant source (A25) ----------------------------------------------------------------------------

export type KnowledgeSourceKind = "Handbook" | "SOP" | "Training";

export interface KnowledgeSource {
  readonly kind: KnowledgeSourceKind;
  readonly id: string;
  readonly title: string;
  readonly version: number | null;
  readonly excerpt: string;
  readonly route: string;
  readonly rank: number;
}

/**
 * The Assistant's source search (Section 4.7 and 4.9 Assistant): published handbook articles, SOPs
 * and training lessons the caller can read that match the question, ranked, each with an excerpt and
 * the Atlas route that cites it. Answers must cite only what this returns.
 */
export async function searchKnowledgeSources(
  db: XosClient,
  orgId: string,
  query: string,
  limit = 8,
): Promise<Result<KnowledgeSource[]>> {
  return callRows(
    db,
    "assistant_knowledge_sources",
    { p_org_id: orgId, p_query: query, p_limit: limit },
    (r) => ({
      kind: str(r["source_kind"]) as KnowledgeSourceKind,
      id: str(r["source_id"]),
      title: str(r["title"]),
      version: numOrNull(r["version"]),
      excerpt: str(r["excerpt"]),
      route: str(r["route"]),
      rank: num(r["rank"]),
    }),
  );
}

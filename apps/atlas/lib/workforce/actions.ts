"use server";

import {
  addGroupMember,
  archiveGroup,
  createGroup,
  deleteMessage,
  removeGroupMember,
  sendMessage,
  startDirectConversation,
  markConversationRead,
  GROUP_KINDS,
  type GroupKind,
} from "@xos/data/workforce-chat";
import {
  acknowledgeFeedPost,
  createFeedPost,
  createSurvey,
  hideFeedPost,
  reactToFeedPost,
  recognize,
  respondToSurvey,
  setRecognitionConsent,
  transitionSurvey,
  updateFeedPost,
  voteInPoll,
  REACTION_CODES,
  type FeedPostKind,
  type ReactionCode,
  type SurveyQuestionInput,
  type SurveyState,
} from "@xos/data/workforce-feed";
import {
  cancelWorkforceEvent,
  checkInToEvent,
  createWorkforceEvent,
  rsvpToEvent,
  RSVP_RESPONSES,
  WORKFORCE_EVENT_KINDS,
  type RsvpResponse,
  type WorkforceEventKind,
} from "@xos/data/workforce-events";
import {
  createFormTemplate,
  decideFormSubmission,
  publishFormTemplate,
  retireFormTemplate,
  submitForm,
  updateFormTemplate,
  type FormAnswers,
} from "@xos/data/workforce-forms";
import {
  acknowledgeHandbookArticle,
  addQuizQuestion,
  addTrainingLesson,
  assignTraining,
  completeTraining,
  completeTrainingLesson,
  createHandbookArticle,
  createHandbookSection,
  createTrainingCourse,
  issueTrainingCertification,
  publishHandbookArticle,
  publishTrainingCourse,
  retireTrainingCourse,
  updateHandbookArticle,
  archiveHandbookArticle,
  TRAINING_LESSON_KINDS,
  type TrainingLessonKind,
} from "@xos/data/workforce-training";
import {
  addHelpDeskTeamMember,
  answerHelpDeskRequest,
  archiveHelpDeskTeam,
  assignHelpDeskRequest,
  createHelpDeskTeam,
  openHelpDeskRequest,
  removeHelpDeskTeamMember,
  transitionHelpDeskRequest,
  HELP_DESK_TEAM_KINDS,
  SUPPORT_CATEGORIES,
  SUPPORT_SEVERITIES,
  type HelpDeskTeamKind,
  type SupportCategory,
  type SupportSeverity,
  type SupportTicketState,
} from "@xos/data/workforce-help-desk";
import {
  addWeatherAlertRole,
  checkInGuest,
  claimLostItem,
  closeOccupancyCounter,
  createOccupancyCounter,
  disposeLostItem,
  logLostItem,
  recordOccupancyCount,
  recordWeatherReading,
  removeWeatherAlertRole,
  setWeatherThreshold,
  settleLostItemClaim,
  LOST_ITEM_CATEGORIES,
  WEATHER_HAZARDS,
  WEATHER_LEVELS,
  type LostItemCategory,
  type WeatherAlertLevel,
  type WeatherHazard,
} from "@xos/data/workforce-site";
import { actionContext, finish } from "@/lib/collection-kit/actions";
import {
  FieldErrors,
  all,
  decimal,
  integer,
  isoDate,
  isoInstant,
  requiredText,
  text,
  uuid,
  type ActionState,
} from "@/lib/collection-kit/forms";
import { parseFieldList, parseSurveyQuestions } from "./parse";
import { uploadFormMedia } from "./media";
import { storedHazardValue, UNIT_SYSTEMS } from "./units";
import type { UnitSystem } from "@xos/ui/preferences";

/**
 * Workforce suite actions (A29, Section 4.9). Row level security and the 0800 to 0808 RPCs decide
 * every write; these actions parse the form, call one repository function and report the outcome.
 */

const of = <T extends string>(value: string | null, list: readonly T[]): T | null =>
  value !== null && (list as readonly string[]).includes(value) ? (value as T) : null;
const bool = (form: FormData, name: string) => form.get(name) === "on" || form.get(name) === "true";
const reasonOf = (form: FormData) => requiredText(form, "reason", 500);

function audienceOf(form: FormData) {
  const kind = text(form, "audienceKind") ?? "Organization";
  const target = uuid(form, "audienceTarget");
  const department = text(form, "audienceTarget");
  return {
    kind: kind as "Organization" | "Project" | "Team" | "Department" | "Role" | "Group",
    projectId: kind === "Project" ? target : null,
    teamId: kind === "Team" ? target : null,
    roleId: kind === "Role" ? target : null,
    groupId: kind === "Group" ? target : null,
    // A canon department code (1365); only feed posts offer it.
    departmentCode:
      kind === "Department" && department !== null && /^[0-9]000$/.test(department)
        ? department
        : null,
  };
}

/** True when the audience names the target its kind needs. */
function audienceComplete(audience: ReturnType<typeof audienceOf>): boolean {
  if (audience.kind === "Organization") return true;
  if (audience.kind === "Department") return audience.departmentCode !== null;
  return [audience.projectId, audience.teamId, audience.roleId, audience.groupId].some(
    (v) => v !== null,
  );
}

// Groups and chat -------------------------------------------------------------------------------------

export async function createGroupAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const name = errors.need("name", requiredText(form, "name", 120));
  const kind = errors.need("kind", of<GroupKind>(text(form, "kind"), GROUP_KINDS));
  const projectId = uuid(form, "projectId");
  if (kind === "Project" && projectId === null) errors.add("projectId", "required");
  if (errors.any || !name || !kind) return errors.state;
  return finish(
    await createGroup(ctx.viewer.db, ctx.org.id, {
      name,
      kind,
      projectId: kind === "Project" ? projectId : null,
      description: text(form, "description"),
    }),
    ctx,
    "people",
  );
}

export async function archiveGroupAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  return finish(await archiveGroup(ctx.viewer.db, id), ctx, "people");
}

export async function addGroupMemberAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const membership = uuid(form, "membershipId");
  if (id === null) return { error: "notFound" };
  if (membership === null) return { fieldErrors: { membershipId: "required" } };
  return finish(
    await addGroupMember(
      ctx.viewer.db,
      id,
      membership,
      form.get("owner") === "on" ? "Owner" : "Member",
    ),
    ctx,
    "people",
  );
}

export async function removeGroupMemberAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  return finish(await removeGroupMember(ctx.viewer.db, id), ctx, "people");
}

export async function startConversationAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext(form);
  const other = uuid(form, "membershipId");
  if (other === null) return { fieldErrors: { membershipId: "required" } };
  return finish(await startDirectConversation(ctx.viewer.db, ctx.org.id, other), ctx, "people");
}

export async function sendMessageAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const conversation = uuid(form, "id");
  const body = requiredText(form, "body", 4000);
  if (conversation === null) return { error: "notFound" };
  if (body === null) return { fieldErrors: { body: "required" } };
  return finish(await sendMessage(ctx.viewer.db, conversation, { body }), ctx, "people");
}

export async function deleteMessageAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  return finish(await deleteMessage(ctx.viewer.db, id), ctx, "people");
}

export async function markReadAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  const muted = form.get("muted");
  const result = await markConversationRead(
    ctx.viewer.db,
    id,
    muted === null ? undefined : muted === "true",
  );
  return finish(result.ok ? { ok: true, data: { id } } : result, ctx, "people");
}

// Feed -------------------------------------------------------------------------------------------------

export async function createPostAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const kind = errors.need(
    "kind",
    of<FeedPostKind>(text(form, "kind"), ["Announcement", "Update", "Poll"]),
  );
  const body = errors.need("body", requiredText(form, "body", 10_000));
  const publishAt = isoInstant(form, "publishAt");
  if (publishAt === undefined) errors.add("publishAt", "date");
  const options = (text(form, "options") ?? "")
    .split("\n")
    .map((o) => o.trim())
    .filter((o) => o !== "");
  if (kind === "Poll" && (options.length < 2 || options.length > 10))
    errors.add("options", "lineFormat");
  const audience = audienceOf(form);
  if (!audienceComplete(audience)) errors.add("audienceTarget", "required");
  if (errors.any || !kind || !body) return errors.state;
  return finish(
    await createFeedPost(ctx.viewer.db, ctx.org.id, {
      kind,
      body,
      title: text(form, "title"),
      audience,
      pinned: all(form, "switches").includes("pinned"),
      requiresAcknowledgment: all(form, "switches").includes("requiresAcknowledgment"),
      reactionsEnabled: all(form, "switches").includes("reactionsEnabled"),
      commentsEnabled: all(form, "switches").includes("commentsEnabled"),
      publishAt: publishAt ?? null,
      poll:
        kind === "Poll"
          ? {
              question: text(form, "question") ?? body,
              options,
              allowsMultiple: bool(form, "allowsMultiple"),
            }
          : null,
    }),
    ctx,
    "knowledge",
  );
}

export async function acknowledgePostAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  return finish(await acknowledgeFeedPost(ctx.viewer.db, id), ctx, "knowledge");
}

export async function reactAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const code = of<ReactionCode>(text(form, "code"), REACTION_CODES);
  if (id === null || code === null) return { error: "notFound" };
  const result = await reactToFeedPost(ctx.viewer.db, id, code, form.get("on") !== "false");
  return finish(result.ok ? { ok: true, data: { id } } : result, ctx, "knowledge");
}

export async function pinPostAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  return finish(
    await updateFeedPost(ctx.viewer.db, id, { pinned: form.get("pinned") === "true" }),
    ctx,
    "knowledge",
  );
}

export async function postSwitchesAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  const changes: { reactionsEnabled?: boolean; commentsEnabled?: boolean } = {};
  if (form.get("reactions") !== null) changes.reactionsEnabled = form.get("reactions") === "true";
  if (form.get("comments") !== null) changes.commentsEnabled = form.get("comments") === "true";
  return finish(await updateFeedPost(ctx.viewer.db, id, changes), ctx, "knowledge");
}

export async function hidePostAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const reason = reasonOf(form);
  if (id === null) return { error: "notFound" };
  if (reason === null) return { fieldErrors: { reason: "required" } };
  return finish(await hideFeedPost(ctx.viewer.db, id, reason), ctx, "knowledge");
}

export async function voteAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const options = all(form, "option").filter((o) => /^[0-9a-f-]{36}$/i.test(o));
  if (id === null) return { error: "notFound" };
  if (options.length === 0) return { fieldErrors: { option: "required" } };
  const result = await voteInPoll(ctx.viewer.db, id, options);
  return finish(result.ok ? { ok: true, data: { id } } : result, ctx, "knowledge");
}

export async function createSurveyAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const title = errors.need("title", requiredText(form, "title", 200));
  const parsed = parseSurveyQuestions(text(form, "questions") ?? "");
  if (parsed.problems.length > 0) errors.add("questions", "lineFormat");
  const minResponses = integer(form, "minResponses", 3, 1000);
  if (minResponses === undefined) errors.add("minResponses", "wholeNumber");
  const audience = audienceOf(form);
  if (errors.any || !title) return errors.state;
  const questions: SurveyQuestionInput[] = parsed.questions;
  return finish(
    await createSurvey(ctx.viewer.db, ctx.org.id, {
      title,
      description: text(form, "description"),
      audience,
      anonymous: bool(form, "anonymous"),
      minResponses: minResponses ?? 5,
      questions,
    }),
    ctx,
    "knowledge",
  );
}

export async function transitionSurveyAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const expected = of<SurveyState>(text(form, "expected"), ["Draft", "Open", "Closed"]);
  const next = of<SurveyState>(text(form, "next"), ["Draft", "Open", "Closed"]);
  const reason = reasonOf(form);
  if (id === null || expected === null || next === null) return { error: "notFound" };
  if (reason === null) return { fieldErrors: { reason: "required" } };
  return finish(
    await transitionSurvey(ctx.viewer.db, id, expected, next, reason),
    ctx,
    "knowledge",
  );
}

export async function respondSurveyAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  const answers: Record<string, string | number> = {};
  for (const [key, value] of form.entries()) {
    if (!key.startsWith("q:") || typeof value !== "string" || value.trim() === "") continue;
    const question = key.slice(2);
    answers[question] = form.get(`kind:${question}`) === "Scale" ? Number(value) : value.trim();
  }
  const result = await respondToSurvey(ctx.viewer.db, id, answers);
  return finish(result.ok ? { ok: true, data: { id } } : result, ctx, "knowledge");
}

// Recognition ----------------------------------------------------------------------------------------------

export async function recognizeAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const to = errors.need("membershipId", uuid(form, "membershipId"));
  const message = errors.need("message", requiredText(form, "message", 1000));
  if (errors.any || !to || !message) return errors.state;
  return finish(
    await recognize(ctx.viewer.db, ctx.org.id, {
      toMembershipId: to,
      message,
      projectId: uuid(form, "projectId"),
    }),
    ctx,
    "people",
  );
}

export async function recognitionConsentAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext(form);
  const person = ctx.viewer.person?.id;
  if (!person) return { error: "notFound" };
  const result = await setRecognitionConsent(
    ctx.viewer.db,
    ctx.org.id,
    person,
    form.get("consent") === "true",
  );
  return finish(result.ok ? { ok: true, data: { id: person } } : result, ctx, "people");
}

// Events -------------------------------------------------------------------------------------------------------

export async function createEventAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const kind = errors.need(
    "kind",
    of<WorkforceEventKind>(text(form, "kind"), WORKFORCE_EVENT_KINDS),
  );
  const title = errors.need("title", requiredText(form, "title", 200));
  const startsAt = errors.need("startsAt", isoInstant(form, "startsAt"), "date");
  const endsAt = errors.need("endsAt", isoInstant(form, "endsAt"), "date");
  if (startsAt && endsAt && endsAt <= startsAt) errors.add("endsAt", "dateOrder");
  const audience = audienceOf(form);
  if (audience.kind !== "Organization" && uuid(form, "audienceTarget") === null)
    errors.add("audienceTarget", "required");
  if (errors.any || !kind || !title || !startsAt || !endsAt) return errors.state;
  return finish(
    await createWorkforceEvent(ctx.viewer.db, ctx.org.id, ctx.org.membershipId, {
      kind,
      title,
      startsAt,
      endsAt,
      agenda: text(form, "agenda"),
      location: text(form, "location"),
      audience,
    }),
    ctx,
    "schedule",
  );
}

export async function cancelEventAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const reason = reasonOf(form);
  if (id === null) return { error: "notFound" };
  if (reason === null) return { fieldErrors: { reason: "required" } };
  return finish(await cancelWorkforceEvent(ctx.viewer.db, id, reason), ctx, "schedule");
}

export async function rsvpAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const response = of<RsvpResponse>(text(form, "response"), RSVP_RESPONSES);
  if (id === null || response === null) return { error: "notFound" };
  return finish(await rsvpToEvent(ctx.viewer.db, id, response), ctx, "schedule");
}

export async function checkInAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const membership = uuid(form, "membershipId");
  if (id === null) return { error: "notFound" };
  return finish(
    await checkInToEvent(
      ctx.viewer.db,
      id,
      membership ?? undefined,
      membership ? "Organizer" : "Self",
    ),
    ctx,
    "schedule",
  );
}

// Forms ---------------------------------------------------------------------------------------------------------

function templateInput(form: FormData, errors: FieldErrors) {
  const name = errors.need("name", requiredText(form, "name", 200));
  const kindSubtype = text(form, "recordKind") ?? "";
  const [recordKind, recordSubtype] = kindSubtype.split("/");
  if (!recordKind) errors.add("recordKind", "required");
  const parsed = parseFieldList(text(form, "fields") ?? "");
  if (parsed.problems.length > 0) errors.add("fields", "lineFormat");
  const passScore = decimal(form, "passScore");
  if (passScore === undefined) errors.add("passScore", "number");
  return {
    name,
    input: {
      name: name ?? "",
      description: text(form, "description"),
      recordKind: recordKind ?? "",
      recordSubtype: recordSubtype ?? null,
      fields: parsed.fields,
      requiresSignature: all(form, "rules").includes("requiresSignature"),
      requiresLocation: all(form, "rules").includes("requiresLocation"),
      passScore: passScore ?? null,
      approverRoleId: uuid(form, "approverRoleId"),
    },
  };
}

export async function createFormAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const { input } = templateInput(form, errors);
  if (errors.any) return errors.state;
  return finish(await createFormTemplate(ctx.viewer.db, ctx.org.id, input), ctx, "knowledge");
}

export async function updateFormAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  const errors = new FieldErrors();
  const { input } = templateInput(form, errors);
  if (errors.any) return errors.state;
  return finish(await updateFormTemplate(ctx.viewer.db, id, input), ctx, "knowledge");
}

export async function publishFormAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  const result = await publishFormTemplate(ctx.viewer.db, id);
  return finish(result.ok ? { ok: true, data: { id } } : result, ctx, "knowledge");
}

export async function retireFormAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const reason = reasonOf(form);
  if (id === null) return { error: "notFound" };
  if (reason === null) return { fieldErrors: { reason: "required" } };
  return finish(await retireFormTemplate(ctx.viewer.db, id, reason), ctx, "knowledge");
}

/** Submits a form filled in Atlas: answers as JSON, photos and a signature uploaded first. */
export async function submitFormAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const person = ctx.viewer.person?.id;
  if (id === null || !person) return { error: "notFound" };
  let answers: Record<string, unknown>;
  try {
    answers = JSON.parse(String(form.get("answers") ?? "{}")) as Record<string, unknown>;
  } catch {
    return { error: "invalid" };
  }
  for (const [key, value] of form.entries()) {
    if (!key.startsWith("photo:") || !(value instanceof File) || value.size === 0) continue;
    const uploaded = await uploadFormMedia(ctx.viewer.db, ctx.org.id, person, value);
    if (!uploaded.ok)
      return { error: uploaded.error === "uploadFailed" ? "unexpected" : "invalid" };
    const field = key.slice(6);
    answers[field] = [...((answers[field] as string[] | undefined) ?? []), uploaded.path];
  }
  let signature: { signerName: string; signaturePath: string } | null = null;
  const signerName = text(form, "signerName");
  const signatureFile = form.get("signature");
  if (signerName !== null && signatureFile instanceof File && signatureFile.size > 0) {
    const uploaded = await uploadFormMedia(ctx.viewer.db, ctx.org.id, person, signatureFile);
    if (!uploaded.ok)
      return { error: uploaded.error === "uploadFailed" ? "unexpected" : "invalid" };
    signature = { signerName, signaturePath: uploaded.path };
  }
  const latitude = decimal(form, "latitude");
  const longitude = decimal(form, "longitude");
  return finish(
    await submitForm(ctx.viewer.db, id, {
      answers: answers as FormAnswers,
      projectId: uuid(form, "projectId"),
      location:
        typeof latitude === "number" && typeof longitude === "number"
          ? {
              latitude,
              longitude,
              ...(typeof decimal(form, "accuracy") === "number"
                ? { accuracyM: decimal(form, "accuracy") as number }
                : {}),
            }
          : null,
      signature,
    }),
    ctx,
    "knowledge",
  );
}

export async function decideSubmissionAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  const approve = form.get("approve") === "true";
  const note = text(form, "reason");
  if (!approve && note === null) return { fieldErrors: { reason: "required" } };
  return finish(await decideFormSubmission(ctx.viewer.db, id, approve, note), ctx, "knowledge");
}

// Training and handbook -------------------------------------------------------------------------------------------

export async function createCourseAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const title = errors.need("title", requiredText(form, "title", 200));
  const validity = integer(form, "validityDays", 1, 3650);
  if (validity === undefined) errors.add("validityDays", "wholeNumber");
  const pass = integer(form, "passPercent", 1, 100);
  if (pass === undefined) errors.add("passPercent", "wholeNumber");
  if (errors.any || !title) return errors.state;
  return finish(
    await createTrainingCourse(ctx.viewer.db, ctx.org.id, {
      title,
      summary: text(form, "summary"),
      roleCode: text(form, "roleCode"),
      certificationId: uuid(form, "certificationId"),
      validityDays: validity ?? null,
      passPercent: pass ?? 80,
    }),
    ctx,
    "knowledge",
  );
}

export async function addLessonAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  const errors = new FieldErrors();
  const title = errors.need("title", requiredText(form, "title", 200));
  const kind = errors.need(
    "kind",
    of<TrainingLessonKind>(text(form, "kind"), TRAINING_LESSON_KINDS),
  );
  const position = errors.need("position", integer(form, "position", 1, 100), "wholeNumber");
  const videoUrl = text(form, "videoUrl");
  if (kind === "Video" && (videoUrl === null || !videoUrl.startsWith("https://")))
    errors.add("videoUrl", "httpsUrl");
  if (kind === "Reading" && text(form, "body") === null) errors.add("body", "required");
  if (errors.any || !title || !kind || !position) return errors.state;
  return finish(
    await addTrainingLesson(ctx.viewer.db, id, {
      position,
      title,
      kind,
      body: text(form, "body"),
      videoUrl: kind === "Video" ? videoUrl : null,
    }),
    ctx,
    "knowledge",
  );
}

export async function addQuizQuestionAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  const errors = new FieldErrors();
  const prompt = errors.need("prompt", requiredText(form, "prompt", 500));
  const options = (text(form, "options") ?? "")
    .split("\n")
    .map((o) => o.trim())
    .filter((o) => o !== "");
  if (options.length < 2 || options.length > 6) errors.add("options", "lineFormat");
  const correct = integer(form, "correct", 1, 6);
  if (correct === null || correct === undefined || correct > options.length)
    errors.add("correct", "quizCorrect");
  const position = integer(form, "position", 1, 50) ?? 1;
  if (errors.any || !prompt || !correct) return errors.state;
  return finish(
    await addQuizQuestion(ctx.viewer.db, id, { position, prompt, options, correctOption: correct }),
    ctx,
    "knowledge",
  );
}

export async function publishCourseAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  return finish(await publishTrainingCourse(ctx.viewer.db, id), ctx, "knowledge");
}

export async function retireCourseAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const reason = reasonOf(form);
  if (id === null) return { error: "notFound" };
  if (reason === null) return { fieldErrors: { reason: "required" } };
  return finish(await retireTrainingCourse(ctx.viewer.db, id, reason), ctx, "knowledge");
}

export async function assignCourseAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const members = all(form, "membershipIds").filter((m) => /^[0-9a-f-]{36}$/i.test(m));
  const due = isoDate(form, "dueOn");
  if (id === null) return { error: "notFound" };
  if (members.length === 0) return { fieldErrors: { membershipIds: "required" } };
  if (due === undefined) return { fieldErrors: { dueOn: "date" } };
  const result = await assignTraining(ctx.viewer.db, id, members, due, text(form, "reason"));
  return finish(result.ok ? { ok: true, data: { id } } : result, ctx, "knowledge");
}

export async function completeLessonAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  return finish(await completeTrainingLesson(ctx.viewer.db, id), ctx, "knowledge");
}

export async function completeCourseAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  const answers: Record<string, number> = {};
  for (const [key, value] of form.entries()) {
    if (key.startsWith("q:") && typeof value === "string" && /^[1-6]$/.test(value))
      answers[key.slice(2)] = Number(value);
  }
  return finish(await completeTraining(ctx.viewer.db, id, answers), ctx, "knowledge");
}

export async function issueCertificationAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  return finish(await issueTrainingCertification(ctx.viewer.db, id), ctx, "knowledge");
}

export async function createSectionAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const name = requiredText(form, "name", 120);
  if (name === null) return { fieldErrors: { name: "required" } };
  return finish(
    await createHandbookSection(
      ctx.viewer.db,
      ctx.org.id,
      name,
      integer(form, "position", 1, 500) ?? 1,
    ),
    ctx,
    "knowledge",
  );
}

export async function saveArticleAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const title = errors.need("title", requiredText(form, "title", 200));
  const body = errors.need("body", requiredText(form, "body", 100_000));
  if (errors.any || !title || !body) return errors.state;
  const input = {
    title,
    body,
    sectionId: uuid(form, "sectionId"),
    mandatory: bool(form, "mandatory"),
  };
  const id = uuid(form, "id");
  return finish(
    id === null
      ? await createHandbookArticle(ctx.viewer.db, ctx.org.id, input)
      : await updateHandbookArticle(ctx.viewer.db, id, input),
    ctx,
    "knowledge",
  );
}

export async function publishArticleAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  const result = await publishHandbookArticle(ctx.viewer.db, id, text(form, "changeSummary"));
  return finish(result.ok ? { ok: true, data: { id } } : result, ctx, "knowledge");
}

export async function acknowledgeArticleAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  return finish(await acknowledgeHandbookArticle(ctx.viewer.db, id), ctx, "knowledge");
}

export async function archiveArticleAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  return finish(await archiveHandbookArticle(ctx.viewer.db, id), ctx, "knowledge");
}

// Help desk ---------------------------------------------------------------------------------------------------------

export async function createTeamAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const name = errors.need("name", requiredText(form, "name", 120));
  const kind = errors.need("kind", of<HelpDeskTeamKind>(text(form, "kind"), HELP_DESK_TEAM_KINDS));
  const hours = errors.need("hours", integer(form, "hours", 1, 168), "wholeNumber");
  if (errors.any || !name || !kind || !hours) return errors.state;
  return finish(
    await createHelpDeskTeam(ctx.viewer.db, ctx.org.id, {
      name,
      kind,
      firstResponseHours: hours,
      description: text(form, "description"),
    }),
    ctx,
    "settings",
  );
}

export async function archiveTeamAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  return finish(await archiveHelpDeskTeam(ctx.viewer.db, id), ctx, "settings");
}

export async function addTeamMemberAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const member = uuid(form, "membershipId");
  if (id === null) return { error: "notFound" };
  if (member === null) return { fieldErrors: { membershipId: "required" } };
  return finish(await addHelpDeskTeamMember(ctx.viewer.db, id, member), ctx, "settings");
}

export async function removeTeamMemberAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  return finish(await removeHelpDeskTeamMember(ctx.viewer.db, id), ctx, "settings");
}

export async function openRequestAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const team = errors.need("teamId", uuid(form, "teamId"));
  const category = errors.need(
    "category",
    of<SupportCategory>(text(form, "category"), SUPPORT_CATEGORIES),
  );
  const severity = of<SupportSeverity>(text(form, "severity"), SUPPORT_SEVERITIES) ?? "Severity 3";
  const subject = errors.need("subject", requiredText(form, "subject", 200));
  const body = errors.need("body", requiredText(form, "body", 10_000));
  if (errors.any || !team || !category || !subject || !body) return errors.state;
  return finish(
    await openHelpDeskRequest(ctx.viewer.db, ctx.org.id, {
      teamId: team,
      category,
      severity,
      subject,
      body,
    }),
    ctx,
    "people",
  );
}

export async function assignRequestAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  return finish(
    await assignHelpDeskRequest(
      ctx.viewer.db,
      id,
      uuid(form, "membershipId"),
      uuid(form, "teamId") ?? undefined,
    ),
    ctx,
    "people",
  );
}

export async function answerRequestAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const body = requiredText(form, "body", 10_000);
  if (id === null) return { error: "notFound" };
  if (body === null) return { fieldErrors: { body: "required" } };
  return finish(await answerHelpDeskRequest(ctx.viewer.db, id, body), ctx, "people");
}

export async function transitionRequestAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const states: SupportTicketState[] = ["Open", "Waiting", "Resolved", "Closed"];
  const expected = of(text(form, "expected"), states);
  const next = of(text(form, "next"), states);
  const reason = reasonOf(form);
  if (id === null || expected === null || next === null) return { error: "notFound" };
  if (reason === null) return { fieldErrors: { reason: "required" } };
  return finish(
    await transitionHelpDeskRequest(ctx.viewer.db, id, expected, next, reason),
    ctx,
    "people",
  );
}

// Site operations ------------------------------------------------------------------------------------------------------

export async function createCounterAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const project = errors.need("projectId", uuid(form, "projectId"));
  const name = errors.need("name", requiredText(form, "name", 120));
  const load = integer(form, "permittedLoad", 1, 1_000_000);
  if (load === undefined) errors.add("permittedLoad", "wholeNumber");
  if (errors.any || !project || !name) return errors.state;
  return finish(
    await createOccupancyCounter(ctx.viewer.db, {
      projectId: project,
      name,
      spaceId: uuid(form, "spaceId"),
      metricItem: text(form, "metricItem"),
      permittedLoad: load ?? null,
    }),
    ctx,
    "site-ops",
  );
}

export async function countAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const delta = integer(form, "delta", -500, 500);
  if (id === null) return { error: "notFound" };
  if (delta === null || delta === undefined || delta === 0)
    return { fieldErrors: { delta: "wholeNumber" } };
  const result = await recordOccupancyCount(ctx.viewer.db, id, delta, text(form, "door"));
  return finish(result.ok ? { ok: true, data: { id } } : result, ctx, "site-ops");
}

export async function closeCounterAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  return finish(await closeOccupancyCounter(ctx.viewer.db, id), ctx, "site-ops");
}

export async function setThresholdAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const project = errors.need("projectId", uuid(form, "projectId"));
  const hazard = errors.need("hazard", of<WeatherHazard>(text(form, "hazard"), WEATHER_HAZARDS));
  const level = errors.need("level", of<WeatherAlertLevel>(text(form, "level"), WEATHER_LEVELS));
  const value = errors.need("value", decimal(form, "value"), "number");
  const source = errors.need("sourceNote", requiredText(form, "sourceNote", 300));
  if (errors.any || !project || !hazard || !level || value === null || !source) return errors.state;
  // The value was typed in the units the form showed (locale.units); the threshold is stored in the hazard's unit.
  const units = of<UnitSystem>(text(form, "units"), UNIT_SYSTEMS) ?? "imperial";
  return finish(
    await setWeatherThreshold(ctx.viewer.db, ctx.org.id, project, {
      hazard,
      level,
      value: storedHazardValue(hazard, value, units),
      sourceNote: source,
    }),
    ctx,
    "site-ops",
  );
}

export async function addAlertRoleAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const project = uuid(form, "projectId");
  const level = of<WeatherAlertLevel>(text(form, "level"), WEATHER_LEVELS);
  const role = text(form, "roleCode");
  if (project === null) return { error: "notFound" };
  if (level === null || role === null) return { fieldErrors: { roleCode: "required" } };
  return finish(
    await addWeatherAlertRole(ctx.viewer.db, ctx.org.id, project, level, role),
    ctx,
    "site-ops",
  );
}

export async function removeAlertRoleAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  return finish(await removeWeatherAlertRole(ctx.viewer.db, id), ctx, "site-ops");
}

export async function recordReadingAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const project = errors.need("projectId", uuid(form, "projectId"));
  const hazard = errors.need("hazard", of<WeatherHazard>(text(form, "hazard"), WEATHER_HAZARDS));
  const value = errors.need("value", decimal(form, "value"), "number");
  if (errors.any || !project || !hazard || value === null) return errors.state;
  const units = of<UnitSystem>(text(form, "units"), UNIT_SYSTEMS) ?? "imperial";
  return finish(
    await recordWeatherReading(
      ctx.viewer.db,
      project,
      hazard,
      storedHazardValue(hazard, value, units),
    ),
    ctx,
    "site-ops",
  );
}

export async function checkInGuestAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const plusOnes = integer(form, "plusOnes", 0, 50);
  if (id === null) return { error: "notFound" };
  if (plusOnes === undefined) return { fieldErrors: { plusOnes: "wholeNumber" } };
  return finish(
    await checkInGuest(ctx.viewer.db, id, {
      plusOnesAdmitted: plusOnes ?? 0,
      door: text(form, "door"),
      credentialNumber: text(form, "credential"),
    }),
    ctx,
    "site-ops",
  );
}

export async function logItemAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const project = errors.need("projectId", uuid(form, "projectId"));
  const category = errors.need(
    "category",
    of<LostItemCategory>(text(form, "category"), LOST_ITEM_CATEGORIES),
  );
  const description = errors.need("description", requiredText(form, "description", 1000));
  const found = errors.need("foundLocation", requiredText(form, "foundLocation", 200));
  if (errors.any || !project || !category || !description || !found) return errors.state;
  return finish(
    await logLostItem(ctx.viewer.db, {
      projectId: project,
      category,
      description,
      foundLocation: found,
      storageLocation: text(form, "storageLocation"),
    }),
    ctx,
    "site-ops",
  );
}

export async function claimItemAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  const errors = new FieldErrors();
  const name = errors.need("claimantName", requiredText(form, "claimantName", 200));
  const contact = errors.need("claimantContact", requiredText(form, "claimantContact", 200));
  const proof = errors.need("proof", requiredText(form, "proof", 1000));
  if (errors.any || !name || !contact || !proof) return errors.state;
  return finish(
    await claimLostItem(ctx.viewer.db, id, { claimantName: name, claimantContact: contact, proof }),
    ctx,
    "site-ops",
  );
}

export async function settleClaimAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  const returned = form.get("returned") === "true";
  const note = text(form, "reason");
  if (!returned && note === null) return { fieldErrors: { reason: "required" } };
  return finish(await settleLostItemClaim(ctx.viewer.db, id, returned, note), ctx, "site-ops");
}

export async function disposeItemAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const reason = reasonOf(form);
  if (id === null) return { error: "notFound" };
  if (reason === null) return { fieldErrors: { reason: "required" } };
  return finish(await disposeLostItem(ctx.viewer.db, id, reason), ctx, "site-ops");
}

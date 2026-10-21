/**
 * Workforce handlers (A29, Section 4.9). Every read and write runs as the caller, so row level
 * security and the 0800 to 0807 guards decide every row. Tables read and write through the table
 * handlers; the writes the database routes through RPCs (chat, the feed, surveys, events, forms,
 * training, the help desk and site operations) call those RPCs and answer with the row they wrote.
 * Refusals return 422 with the rule the database named.
 */
import { notFound } from "../problem.ts";
import type { RequestContext } from "../runtime/context.ts";
import { requireOrg, requirePerson } from "../runtime/context.ts";
import { created, defineHandlers, noContent, ok } from "../runtime/handler.ts";
import { from, handlersFor, rpc, run, tableResource } from "./support/table.ts";
import type { Query, Row, TableResource } from "./support/table.ts";

type Body = Record<string, unknown>;

const page = <T>(data: readonly T[]) => ({ data, next_cursor: null });

/** Drops undefined members so optional RPC arguments fall back to their database defaults. */
const args = (values: Body): Row =>
  Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));

/** Calls an RPC as the caller and returns its value; database errors map to problems. */
async function call<T = unknown>(context: RequestContext, name: string, values: Body): Promise<T> {
  return run<T>(rpc(context.db, name, args(values)));
}

/** The caller's active membership in the credential's organization. */
async function myMembership(context: RequestContext): Promise<string> {
  const org = requireOrg(context);
  const person = requirePerson(context);
  const rows = await run<Row[] | null>(
    from(context.db, "memberships")
      .select("id")
      .eq("org_id", org.id)
      .eq("person_id", person)
      .is("deleted_at", null),
  );
  const first = rows?.[0];
  if (first === undefined) throw notFound("You hold no active membership in this organization.");
  return String(first["id"]);
}

/** Reads the row an RPC wrote. */
const back = (resource: TableResource, context: RequestContext, id: unknown) =>
  resource.read(context, String(id));

const audience = (body: Body) => ({
  p_audience_kind: body["audience_kind"],
  p_project_id: body["project_id"] ?? undefined,
  p_team_id: body["team_id"] ?? undefined,
  p_role_id: body["role_id"] ?? undefined,
  p_group_id: body["group_id"] ?? undefined,
});

// Resources -----------------------------------------------------------------------------------------

const groups = tableResource("workforceGroups");
const groupMembers = tableResource("workforceGroupMembers");
const conversations = tableResource("conversations");
const chatMessages = tableResource("chatMessages", { verbs: ["list", "get"] });
const feedPosts = tableResource("feedPosts", { verbs: ["list", "get"] });
const polls = tableResource("polls");
const surveys = tableResource("surveys");
const surveyQuestions = tableResource("surveyQuestions");
const recognitions = tableResource("recognitions", { verbs: ["list", "get"] });
const workforceEvents = tableResource("workforceEvents", {
  verbs: ["list", "get", "update"],
});
const eventRsvps = tableResource("eventRsvps");
const eventCheckIns = tableResource("eventCheckIns");
const formTemplates = tableResource("formTemplates");
const formSubmissions = tableResource("formSubmissions", { verbs: ["list", "get"] });
const trainingCourses = tableResource("trainingCourses");
const trainingLessons = tableResource("trainingLessons");
const trainingQuizQuestions = tableResource("trainingQuizQuestions");
const trainingQuizKeys = tableResource("trainingQuizKeys");
const trainingAssignments = tableResource("trainingAssignments");
const trainingCompletions = tableResource("trainingCompletions");
const handbookSections = tableResource("handbookSections");
const handbookArticles = tableResource("handbookArticles");
const helpDeskTeams = tableResource("helpDeskTeams");
const helpDeskTeamMembers = tableResource("helpDeskTeamMembers");
const helpDeskRequests = tableResource("helpDeskRequests", {
  verbs: ["list", "get"],
  scope: (q) =>
    (
      q.eq("queue", "Organization") as unknown as { not(c: string, op: string, v: null): Query }
    ).not("help_desk_team_id", "is", null),
});
const occupancyCounters = tableResource("occupancyCounters");
const weatherThresholds = tableResource("weatherThresholds");
const weatherAlertRoles = tableResource("weatherAlertRoles");
const weatherReadings = tableResource("weatherReadings", { verbs: ["list", "get"] });
const weatherAlerts = tableResource("weatherAlerts");
const guestCheckIns = tableResource("guestCheckIns", { verbs: ["list", "get"] });
const lostFoundItems = tableResource("lostFoundItems", { verbs: ["list", "get", "update"] });
const lostFoundClaims = tableResource("lostFoundClaims");

export const handlers = defineHandlers("Workforce", {
  ...handlersFor("Workforce", groups),
  ...handlersFor("Workforce", groupMembers),
  ...handlersFor("Workforce", conversations),
  ...handlersFor("Workforce", chatMessages),
  ...handlersFor("Workforce", feedPosts),
  ...handlersFor("Workforce", polls),
  ...handlersFor("Workforce", surveys),
  ...handlersFor("Workforce", surveyQuestions),
  ...handlersFor("Workforce", recognitions),
  ...handlersFor("Workforce", workforceEvents),
  ...handlersFor("Workforce", eventRsvps),
  ...handlersFor("Workforce", eventCheckIns),
  ...handlersFor("Workforce", formTemplates),
  ...handlersFor("Workforce", formSubmissions),
  ...handlersFor("Workforce", trainingCourses),
  ...handlersFor("Workforce", trainingLessons),
  ...handlersFor("Workforce", trainingQuizQuestions),
  ...handlersFor("Workforce", trainingQuizKeys),
  ...handlersFor("Workforce", trainingAssignments),
  ...handlersFor("Workforce", trainingCompletions),
  ...handlersFor("Workforce", handbookSections),
  ...handlersFor("Workforce", handbookArticles),
  ...handlersFor("Workforce", helpDeskTeams),
  ...handlersFor("Workforce", helpDeskTeamMembers),
  ...handlersFor("Workforce", helpDeskRequests),
  ...handlersFor("Workforce", occupancyCounters),
  ...handlersFor("Workforce", weatherThresholds),
  ...handlersFor("Workforce", weatherAlertRoles),
  ...handlersFor("Workforce", weatherReadings),
  ...handlersFor("Workforce", weatherAlerts),
  ...handlersFor("Workforce", guestCheckIns),
  ...handlersFor("Workforce", lostFoundItems),
  ...handlersFor("Workforce", lostFoundClaims),

  // Groups and chat ----------------------------------------------------------------------------------
  "workforceGroups.archive": async ({ params }, context) => {
    await groups.read(context, params.id);
    await run(
      from(context.db, "groups")
        .update({ archived_at: new Date().toISOString() })
        .eq("id", params.id),
    );
    return ok((await groups.read(context, params.id)) as never);
  },
  "conversations.startDirect": async ({ body }, context) => {
    const id = await call(context, "start_direct_conversation", {
      p_org_id: requireOrg(context).id,
      p_other_membership_id: body.other_membership_id,
    });
    return ok((await back(conversations, context, id)) as never);
  },
  "conversations.markRead": async ({ params, body }, context) => {
    await call(context, "mark_conversation_read", {
      p_conversation_id: params.id,
      p_muted: body?.muted,
    });
    return ok((await conversations.read(context, params.id)) as never);
  },
  "conversations.readReceipts": async ({ params }, context) =>
    ok(
      page(
        await call<Row[]>(context, "conversation_read_receipts", { p_conversation_id: params.id }),
      ) as never,
    ),
  "chatMessages.create": async ({ body }, context) => {
    const id = await call(context, "send_chat_message", {
      p_conversation_id: body.conversation_id,
      p_body: body.body ?? null,
      p_message_kind: body.message_kind,
      p_language: body.language ?? undefined,
    });
    return created((await back(chatMessages, context, id)) as never);
  },
  "chatMessages.update": async ({ params, body }, context) => {
    await chatMessages.read(context, params.id);
    await call(context, "edit_chat_message", { p_message_id: params.id, p_body: body.body ?? "" });
    return ok((await chatMessages.read(context, params.id)) as never);
  },
  "chatMessages.delete": async ({ params }, context) => {
    await chatMessages.read(context, params.id);
    await call(context, "delete_chat_message", { p_message_id: params.id });
    return noContent();
  },
  "directoryEntries.search": async ({ query }, context) =>
    ok(
      page(
        await call<Row[]>(context, "workforce_directory", {
          p_org_id: requireOrg(context).id,
          p_search: query.q,
          p_on_site_only: query.on_site === undefined ? undefined : query.on_site === "true",
        }),
      ) as never,
    ),

  // Feed, polls, surveys, recognition ------------------------------------------------------------------
  "feedPosts.create": async ({ body }, context) => {
    const id = await call(context, "create_feed_post", {
      p_org_id: requireOrg(context).id,
      p_post_kind: body.post_kind,
      p_body: body.body,
      p_title: body.title ?? undefined,
      ...audience(body as Body),
      p_department_code: (body as Body)["department_code"] ?? undefined,
      p_requires_acknowledgment: body.requires_acknowledgment,
      p_reactions_enabled: body.reactions_enabled,
      p_comments_enabled: body.comments_enabled,
      p_publish_at: body.publish_at,
    });
    return created((await back(feedPosts, context, id)) as never);
  },
  "feedPosts.createPoll": async ({ body }, context) => {
    const id = await call(context, "create_feed_post", {
      p_org_id: requireOrg(context).id,
      p_post_kind: "Poll",
      p_body: body.body,
      p_title: body.title,
      ...audience(body as Body),
      p_department_code: (body as Body)["department_code"] ?? undefined,
      p_poll: args({
        question: body.question,
        options: body.options,
        allows_multiple: body.allows_multiple ?? false,
        closes_at: body.closes_at,
      }),
    });
    return created((await back(feedPosts, context, id)) as never);
  },
  "feedPosts.update": async ({ params, body }, context) => {
    await feedPosts.read(context, params.id);
    await call(context, "update_feed_post", {
      p_post_id: params.id,
      p_reactions_enabled: body.reactions_enabled,
      p_comments_enabled: body.comments_enabled,
      p_publish_at: body.publish_at,
    });
    return ok((await feedPosts.read(context, params.id)) as never);
  },
  "feedPosts.pin": async ({ params, body }, context) => {
    await call(context, "update_feed_post", { p_post_id: params.id, p_pinned: body.pinned });
    return ok((await feedPosts.read(context, params.id)) as never);
  },
  "feedPosts.hide": async ({ params, body }, context) => {
    await call(context, "hide_feed_post", { p_post_id: params.id, p_reason: body.reason });
    return ok((await feedPosts.read(context, params.id)) as never);
  },
  "feedPosts.acknowledge": async ({ params }, context) => {
    await call(context, "acknowledge_feed_post", { p_post_id: params.id });
    return ok((await feedPosts.read(context, params.id)) as never);
  },
  "feedPosts.react": async ({ params, body }, context) => {
    await call(context, "react_to_feed_post", {
      p_post_id: params.id,
      p_reaction_code: body.reaction_code,
      p_on: body.on ?? true,
    });
    return ok((await feedPosts.read(context, params.id)) as never);
  },
  "feedPosts.acknowledgments": async ({ params }, context) =>
    ok(
      page(
        await call<Row[]>(context, "feed_acknowledgment_status", { p_post_id: params.id }),
      ) as never,
    ),
  "polls.vote": async ({ params, body }, context) => {
    await call(context, "vote_in_poll", { p_poll_id: params.id, p_option_ids: body.option_ids });
    return ok((await polls.read(context, params.id)) as never);
  },
  "polls.results": async ({ params }, context) =>
    ok(page(await call<Row[]>(context, "poll_results", { p_poll_id: params.id })) as never),
  "surveys.draft": async ({ body }, context) => {
    const id = await call(context, "create_survey", {
      p_org_id: requireOrg(context).id,
      p_title: body.title,
      p_questions: body.questions,
      p_description: body.description,
      ...audience(body as Body),
      p_is_anonymous: body.is_anonymous,
      p_min_responses: body.min_responses,
      p_closes_at: body.closes_at,
    });
    return created((await back(surveys, context, id)) as never);
  },
  "surveys.transition": async ({ params, body }, context) =>
    ok({
      ledger_id: await call<string>(context, "transition_survey", {
        p_survey_id: params.id,
        p_expected: body.expected_state,
        p_next: body.to_state,
        p_reason: body.reason,
      }),
    } as never),
  "surveys.respond": async ({ params, body }, context) =>
    ok({
      response_id:
        (await call<string | null>(context, "respond_to_survey", {
          p_survey_id: params.id,
          p_answers: body.answers,
        })) ?? null,
    } as never),
  "surveys.results": async ({ params }, context) =>
    ok((await call<Row>(context, "survey_results", { p_survey_id: params.id })) as never),
  "recognitions.create": async ({ body }, context) => {
    const id = await call(context, "recognize", {
      p_org_id: requireOrg(context).id,
      p_to_membership_id: body.to_membership_id,
      p_message: body.message,
      p_project_id: body.project_id ?? undefined,
      p_shift_id: body.shift_id ?? undefined,
    });
    return created((await back(recognitions, context, id)) as never);
  },

  // Events ---------------------------------------------------------------------------------------------
  "workforceEvents.create": async ({ body }, context) => {
    const inserted = await run<Row>(
      from(context.db, "workforce_events")
        .insert({
          org_id: requireOrg(context).id,
          organizer_membership_id: await myMembership(context),
          event_kind: body.event_kind,
          title: body.title,
          agenda: body.agenda ?? null,
          location: body.location ?? null,
          venue_id: body.venue_id ?? null,
          space_id: body.space_id ?? null,
          audience_kind: body.audience_kind,
          project_id: body.project_id ?? null,
          team_id: body.team_id ?? null,
          role_id: body.role_id ?? null,
          group_id: body.group_id ?? null,
          starts_at: body.starts_at,
          ends_at: body.ends_at,
          rsvp_required: body.rsvp_required,
        })
        .select("id")
        .single(),
    );
    return created((await back(workforceEvents, context, inserted["id"])) as never);
  },
  "workforceEvents.cancel": async ({ params, body }, context) => {
    await workforceEvents.read(context, params.id);
    await run(
      from(context.db, "workforce_events")
        .update({ canceled_at: new Date().toISOString(), cancel_reason: body.reason })
        .eq("id", params.id),
    );
    return ok((await workforceEvents.read(context, params.id)) as never);
  },
  "workforceEvents.rsvp": async ({ params, body }, context) => {
    const id = await call(context, "rsvp_to_event", {
      p_event_id: params.id,
      p_response: body.response,
    });
    return ok((await back(eventRsvps, context, id)) as never);
  },
  "workforceEvents.checkIn": async ({ params, body }, context) => {
    const id = await call(context, "check_in_to_event", {
      p_event_id: params.id,
      p_membership_id: body?.membership_id,
      p_method: body?.method,
    });
    return ok((await back(eventCheckIns, context, id)) as never);
  },

  // Forms ------------------------------------------------------------------------------------------------
  "formTemplates.publish": async ({ params }, context) => {
    await call(context, "publish_form_template", { p_template_id: params.id });
    return ok((await formTemplates.read(context, params.id)) as never);
  },
  "formTemplates.retire": async ({ params, body }, context) => {
    await call(context, "retire_form_template", {
      p_template_id: params.id,
      p_reason: body.reason,
    });
    return ok((await formTemplates.read(context, params.id)) as never);
  },
  "formSubmissions.create": async ({ body }, context) => {
    const id = await call(context, "submit_form", {
      p_template_id: body.form_template_id,
      p_answers: body.answers,
      p_project_id: body.project_id ?? undefined,
      p_location:
        body.latitude === undefined || body.latitude === null
          ? undefined
          : args({
              latitude: body.latitude,
              longitude: body.longitude,
              accuracy_m: body.accuracy_m ?? undefined,
            }),
      p_signature:
        body.signer_name === undefined || body.signer_name === null
          ? undefined
          : { signer_name: body.signer_name, signature_path: body.signature_path },
    });
    return created((await back(formSubmissions, context, id)) as never);
  },
  "formSubmissions.decide": async ({ params, body }, context) => {
    await call(context, "decide_form_submission", {
      p_submission_id: params.id,
      p_approve: body.approve,
      p_note: body.note,
    });
    return ok((await formSubmissions.read(context, params.id)) as never);
  },

  // Training and handbook -----------------------------------------------------------------------------------
  "trainingCourses.publish": async ({ params }, context) => {
    await call(context, "publish_training_course", { p_course_id: params.id });
    return ok((await trainingCourses.read(context, params.id)) as never);
  },
  "trainingCourses.retire": async ({ params, body }, context) => {
    await call(context, "retire_training_course", {
      p_course_id: params.id,
      p_reason: body.reason,
    });
    return ok((await trainingCourses.read(context, params.id)) as never);
  },
  "trainingCourses.assign": async ({ params, body }, context) =>
    ok({
      assigned: await call<number>(context, "assign_training", {
        p_course_id: params.id,
        p_membership_ids: body.membership_ids,
        p_due_on: body.due_on,
        p_reason: body.reason,
      }),
    } as never),
  "trainingCourses.complete": async ({ params, body }, context) => {
    const id = await call(context, "complete_training", {
      p_course_id: params.id,
      p_answers: body.answers,
    });
    return ok((await back(trainingCompletions, context, id)) as never);
  },
  "trainingLessons.complete": async ({ params }, context) => {
    await call(context, "complete_training_lesson", { p_lesson_id: params.id });
    return ok((await trainingLessons.read(context, params.id)) as never);
  },
  "trainingCompletions.issueCertification": async ({ params }, context) => {
    await call(context, "issue_training_certification", { p_completion_id: params.id });
    return ok((await trainingCompletions.read(context, params.id)) as never);
  },
  "handbookArticles.publish": async ({ params, body }, context) => {
    await call(context, "publish_handbook_article", {
      p_article_id: params.id,
      p_change_summary: body?.change_summary,
    });
    return ok((await handbookArticles.read(context, params.id)) as never);
  },
  "handbookArticles.acknowledge": async ({ params }, context) => {
    await call(context, "acknowledge_handbook_article", { p_article_id: params.id });
    return ok((await handbookArticles.read(context, params.id)) as never);
  },
  "handbookArticles.archive": async ({ params }, context) => {
    await handbookArticles.read(context, params.id);
    await run(
      from(context.db, "handbook_articles")
        .update({ article_state: "Archived" })
        .eq("id", params.id),
    );
    return ok((await handbookArticles.read(context, params.id)) as never);
  },
  "knowledgeSources.search": async ({ query }, context) =>
    ok(
      page(
        await call<Row[]>(context, "assistant_knowledge_sources", {
          p_org_id: requireOrg(context).id,
          p_query: query.q,
          p_limit: query.limit,
        }),
      ) as never,
    ),

  // Help desk -------------------------------------------------------------------------------------------------
  "helpDeskTeams.archive": async ({ params }, context) => {
    await helpDeskTeams.read(context, params.id);
    await run(
      from(context.db, "help_desk_teams")
        .update({ archived_at: new Date().toISOString() })
        .eq("id", params.id),
    );
    return ok((await helpDeskTeams.read(context, params.id)) as never);
  },
  "helpDeskRequests.create": async ({ body }, context) => {
    const id = await call(context, "open_help_desk_request", {
      p_org_id: requireOrg(context).id,
      p_help_desk_team_id: body.help_desk_team_id,
      p_category: body.category,
      p_subject: body.subject,
      p_body: body.body,
      p_severity: body.severity,
    });
    return created((await back(helpDeskRequests, context, id)) as never);
  },
  "helpDeskRequests.assign": async ({ params, body }, context) => {
    await call(context, "assign_help_desk_request", {
      p_ticket_id: params.id,
      p_assignee_membership_id: body.assignee_membership_id,
      p_help_desk_team_id: body.help_desk_team_id,
    });
    return ok((await helpDeskRequests.read(context, params.id)) as never);
  },
  "helpDeskRequests.answer": async ({ params, body }, context) =>
    created({
      message_id: await call<string>(context, "answer_help_desk_request", {
        p_ticket_id: params.id,
        p_body: body.body,
      }),
    } as never),
  "helpDeskRequests.transition": async ({ params, body }, context) =>
    ok({
      ledger_id: await call<string>(context, "transition_help_desk_request", {
        p_ticket_id: params.id,
        p_expected: body.expected_state,
        p_next: body.to_state,
        p_reason: body.reason,
      }),
    } as never),

  // Site operations ----------------------------------------------------------------------------------------------
  "occupancyCounters.setUp": async ({ body }, context) => {
    const id = await call(context, "create_occupancy_counter", {
      p_project_id: body.project_id,
      p_name: body.name,
      p_space_id: body.space_id,
      p_metric_item: body.metric_item,
      p_permitted_load: body.permitted_load,
    });
    return created((await back(occupancyCounters, context, id)) as never);
  },
  "occupancyCounters.count": async ({ params, body }, context) => {
    await call(context, "record_occupancy_count", {
      p_counter_id: params.id,
      p_delta: body.delta,
      p_door: body.door,
    });
    return ok((await occupancyCounters.read(context, params.id)) as never);
  },
  "occupancyCounters.close": async ({ params }, context) => {
    await call(context, "close_occupancy_counter", { p_counter_id: params.id });
    return ok((await occupancyCounters.read(context, params.id)) as never);
  },
  "weatherReadings.create": async ({ body }, context) => {
    const id = await call(context, "record_weather_reading", {
      p_project_id: body.project_id,
      p_hazard: body.hazard,
      p_value: body.reading_value,
      p_observed_at: body.observed_at,
    });
    return created((await back(weatherReadings, context, id)) as never);
  },
  "guestCheckIns.create": async ({ body }, context) => {
    const id = await call(context, "check_in_guest", {
      p_guest_list_entry_id: body.guest_list_entry_id,
      p_plus_ones_admitted: body.plus_ones_admitted,
      p_door: body.door ?? undefined,
    });
    return created((await back(guestCheckIns, context, id)) as never);
  },
  "guestCheckIns.doorList": async ({ query }, context) =>
    ok(
      page(
        await call<Row[]>(context, "door_guest_list", {
          p_project_id: query.project_id,
          p_search: query.q,
        }),
      ) as never,
    ),
  "lostFoundItems.create": async ({ body }, context) => {
    const id = await call(context, "log_lost_item", {
      p_project_id: body.project_id,
      p_category: body.category,
      p_description: body.description,
      p_found_location: body.found_location,
      p_storage_location: body.storage_location ?? undefined,
      p_found_at: body.found_at,
    });
    return created((await back(lostFoundItems, context, id)) as never);
  },
  "lostFoundItems.claim": async ({ params, body }, context) => {
    const id = await call(context, "claim_lost_item", {
      p_item_id: params.id,
      p_claimant_name: body.claimant_name,
      p_claimant_contact: body.claimant_contact,
      p_proof_description: body.proof_description,
    });
    return created((await back(lostFoundClaims, context, id)) as never);
  },
  "lostFoundItems.dispose": async ({ params, body }, context) => {
    await call(context, "dispose_lost_item", { p_item_id: params.id, p_reason: body.reason });
    return ok((await lostFoundItems.read(context, params.id)) as never);
  },
  "lostFoundClaims.settle": async ({ params, body }, context) => {
    await call(context, "settle_lost_item_claim", {
      p_claim_id: params.id,
      p_returned: body.returned,
      p_note: body.note,
    });
    return ok((await lostFoundClaims.read(context, params.id)) as never);
  },
});

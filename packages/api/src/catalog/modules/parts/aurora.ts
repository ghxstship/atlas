/**
 * Aurora AI operations (A25, RRR-39; Section 4.7, ADR 0020), spread into the Settings module file.
 * Migration 0650 holds the tables: app.ai_settings, app.ai_requests, app.ai_usage,
 * app.ai_suggestions and app.ai_suggestion_fields.
 *
 * - `aurora.*` runs one feature for the caller: authorized and metered by app.ai_begin_request
 *   (membership, aurora_ai in the plan, the Admin switch, the monthly allowance), logged redacted,
 *   and answered with `ai_generated: true` for the EU AI Act label.
 * - `aiSuggestions.*` is the confirmation step: nothing a feature proposes is written until the
 *   person who asked confirms; the write itself is the named public operation, called with their
 *   own credential, and `apply` records the record it wrote.
 * - `aiRequests` and `aiUsage` are the redacted log and the metering ledger.
 */
import { z } from "@hono/zod-openapi";
import { defineResource, fields } from "@xos/schemas";
import type { CapabilityRule } from "../../capabilities.ts";
import type { CorrectionInput } from "../../corrections.ts";
import { editDefinition, editShape, orNull } from "../../correct.ts";
import { collectionAction, collectionQuery, itemAction, resource } from "../../define.ts";
import type { ActionSpec, ResourceSpec } from "../../types.ts";

const SINCE = "1.0.0-draft.2";

const AUDIT_NULLABLE = { nullable: ["created_by", "updated_by"] } as const;

export const AI_FEATURES = [
  "assistant",
  "plain_language",
  "extraction",
  "drafting",
  "summaries",
  "mapping",
] as const;

const Feature = z.enum(AI_FEATURES).meta({
  id: "AiFeature",
  description: "An Aurora AI feature (Section 4.7).",
  example: "assistant",
});

const SuggestionState = z.enum(["Proposed", "Confirmed", "Applied", "Rejected", "Expired"]).meta({
  id: "AiSuggestionState",
  description:
    "Proposed and waiting for the person who asked, Confirmed by them, Applied once the public API accepted the write, Rejected, or Expired unanswered.",
  example: "Proposed",
});

const RequestOutcome = z.enum(["Pending", "Answered", "No Answer", "Failed"]).meta({
  id: "AiRequestOutcome",
  description: "How a model call ended. No Answer is the silence rule (Section 3.7).",
  example: "Answered",
});

const SuggestionField = z
  .object({
    field_path: z
      .string()
      .meta({ description: "API field the value is for.", example: "expires_on" }),
    proposed_value: z.unknown().meta({
      description: "Proposed value as JSON; null when the field is NO_ANSWER.",
      example: "2027-03-31",
    }),
    confidence: z.number().min(0).max(1).nullable().meta({
      description: "Confidence from 0 to 1; null when the field is NO_ANSWER.",
      example: 0.91,
    }),
    refusal: z.enum(["NO_ANSWER"]).nullable().meta({
      description: "NO_ANSWER when the source does not support a value.",
      example: null,
    }),
    missing: z.string().nullable().meta({
      description: "What the source lacks, when the field is NO_ANSWER.",
      example: null,
    }),
    source_excerpt: z.string().nullable().meta({
      description: "The passage the value was read from, redacted.",
      example: "Policy expiration 03/31/2027",
    }),
    provenance: z.literal("agent").meta({
      description: "Every AI-proposed value carries provenance agent (rank 40, Section 3.8).",
      example: "agent",
    }),
  })
  .meta({ id: "AiSuggestionField", description: "One proposed field of an AI suggestion." });

/** Audit people are nullable: platform and seed rows carry none (ADR 0023). */
export const AiSuggestion = editDefinition(
  defineResource({
    name: "AiSuggestion",
    table: "app.ai_suggestions",
    description:
      "A change an Aurora feature proposes, waiting for the confirmation of the person who asked. The summary says exactly what will change; nothing is written until they confirm.",
    fields: {
      request_id: fields.ref("AI request that proposed the change"),
      operation_id: fields.text(
        "Public API operation that performs the change.",
        "insuranceCertificates.create",
        100,
      ),
      target_id: orNull(fields.ref("record the change updates; null when it creates one")),
      summary: fields.text(
        "What will change, shown on the confirmation step.",
        "Add the Atlantic Mutual general liability certificate.",
        1000,
      ),
      suggestion_state: SuggestionState,
      expires_at: fields.instant("After this time the suggestion can no longer be confirmed."),
      applied_id: orNull(fields.ref("record the public API wrote, once Applied")),
      proposed_fields: z.array(SuggestionField).meta({
        description: "Proposed fields in confirmation order.",
        example: [
          {
            field_path: "expires_on",
            proposed_value: "2027-03-31",
            confidence: 0.91,
            refusal: null,
            missing: null,
            source_excerpt: "Policy expiration 03/31/2027",
            provenance: "agent",
          },
        ],
      }),
    },
    serverSet: [
      "request_id",
      "operation_id",
      "target_id",
      "summary",
      "suggestion_state",
      "expires_at",
      "applied_id",
      "proposed_fields",
    ],
  }),
  AUDIT_NULLABLE,
);

/** Audit people are nullable: platform and seed rows carry none (ADR 0023). */
export const AiRequest = editDefinition(
  defineResource({
    name: "AiRequest",
    table: "app.ai_requests",
    description:
      "One Aurora model call: who asked, for which feature, with which configured model, and the prompt and output with personal data redacted. Restricted fields and medical records are never in it.",
    fields: {
      person_id: fields.ref("person who asked"),
      feature: Feature,
      model: fields.text("Model identifier from configuration.", "claude-sonnet-5-5", 100),
      subject_table: orNull(
        fields.text("Table of the record the request was about.", "app.documents", 100),
      ),
      subject_id: orNull(fields.ref("record the request was about")),
      outcome: RequestOutcome,
      prompt_redacted: orNull(
        fields.longText("Prompt as sent, redacted.", "Who is the vendor contact?"),
      ),
      output_redacted: orNull(fields.longText("Model output, redacted.", "Ivy Chen, [phone].")),
      failure_code: orNull(fields.text("Why a Failed request failed.", "model_error", 64)),
      completed_at: orNull(fields.instant("When the request finished.")),
    },
    serverSet: [
      "person_id",
      "feature",
      "model",
      "subject_table",
      "subject_id",
      "outcome",
      "prompt_redacted",
      "output_redacted",
      "failure_code",
      "completed_at",
    ],
  }),
  AUDIT_NULLABLE,
);

/** Audit people are nullable: platform and seed rows carry none (ADR 0023). */
export const AiUsage = editDefinition(
  defineResource({
    name: "AiUsage",
    table: "app.ai_usage",
    description:
      "Aurora metering (ADR 0020): one row per authorized request. The monthly allowance aurora_requests_per_month counts these rows by UTC month.",
    fields: {
      request_id: fields.ref("AI request metered"),
      metered_at: fields.instant("When the request was authorized and counted."),
      input_tokens: orNull(fields.int("Input tokens the model reported.", 812)),
      output_tokens: orNull(fields.int("Output tokens the model reported.", 96)),
    },
    serverSet: ["request_id", "metered_at", "input_tokens", "output_tokens"],
  }),
  AUDIT_NULLABLE,
);

const AuroraStatus = defineResource({
  name: "AuroraStatus",
  base: "view",
  table: "app.ai_settings",
  description:
    "What Aurora can do for the caller now: the features an Admin turned on that the plan includes, and this month's use of the allowance.",
  fields: {
    enabled_features: z.array(Feature).meta({
      description: "Features the caller may use now.",
      example: ["assistant", "extraction"],
    }),
    used: fields.int("Requests the org made this UTC month.", 12),
    allowance: orNull(fields.int("Monthly allowance; null when the plan sets no limit.", 500)),
    plan_includes_aurora: fields.bool("Whether the plan includes Aurora AI.", true),
  },
});

const Proposal = z
  .object({
    suggestion_id: fields.ref("stored suggestion"),
    operation_id: fields.text(
      "Public API operation the change would call.",
      "savedViews.create",
      100,
    ),
    summary: fields.text("What will change.", "Save the view Blocked Miami Permits.", 1000),
  })
  .meta({ id: "AuroraProposal", description: "A change waiting for confirmation." });

const AuroraResult = z
  .object({
    outcome: z.enum(["answer", "no_answer", "failed"]).meta({
      description:
        "answer, no_answer (the data does not support an answer; `missing` says why) or failed (the model call failed and was logged).",
      example: "answer",
    }),
    ai_generated: z.literal(true).meta({
      description:
        "Always true: the content is AI-generated and is labeled so (EU AI Act Article 50).",
      example: true,
    }),
    request_id: orNull(fields.ref("logged AI request; null when no model was called")),
    model: orNull(fields.text("Model that answered.", "claude-sonnet-5-5", 100)),
    missing: orNull(
      fields.text("What the data lacks, for no_answer.", "No budget lines exist yet.", 500),
    ),
    failure_code: orNull(fields.text("Why the request failed.", "model_error", 64)),
    answer: z.unknown().meta({
      description: "The feature's answer for outcome answer, shaped per operation; null otherwise.",
      example: { text: "One permit is blocked: Fire Marshal Permit.", citations: [] },
    }),
    suggestions: z.array(Proposal).meta({
      description: "Changes stored for confirmation.",
      example: [
        {
          suggestion_id: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f",
          operation_id: "savedViews.create",
          summary: "Save the view Blocked Miami Permits.",
        },
      ],
    }),
  })
  .meta({ id: "AuroraResult", description: "The result of one Aurora request." });

const text = (description: string, example: string, max = 4000) =>
  z.string().min(1).max(max).meta({ description, example });

const AskBody = z
  .object({
    question: text("The question.", "Which permits are blocked?"),
    history: z
      .array(z.object({ question: z.string().max(4000), answer: z.string().max(8000) }))
      .max(10)
      .default([])
      .meta({
        description: "Earlier turns of this conversation, oldest first.",
        example: [{ question: "Which permits are blocked?", answer: "One: Fire Marshal Permit." }],
      }),
  })
  .meta({ id: "AuroraAskRequest", description: "A question for the assistant." });

const FilterBody = z
  .object({
    sentence: text(
      "The sentence to turn into a filter.",
      "blocked permits for Miami shows this month",
      500,
    ),
    collections: z
      .array(z.string().regex(/^[a-z][a-z0-9-]*$/))
      .min(1)
      .max(20)
      .meta({ description: "Collections the filter may target.", example: ["permits"] }),
    time_zone: fields.timeZone().meta({
      description:
        "Time zone the caller works in. Relative dates such as this month or overdue resolve on the org's calendar (its locale.time_zone setting), never on UTC.",
      example: "America/New_York",
    }),
    fields: z
      .array(
        z.object({
          name: z
            .string()
            .regex(/^[a-z][a-z0-9_.]*$/)
            .max(64)
            .meta({
              description: "Filter name as the page's query string writes it.",
              example: "overdue",
            }),
          type: z
            .enum(["string", "number", "date", "boolean", "enum"])
            .meta({ description: "Value type.", example: "boolean" }),
          values: z
            .array(z.string().min(1).max(200))
            .max(200)
            .optional()
            .meta({
              description: "The values an enum filter takes.",
              example: ["Issued", "Approved"],
            }),
          description: z.string().min(1).max(300).optional().meta({
            description: "What the filter means, in a sentence.",
            example: "Unpaid invoices past their due date on the org's calendar.",
          }),
          ops: z
            .array(z.enum(["eq", "ne", "lt", "lte", "gt", "gte", "in", "is_null", "contains"]))
            .min(1)
            .optional()
            .meta({ description: "The only operators the filter takes.", example: ["eq"] }),
        }),
      )
      .min(1)
      .max(40)
      .optional()
      .meta({
        description:
          "A page's own filters, offered instead of the API fields of the first collection: names, types, values and operators only, never record data. Restricted columns are never offered.",
        example: [{ name: "overdue", type: "boolean", ops: ["eq"] }],
      }),
  })
  .meta({ id: "AuroraFilterRequest", description: "A sentence to turn into a saved view." });

/** Media types a document may be sent in. */
const MediaType = z
  .enum(["application/pdf", "text/plain", "image/png", "image/jpeg", "image/webp"])
  .meta({ description: "Media type of the content.", example: "application/pdf" });

const ExtractBody = z
  .object({
    kind: z
      .enum([
        "rider",
        "insurance_certificate",
        "invoice",
        "receipt",
        "quote",
        "itinerary",
        "contract",
        "intake_rider",
        "invoice_lines",
      ])
      .meta({ description: "What the document is.", example: "insurance_certificate" }),
    document_id: orNull(fields.ref("stored document read, when the file is one")).optional(),
    intake_batch_id: fields
      .ref("intake batch the file is read into (aurora.startIntake); the request's subject")
      .optional(),
    invoice_id: fields
      .ref(
        "Proposed payable invoice whose lines are read, required for invoice_lines; the subject, ahead of document_id",
      )
      .optional(),
    inbound_message_id: fields
      .ref(
        "DKIM-verified project inbox message read instead of a file, for an itinerary; exactly one of this and content_base64",
      )
      .optional(),
    media_type: MediaType.optional(),
    content_base64: z.string().min(1).max(14_000_000).optional().meta({
      description:
        "The document content in base64, read by the caller from storage. Exactly one of this and inbound_message_id; with it, media_type and file_name are required.",
      example: "JVBERi0xLjcK",
    }),
    file_name: fields.text("File name shown in the log.", "coi-atlantic.pdf", 300).optional(),
  })
  .meta({ id: "AuroraExtractRequest", description: "A document to extract into proposed fields." });

/** The most lines one drafted list proposes or applies (`@xos/ai/lists` MAX_CUES, P6). */
const MAX_DRAFTED_LINES = 60;

const ListDraftKind = z.enum(["run_of_show", "risk_assessment"]);

const DraftTarget = z
  .object({
    collection: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .meta({ description: "Collection of the list's record.", example: "run-of-show" }),
    id: z.uuid().meta({
      description: "The running order or project.",
      example: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f",
    }),
  })
  .meta({
    description:
      "The list a run of show or risk assessment fills: a running order (run-of-show) or a project (projects). Advance answers name the recipient (advance-recipients); an event plan, brief, approval pack or waste plan names its project (projects). Required for those kinds.",
    example: { collection: "run-of-show", id: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f" },
  });

/** Governance drafts (B15): prose with a fixed outline, saved as a labeled project document. */
const GOVERNANCE_KINDS = ["event_plan", "event_brief", "approval_pack", "waste_plan"] as const;

const DraftSource = z
  .object({
    inbound_message_id: fields
      .ref("DKIM-verified, live message of the project inbox of the recipient's packet")
      .optional(),
    document: z
      .object({
        media_type: MediaType,
        content_base64: z.string().min(1).max(14_000_000).meta({
          description: "The document content in base64.",
          example: "JVBERi0xLjcK",
        }),
        file_name: fields.text(
          "File name shown in the log and the answer's provenance.",
          "tour-book.pdf",
          300,
        ),
      })
      .optional()
      .meta({
        description: "A document the party sent: a tour book, a rider or a reply.",
        example: {
          media_type: "text/plain",
          content_base64: "TG9hZCBpbiAwNzowMA==",
          file_name: "tour-book.txt",
        },
      }),
  })
  .meta({
    id: "AuroraDraftSource",
    description:
      "What advance answers are drafted from: exactly one of a project inbox message and a document. A message that is not a verified Project Inbox message of the packet's project the caller can read refuses aurora_draft_source_invalid before any model call.",
    example: { inbound_message_id: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f" },
  });

const DraftBody = z
  .object({
    kind: z
      .enum([
        "sop",
        "advance_packet",
        "email",
        "day_sheet",
        "change_order_description",
        ...ListDraftKind.options,
        "advance_answers",
        ...GOVERNANCE_KINDS,
      ])
      .meta({ description: "What to draft.", example: "sop" }),
    instructions: text("What the draft should say.", "Write the load-in SOP for the main stage."),
    target: DraftTarget.optional(),
    source: DraftSource.optional(),
    outline: z
      .array(z.string().min(1).max(120))
      .min(1)
      .max(12)
      .optional()
      .meta({
        description:
          "For a governance kind, its outline headings in the caller's locale, in order; the English outline when absent.",
        example: ["Waste Streams", "Bins and Placement"],
      }),
    context: z
      .array(z.object({ collection: z.string().regex(/^[a-z][a-z0-9-]*$/), id: z.uuid() }))
      .max(20)
      .default([])
      .meta({
        description: "Records to draft from, read with the caller's permissions.",
        example: [{ collection: "venues", id: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f" }],
      }),
    verbiage: z
      .array(z.object({ term: z.string().min(1).max(100), preferred: z.string().min(1).max(200) }))
      .max(200)
      .default([])
      .meta({
        description: "The org's verbiage library entries to apply.",
        example: [{ term: "loading dock", preferred: "Dock" }],
      }),
  })
  .meta({ id: "AuroraDraftRequest", description: "Instructions for a draft." });

const SummarizeBody = z
  .object({
    kind: z
      .enum(["record_activity", "project_week", "gate_readiness"])
      .meta({ description: "What to summarize.", example: "project_week" }),
    subject_collection: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .meta({
        description: "Collection of the record or project summarized.",
        example: "projects",
      }),
    subject_id: fields.ref("record or project summarized"),
    items: z
      .array(z.object({ collection: z.string().regex(/^[a-z][a-z0-9-]*$/), id: z.uuid() }))
      .max(100)
      .meta({
        description: "Activity and records to summarize, read with the caller's permissions.",
        example: [{ collection: "activity-events", id: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f" }],
      }),
  })
  .meta({ id: "AuroraSummarizeRequest", description: "What to summarize." });

const MapColumnsBody = z
  .object({
    collection: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .meta({ description: "Import target.", example: "people" }),
    columns: z
      .array(
        z.object({ header: z.string().max(200), samples: z.array(z.string().max(200)).max(5) }),
      )
      .min(1)
      .max(200)
      .meta({
        description: "Import columns with sample values.",
        example: [{ header: "E-mail", samples: ["crew@example.com"] }],
      }),
    fields: z
      .array(z.object({ name: z.string().max(100), description: z.string().max(300) }))
      .min(1)
      .max(200)
      .meta({
        description: "Target fields of the collection.",
        example: [{ name: "email", description: "Email address." }],
      }),
  })
  .meta({ id: "AuroraMapColumnsRequest", description: "Import columns to map onto fields." });

const BindCodeBody = z
  .object({
    code: fields.text("The scanned code.", "0012345678905", 100),
    description: orNull(fields.text("What the label said.", "LED PANEL 500MM", 300)),
    candidates: z
      .array(
        z.object({
          element_id: z.string().max(100),
          name: z.string().max(300),
          urid: z.string().max(20),
        }),
      )
      .min(1)
      .max(50)
      .meta({
        description: "Catalog elements found for the code.",
        example: [
          { element_id: "9000.02.03-NWL-0001", name: "LED Wall Panel", urid: "9000.02.03" },
        ],
      }),
  })
  .meta({ id: "AuroraBindCodeRequest", description: "An unknown scanned code to bind." });

const collectionRef = z.object({
  collection: z.string().regex(/^[a-z][a-z0-9-]*$/),
  id: z.uuid(),
});

const PreviewBody = z
  .object({
    feature: z
      .enum(["drafting", "summaries"])
      .meta({ description: "The feature whose request is previewed.", example: "drafting" }),
    draft_kind: z
      .enum([...ListDraftKind.options, "advance_answers", ...GOVERNANCE_KINDS])
      .optional()
      .meta({
        description:
          "For a drafted list, advance answers or a governance draft, what is drafted: the preview then reads exactly what the draft reads, the list's own records included.",
        example: "run_of_show",
      }),
    target: DraftTarget.optional(),
    source: DraftSource.optional(),
    kind: z
      .enum(["record_activity", "project_week", "gate_readiness"])
      .optional()
      .meta({ description: "For summaries, what is summarized.", example: "gate_readiness" }),
    subject_collection: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .optional()
      .meta({ description: "For summaries, the collection summarized.", example: "projects" }),
    subject_id: fields.ref("record or project summarized").optional(),
    items: z
      .array(collectionRef)
      .max(100)
      .meta({
        description:
          "The records the request names: a draft's context or a summary's items, read with the caller's permissions.",
        example: [{ collection: "sops", id: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f" }],
      }),
  })
  .meta({
    id: "AuroraPreviewRequest",
    description: "A drafting or summary request to preview before it is sent.",
  });

const PreviewRecord = z
  .object({
    collection: z
      .string()
      .meta({ description: "Collection of the record.", example: "change-orders" }),
    id: fields.ref("record"),
    sent: fields.bool(
      "False when the record cannot be read or its whole table is never sent to a model.",
      true,
    ),
    fields: z
      .array(z.string())
      .meta({ description: "Fields that would be sent.", example: ["title", "reason"] }),
    withheld: z.array(z.string()).meta({
      description: "Fields left out: Restricted columns and masked values.",
      example: ["agreed_rate_minor"],
    }),
    data: z
      .record(z.string(), z.unknown())
      .nullable()
      .meta({
        description: "The values that would be sent; null when nothing of the record is sent.",
        example: { title: "Extra rigging points", reason: null },
      }),
  })
  .meta({ id: "AuroraPreviewRecord", description: "One record as a model would see it." });

const AuroraPreview = z
  .object({
    records: z.array(PreviewRecord).meta({
      description:
        "Each record the request names, in order, with the gate readiness a gate summary adds.",
      example: [],
    }),
    vocabulary_terms: fields.int("Verbiage library terms a draft follows.", 12),
    categories: z
      .array(z.string())
      .optional()
      .meta({
        description: "For a risk assessment, the canon Risk categories the draft may use.",
        example: ["Operational", "Commercial", "Safety", "Reputational", "Schedule"],
      }),
  })
  .meta({
    id: "AuroraPreview",
    description:
      "What a drafting or summary request would send to the model, read and scrubbed exactly as the request would be. No model is called and nothing is metered.",
  });

const ApplyDraftBody = z
  .object({
    request_id: fields.ref("drafting request whose list is confirmed"),
    items: z
      .array(
        z.object({
          suggestion_id: fields.ref("suggestion holding the line"),
          values: z
            .record(z.string(), z.unknown())
            .optional()
            .meta({
              description:
                "Values the person changed, overriding the proposed ones key by key. Cues take label, planned_at, duration, segment and description; risks take record_subtype, title, risk.likelihood, risk.impact and risk.mitigation.",
              example: { label: "Doors Open" },
            }),
        }),
      )
      .min(1)
      .max(MAX_DRAFTED_LINES)
      .meta({
        description: "The kept lines in list order: at most 60 cues or 40 risks.",
        example: [{ suggestion_id: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f" }],
      }),
  })
  .meta({ id: "AuroraApplyDraftRequest", description: "The lines of a drafted list to add." });

const AppliedDraft = z
  .object({
    written: z
      .array(
        z.object({
          suggestion_id: fields.ref("suggestion applied"),
          id: fields.ref("cue or Risk record written"),
        }),
      )
      .meta({
        description: "Each kept line with the row it wrote, in list order.",
        example: [
          {
            suggestion_id: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f",
            id: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e70",
          },
        ],
      }),
    rejected: fields.int("Lines of the draft left out and rejected.", 2),
  })
  .meta({ id: "AuroraAppliedDraft", description: "What a confirmed drafted list wrote." });

// Intake batches and drafted answers (B15) ------------------------------------------------------

const IntakeKind = z.enum(["Itineraries", "Contracts and Riders"]).meta({
  id: "AuroraIntakeKind",
  description: "What an intake batch reads: Itineraries or Contracts and Riders.",
  example: "Itineraries",
});

const StartIntakeBody = z
  .object({
    project_id: fields.ref("project the files are read for"),
    kind: IntakeKind,
    file_count: z.number().int().min(1).max(25).meta({
      description:
        "Files the batch reads, 1 to 25: one metered request each, checked against this month's allowance first.",
      example: 3,
    }),
    fulfillment_id: fields
      .ref("Travel fulfillment of the project the segments are filed under, for Itineraries")
      .optional(),
  })
  .meta({ id: "AuroraStartIntakeRequest", description: "An intake batch to open." });

const IntakeSuggestion = z
  .object({
    id: fields.ref("suggestion"),
    request_id: fields.ref("request that proposed it"),
    operation_id: fields.text("Operation that applies it.", "aurora.applyItineraries", 100),
    target_id: orNull(fields.ref("record it updates")),
    summary: fields.text("What will change.", "Add segment 1: MIA to ORD.", 1000),
    suggestion_state: SuggestionState,
    expires_at: fields.instant("After this time it can no longer be applied."),
    applied_id: orNull(fields.ref("record written, once Applied")),
    proposed_fields: z.array(SuggestionField).meta({
      description:
        "Proposed fields in order; a Restricted field is left out for anyone who may not read it.",
      example: [],
    }),
  })
  .meta({ id: "AuroraIntakeSuggestion", description: "A Proposed suggestion of an intake batch." });

/** Audit people are nullable: updated_by stays null until the batch is closed. */
const AuroraIntake = editDefinition(
  defineResource({
    name: "AuroraIntake",
    table: "app.ai_intake_batches",
    description:
      "An Aurora intake batch (B15): the files it reads, its requests and its Proposed suggestions, read with the caller's permissions, so a preview reloads within the seven-day expiry.",
    fields: {
      project_id: fields.ref("project"),
      intake_kind: IntakeKind,
      fulfillment_id: orNull(fields.ref("Travel fulfillment the segments are filed under")),
      file_count: fields.int("Files the batch reads.", 3),
      closed_at: orNull(fields.instant("When the batch was applied or closed.")),
      requests: z
        .array(
          z.object({
            id: fields.ref("request"),
            outcome: RequestOutcome,
            failure_code: orNull(fields.text("Why it failed.", "model_error", 64)),
            created_at: fields.instant("When the file was read."),
          }),
        )
        .meta({ description: "One request per file read, oldest first.", example: [] }),
      suggestions: z
        .array(IntakeSuggestion)
        .meta({ description: "Proposed suggestions, oldest first.", example: [] }),
    },
    serverSet: [
      "project_id",
      "intake_kind",
      "fulfillment_id",
      "file_count",
      "closed_at",
      "requests",
      "suggestions",
    ],
  }),
  AUDIT_NULLABLE,
);

const ApplyItinerariesBody = z
  .object({
    items: z
      .array(
        z.object({
          suggestion_id: fields.ref("segment suggestion kept"),
          values: z.record(z.string(), z.unknown()).meta({
            description:
              "The person's values, overriding the proposed fields key by key: person_id (required), engagement_id, fulfillment_id, departs_at and arrives_at (instants), the zones, places, operator, service and confirmation, travel_mode, price_minor and currency_code.",
            example: {
              person_id: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f",
              departs_at: "2027-06-01T12:15:00Z",
            },
          }),
        }),
      )
      .min(1)
      .max(1500)
      .meta({ description: "The kept segments: 25 files of at most 60.", example: [] }),
  })
  .meta({
    id: "AuroraApplyItinerariesRequest",
    description: "The segments of an itinerary intake to add.",
  });

const AppliedIntake = z
  .object({
    written: z
      .array(
        z.object({
          suggestion_id: fields.ref("suggestion applied"),
          id: fields.ref("row written"),
        }),
      )
      .meta({ description: "Each kept suggestion with the row it wrote.", example: [] }),
    rejected: fields.int("Suggestions of the batch left out and rejected.", 2),
  })
  .meta({ id: "AuroraAppliedIntake", description: "What an applied intake wrote." });

const ApplyContractsBody = z
  .object({
    groups: z
      .array(
        z.object({
          act_name: fields.text("The act, as grouped.", "The Midnight Owls", 200),
          engagement: z.object({
            mode: z.enum(["new", "existing"]).meta({
              description: "Book a new Artist engagement, or attach riders to a live one.",
              example: "new",
            }),
            engagement_id: fields
              .ref("live Artist engagement of the project, for existing")
              .optional(),
            contract_suggestion_id: fields
              .ref("contract suggestion whose dates, fee and currency are kept")
              .optional(),
            values: z
              .record(z.string(), z.unknown())
              .optional()
              .meta({
                description:
                  "The person's party and terms: person_id and/or counterparty_id, role_code, worker_classification, pay_basis, arrangement, and any start_date, end_date, agreed_rate_minor or currency_code to change.",
                example: {
                  person_id: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f",
                  role_code: "2000.50.02",
                },
              }),
          }),
          riders: z
            .array(
              z.object({
                header_suggestion_id: fields.ref("rider suggestion kept"),
                title: fields
                  .text("The rider's title, when changed.", "Technical Rider", 200)
                  .optional(),
                line_suggestion_ids: z
                  .array(z.uuid())
                  .max(100)
                  .optional()
                  .meta({ description: "Rider lines kept.", example: [] }),
                line_values: z
                  .record(z.string(), z.record(z.string(), z.unknown()))
                  .optional()
                  .meta({
                    description: "Changed description or quantity by line suggestion id.",
                    example: {},
                  }),
              }),
            )
            .max(25)
            .optional()
            .meta({ description: "The act's riders.", example: [] }),
        }),
      )
      .min(1)
      .max(25)
      .meta({ description: "The acts to book, at most 25.", example: [] }),
  })
  .meta({
    id: "AuroraApplyContractsRequest",
    description: "The acts of a contract intake to book.",
  });

const AppliedContracts = z
  .object({
    applied: z
      .array(
        z.object({
          suggestion_id: fields.ref("suggestion applied"),
          id: fields.ref("engagement, rider or rider line written"),
        }),
      )
      .meta({ description: "Each kept suggestion with what it wrote.", example: [] }),
    engagements: fields.int("Artist engagements booked.", 2),
    riders: fields.int("Riders written.", 3),
    rider_lines: fields.int("Rider lines written.", 12),
    rejected: fields.int("Suggestions of the batch left out and rejected.", 1),
  })
  .meta({ id: "AuroraAppliedContracts", description: "What an applied contract intake wrote." });

const ApplyAdvanceAnswerBody = z
  .object({
    suggestion_id: fields.ref("drafted advance answer accepted"),
    values: z
      .record(z.string(), z.unknown())
      .optional()
      .meta({
        description: "The person's changes: body, lines (R9's line shape) or note.",
        example: { body: "Two trucks at 07:00." },
      }),
    source: z
      .object({
        inbound_message_id: fields.ref("project inbox message the draft was read from").optional(),
        file_name: fields.text("File the draft was read from.", "tour-book.pdf", 300).optional(),
      })
      .meta({
        description: "The draft's source, checked again: exactly one of a message and a file name.",
        example: { file_name: "tour-book.pdf" },
      }),
  })
  .meta({
    id: "AuroraApplyAdvanceAnswerRequest",
    description: "A drafted advance answer to record on the party's behalf.",
  });

const AppliedAdvanceAnswer = z
  .object({ submission_id: fields.ref("advance answer recorded") })
  .meta({
    id: "AuroraAppliedAdvanceAnswer",
    description: "The advance answer a drafted answer recorded.",
  });

const action = (verb: string, summary: string, description: string, body: z.ZodType): ActionSpec =>
  collectionAction(verb, { summary, description, body, response: AuroraResult });

const reasonBody = (id: string, description: string) =>
  z
    .object({
      reason: text(
        "Why, recorded in the suggestion ledger.",
        "Checked against the certificate.",
        500,
      ),
    })
    .meta({ id, description });

export const auroraResources: readonly ResourceSpec[] = [
  resource("Settings", "/aurora", AuroraStatus, {
    op: "aurora",
    label: "Aurora AI",
    verbs: [],
    actions: [
      collectionQuery("status", {
        summary: "Read what Aurora can do now",
        description:
          "Features the caller may use (turned on by an Admin and included in the plan) and this month's use of the org's allowance.",
        response: AuroraStatus.read,
      }),
      action(
        "ask",
        "Ask the assistant",
        "Answers a question from records the caller can read through this API, citing them. Returns no_answer with what is missing when the records do not support an answer. Changes it proposes are stored as suggestions for confirmation; nothing is written.",
        AskBody,
      ),
      action(
        "filter",
        "Turn a sentence into a filter",
        "Builds a filter on one collection from a sentence, shows it as an ADR 0003 query string and proposes a saved view (`savedViews.create`) for confirmation.",
        FilterBody,
      ),
      action(
        "extract",
        "Extract a document",
        "Reads a rider, insurance certificate, invoice, receipt or quote into proposed fields with a confidence each and provenance agent. A price, date or quantity the document does not show is NO_ANSWER. Nothing is written until the caller confirms. B15: an itinerary, contract or intake rider read into an intake batch (intake_batch_id), whose suggestions are applied together; the lines of a Proposed payable invoice (invoice_lines with invoice_id, aurora_invoice_not_proposed otherwise); a receipt's items. The answer adds the tie-out against printed totals, the vendor's line history, the itinerary checks and traveler or party candidates. Every refusal comes before any model call and is not metered.",
        ExtractBody,
      ),
      action(
        "draft",
        "Draft text",
        "Drafts an SOP, advance packet, email, day sheet or change order description in the org's verbiage library. Facts the context lacks are marked as gaps, never invented. The draft is returned, not saved or sent. A run of show or risk assessment is drafted into the empty list `target` names: refused with aurora_draft_list_not_empty before any model call when the list has entries, it returns checked lines with their suggestion ids, for `aurora.applyDraft`. B15: advance answers for a recipient of a sent packet (`target` advance-recipients) from one `source`, each answer a suggestion for `aurora.applyAdvanceAnswer`, the sections the source does not answer listed; and an event plan, event brief, approval pack or waste plan from a project's own records (`target` projects), held to its outline.",
        DraftBody,
      ),
      collectionAction("applyDraft", {
        summary: "Add a drafted list",
        description:
          "Adds the kept lines of a drafted run of show or risk assessment in one transaction, with the values the person changed, only while the list is still empty (aurora_draft_list_not_empty otherwise, with nothing written). Every other line of the draft is rejected. A line the database refuses names its line number and nothing is written. Calls no model and meters nothing.",
        body: ApplyDraftBody,
        response: AppliedDraft,
      }),
      action(
        "summarize",
        "Summarize activity",
        "Summarizes a record's activity, a project's week or gate readiness, citing the items each point comes from.",
        SummarizeBody,
      ),
      action(
        "mapColumns",
        "Suggest import column mappings",
        "Suggests a target field for each import column. The import wizard shows the suggestions for the caller to accept or change.",
        MapColumnsBody,
      ),
      action(
        "bindCode",
        "Suggest a catalog binding",
        "Suggests the catalog element an unknown scanned code identifies, only from the candidates given, and proposes `catalogBindings.create` for confirmation.",
        BindCodeBody,
      ),
      collectionAction("applyAdvanceAnswer", {
        summary: "Record a drafted advance answer",
        description:
          "Records one advance answer Aurora drafted, on the recipient's behalf, through the single writer of advance answers (B15, ADR 0154): the caller holds advancing.submission.review on the packet's project and asked for the draft. The source is checked again. The caller becomes the answer's submitter, so someone else reviews it, and Gateway labels it as recorded by the org. An open answer refuses advance_answer_pending. Calls no model and meters nothing.",
        body: ApplyAdvanceAnswerBody,
        response: AppliedAdvanceAnswer,
      }),
      collectionAction("preview", {
        summary: "Preview what a request would send",
        description:
          "Reads the records a drafting or summary request names, as the request would (the caller's permissions, Restricted columns, masked values and excluded tables removed), and returns what would be sent. A gate readiness summary adds the project's gate criteria. No model is called and nothing is metered (A95).",
        body: PreviewBody,
        response: AuroraPreview,
      }),
    ],
  }),
  // Its own op, since every resource names one: auroraIntakes.start, get, close and the applies. get
  // returns a batch of the caller with its requests and Proposed suggestions, so a preview reloads
  // within the seven-day expiry; another person's batch is not found.
  resource("Settings", "/aurora/intakes", AuroraIntake, {
    op: "auroraIntakes",
    label: "Aurora intake",
    verbs: ["get"],
    actions: [
      collectionAction("start", {
        segment: "",
        summary: "Start an intake",
        description:
          "Opens an intake batch for up to 25 itineraries or contracts and riders (B15). Itineraries need hospitality.fulfillment.write on the project; contracts and riders need opportunities.engagement.write and advancing.rider.write. The plan, the extraction switch and this month's remaining allowance are checked for every file first (XR001 plan_limit_exceeded). Each file is then read with aurora.extract and the batch's intake_batch_id, one metered request each.",
        body: StartIntakeBody,
        response: AuroraIntake.read,
      }),
      itemAction("close", {
        summary: "Close an intake",
        description:
          "Closes the caller's intake batch, rejecting its Proposed suggestions. A closed batch reads no more files.",
        response: z
          .object({ rejected: fields.int("Suggestions rejected.", 4) })
          .meta({ id: "AuroraClosedIntake", description: "What closing an intake rejected." }),
      }),
      itemAction("applyItineraries", {
        summary: "Add an intake's travel segments",
        description:
          "Adds the kept segments of an itinerary intake in one transaction under its Travel fulfillment, with the person's traveler, times and values. A segment repeating a live one of the same person refuses itinerary_duplicate and nothing is written. The other suggestions are rejected and the batch is closed. Calls no model and meters nothing.",
        body: ApplyItinerariesBody,
        response: AppliedIntake,
      }),
      itemAction("applyContracts", {
        summary: "Book an intake's acts",
        description:
          "Books the kept acts of a contract intake in one transaction (ADR 0154): an Artist engagement at Onboarding per new act with the person's party, role and terms and the contract's dates, fee and currency, and each act's riders and lines. A fee from a caller who may not read pay rates refuses intake_fee_restricted; an act without a party refuses intake_group_party; the engagement plan limit refuses XR001. Any refusal writes nothing. The other suggestions are rejected and the batch is closed.",
        body: ApplyContractsBody,
        response: AppliedContracts,
      }),
    ],
  }),
  resource("Settings", "/ai-suggestions", AiSuggestion, {
    verbs: ["list", "get"],
    label: "AI suggestion",
    actions: [
      itemAction("confirm", {
        summary: "Confirm an AI suggestion",
        description:
          "Records the confirmation of the person who asked, then performs the named public operation as the caller with the proposed values and any `values` the caller changed or added. On success the suggestion is Applied with the record written. When the operation refuses, the suggestion returns to Proposed and the answer is that 422 refusal. Refused after expiry.",
        body: z
          .object({
            reason: text(
              "Why, recorded in the suggestion ledger.",
              "Checked against the certificate.",
              500,
            ),
            values: z
              .record(z.string(), z.unknown())
              .optional()
              .meta({
                description:
                  "Field values to send instead of, or in addition to, the proposed ones: corrections the person made and context ids such as `document_id`.",
                example: { document_id: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f" },
              }),
          })
          .meta({
            id: "AiSuggestionConfirmRequest",
            description: "Confirmation of an AI suggestion.",
          }),
      }),
      itemAction("reject", {
        summary: "Reject an AI suggestion",
        description: "Rejects a Proposed suggestion; nothing is written.",
        body: reasonBody("AiSuggestionRejectRequest", "Rejection of an AI suggestion."),
      }),
      itemAction("apply", {
        summary: "Record the write of a confirmed suggestion",
        description: "Marks a Confirmed suggestion Applied with the record the public API wrote.",
        body: z
          .object({
            applied_id: fields.ref("record the public API wrote or updated"),
            reason: text("What was written.", "Written by insuranceCertificates.create.", 500),
          })
          .meta({
            id: "AiSuggestionApplyRequest",
            description: "The record a confirmed suggestion wrote.",
          }),
      }),
      itemAction("reopen", {
        summary: "Return a confirmed suggestion to Proposed",
        description:
          "Returns a Confirmed suggestion to Proposed when the public API refused the write, naming the refusal.",
        body: reasonBody("AiSuggestionReopenRequest", "Why the write was refused."),
      }),
    ],
  }),
  resource("Settings", "/ai-requests", AiRequest, { verbs: ["list", "get"], label: "AI request" }),
  resource("Settings", "/ai-usage", AiUsage, {
    op: "aiUsage",
    verbs: ["list"],
    label: "AI usage",
    order: { by: ["metered_at"], numeric: false },
  }),
];

export const auroraCapabilities: Readonly<Record<string, CapabilityRule>> = {
  aurora: { read: "home.dashboard.read", write: "home.dashboard.read" },
  aiSuggestions: { read: "home.dashboard.read", write: "home.dashboard.read" },
  auroraIntakes: { read: "home.dashboard.read", write: "home.dashboard.read" },
  aiRequests: { read: "audit.log.read" },
  aiUsage: { read: "org.usage.read" },
  aiSettings: { actions: { save: "org.ai.write" } },
};

/** Saving the switches creates the org's row on first save, which `update` alone cannot. */
export const aiSettingsActions: readonly ActionSpec[] = [
  collectionAction("save", {
    summary: "Save the AI feature switches",
    description:
      "Creates or updates the caller's org switches in one call (org.ai.write). Turning a feature on while the plan lacks aurora_ai is a 422 refusal, aurora_not_in_plan.",
    body: z
      .object(
        Object.fromEntries(
          AI_FEATURES.map((f) => [
            `${f}_enabled`,
            z.boolean().meta({ description: `${f} switch.`, example: false }),
          ]),
        ),
      )
      .meta({ id: "AiSettingsSaveRequest", description: "Every AI feature switch." }),
  }),
];

export const auroraCorrections: readonly CorrectionInput[] = [
  {
    id: "ai-settings-six-features",
    since: SINCE,
    resources: ["aiSettings"],
    change:
      "Adds `plain_language_enabled`, `summaries_enabled` and `mapping_enabled`, so every Section 4.7 feature has its switch.",
    reason:
      "app.ai_settings (0650) holds one switch per Section 4.7 feature: the assistant, ask in plain language, extraction, drafting, summaries and mapping help. The frozen shape listed three.",
    apply: editShape({
      add: {
        plain_language_enabled: {
          schema: fields.bool("Ask in plain language.", false),
          create: "optional",
          update: true,
        },
        summaries_enabled: {
          schema: fields.bool("Summaries.", false),
          create: "optional",
          update: true,
        },
        mapping_enabled: {
          schema: fields.bool("Mapping help.", false),
          create: "optional",
          update: true,
        },
      },
    }),
  },
];

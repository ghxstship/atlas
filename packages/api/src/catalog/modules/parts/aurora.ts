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
      ])
      .meta({ description: "What the document is.", example: "insurance_certificate" }),
    document_id: orNull(fields.ref("stored document read, when the file is one")).optional(),
    project_id: fields
      .ref(
        "project the document is read for, required for an itinerary or a contract: the request's subject, checked before any model call",
      )
      .optional(),
    media_type: MediaType,
    content_base64: z.string().min(1).max(14_000_000).meta({
      description: "The document content in base64, read by the caller from storage.",
      example: "JVBERi0xLjcK",
    }),
    file_name: fields.text("File name shown in the log.", "coi-atlantic.pdf", 300),
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
      "The list a run of show or risk assessment fills: a running order (run-of-show) or a project (projects). An event plan, brief, approval pack or waste plan names its Document record (records). Required for those kinds.",
    example: { collection: "run-of-show", id: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f" },
  });

/** Governance drafts (B15): Markdown for the editor of a Document record. */
const GOVERNANCE_KINDS = ["event_plan", "event_brief", "approval_pack", "waste_plan"] as const;

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
        ...GOVERNANCE_KINDS,
      ])
      .meta({ description: "What to draft.", example: "sop" }),
    instructions: text("What the draft should say.", "Write the load-in SOP for the main stage."),
    target: DraftTarget.optional(),
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
      .enum([...ListDraftKind.options, ...GOVERNANCE_KINDS, "advance_answers"])
      .optional()
      .meta({
        description:
          "For a drafted list, a governance draft or advance answers, what is drafted: the preview then reads exactly what the draft reads, the list's own records included.",
        example: "run_of_show",
      }),
    target: DraftTarget.optional(),
    advance_recipient_id: fields
      .ref("recipient whose open sections are previewed, for advance_answers")
      .optional(),
    inbound_message_id: fields
      .ref("project inbox message previewed, for advance_answers")
      .optional(),
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

// Aurora intake (B15, ADR 0154) ---------------------------------------------------------------------

const IntakeKind = z.enum(["itinerary", "contract"]).meta({
  id: "AuroraIntakeKind",
  description: "What an intake reads into a project.",
  example: "itinerary",
});

const IntakeOptionsQuery = z.object({
  kind: IntakeKind,
  project_id: fields.ref("project of the intake"),
});

const IntakeOptions = z
  .object({
    fee_visible: z.boolean().meta({
      description: "A contract: whether the caller reads pay, so a fee is read and shown.",
      example: false,
    }),
    can_write_riders: z.boolean().meta({
      description: "A contract: whether the caller may add riders.",
      example: true,
    }),
    travelers: z
      .array(
        z.object({
          person_id: fields.ref("person"),
          engagement_id: orNull(fields.ref("their engagement on the project")),
          display_name: fields.text("Display name.", "Dana Kim", 200),
          source: z.enum(["Member", "Engagement", "Roster"]).meta({
            description: "How they stand on the project.",
            example: "Member",
          }),
        }),
      )
      .meta({ description: "An itinerary: who the passengers may be. Names only.", example: [] }),
    segments: z
      .array(
        z.object({
          person_id: fields.ref("traveler"),
          service_identifier: orNull(fields.text("Flight or service number.", "GA 100", 40)),
          departs_at: fields.instant("Departure."),
        }),
      )
      .meta({ description: "An itinerary: the project's live segments.", example: [] }),
    parties: z
      .array(
        z.object({
          kind: z.enum(["counterparty", "person"]).meta({
            description: "Whether the party is a counterparty or a person.",
            example: "counterparty",
          }),
          id: fields.ref("counterparty or person"),
          name: fields.text("Name.", "Northwind Touring", 200),
          engagement_ids: z.array(z.uuid()).meta({
            description: "The party's live Artist engagements on the project.",
            example: [],
          }),
        }),
      )
      .meta({ description: "A contract: who a booking may be with.", example: [] }),
    rate_cards: z
      .array(
        z.object({
          role_code: fields.text("Canon role.", "2000.50.02", 20),
          role_name: fields.text("Job title.", "Artist Relations Coordinator", 200),
          worker_classification: fields.text("Classification code.", "INDEPENDENT_CONTRACTOR", 60),
          worker_classification_label: fields.text(
            "Classification.",
            "Independent Contractor",
            120,
          ),
          pay_basis: fields.text("Pay basis.", "Day Rate", 60),
          arrangement: fields.text("Arrangement.", "Per Engagement", 60),
        }),
      )
      .meta({ description: "A contract: the non-employee rate card rows on offer.", example: [] }),
  })
  .meta({ id: "AuroraIntakeOptions", description: "What an intake review offers." });

const OpenProposalsQuery = z.object({
  project_id: fields.ref("project of the intake"),
  operation_id: z.enum(["travelSegments.create", "engagements.createFromContract"]).meta({
    description: "The kind of open proposal to resume.",
    example: "travelSegments.create",
  }),
});

const OpenProposal = z
  .object({
    id: fields.ref("suggestion"),
    request_id: fields.ref("request that proposed it"),
    operation_id: fields.text("Operation that applies it.", "travelSegments.create", 100),
    target_id: orNull(fields.ref("record it updates")),
    summary: fields.text("What will change.", "Add segment 1 from the itinerary.", 1000),
    expires_at: fields.instant("After this time it can no longer be applied."),
    proposed_fields: z.array(SuggestionField).meta({
      description: "Proposed fields; row level security leaves out a fee the caller may not read.",
      example: [],
    }),
  })
  .meta({ id: "AuroraOpenProposal", description: "An open proposal of the caller's." });

const OpenProposals = z
  .object({
    data: z.array(OpenProposal).meta({ description: "Open proposals, oldest first.", example: [] }),
  })
  .meta({ id: "AuroraOpenProposals", description: "The caller's open proposals of an intake." });

const ApplyItineraryBody = z
  .object({
    project_id: fields.ref("project the segments are added to"),
    fulfillment_id: orNull(fields.ref("Travel fulfillment of the project")).optional(),
    items: z
      .array(
        z.object({
          suggestion_id: fields.ref("travel segment suggestion kept"),
          values: z.record(z.string(), z.unknown()).meta({
            description:
              "The person's values, overriding the proposal key by key: person_id (required), engagement_id, travel_mode, operator_name, service_identifier, confirmation_identifier, departs_from, departs_at, departs_time_zone, arrives_at_place, arrives_at, arrives_time_zone, price_minor and currency_code.",
            example: { person_id: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f" },
          }),
        }),
      )
      .min(1)
      .max(100)
      .meta({ description: "The lines kept, at most 100.", example: [] }),
  })
  .meta({ id: "AuroraApplyItineraryRequest", description: "Itinerary lines to add." });

const WrittenLines = z.array(
  z.object({ suggestion_id: fields.ref("suggestion applied"), id: fields.ref("row written") }),
);

const AppliedItinerary = z
  .object({
    written: WrittenLines.meta({ description: "Each kept line with its segment.", example: [] }),
    duplicates_checked: fields.int("Lines checked against live segments.", 4),
  })
  .meta({ id: "AuroraAppliedItinerary", description: "What adding itinerary lines wrote." });

const ApplyContractIntakeBody = z
  .object({
    project_id: fields.ref("project the bookings are on"),
    items: z
      .array(
        z.object({
          suggestion_ids: z
            .array(z.uuid())
            .min(1)
            .max(25)
            .meta({ description: "The group's documents.", example: [] }),
          party: z
            .object({
              person_id: fields.ref("person booked").optional(),
              counterparty_id: fields.ref("counterparty booked").optional(),
            })
            .meta({
              description: "Exactly one of a person on the project or a counterparty of the org.",
              example: { counterparty_id: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f" },
            }),
          engagement_id: fields.ref("live engagement of the party to attach to").optional(),
          role_code: fields.text("Canon role.", "2000.50.02", 20).optional(),
          worker_classification: fields
            .text("Classification code.", "INDEPENDENT_CONTRACTOR", 60)
            .optional(),
          pay_basis: fields.text("Pay basis.", "Day Rate", 60).optional(),
          arrangement: fields.text("Arrangement.", "Per Engagement", 60).optional(),
          start_date: fields.date("First date of the engagement.").optional(),
          end_date: orNull(fields.date("Last date of the engagement.")).optional(),
          agreed_rate_minor: orNull(
            fields.int("Rate per pay basis unit, in minor units; needs pay access.", 150000),
          ).optional(),
          currency_code: orNull(fields.text("ISO 4217 currency of the rate.", "USD", 3)).optional(),
          create_riders: z.boolean().optional().meta({
            description: "Add each Rider document as a rider; needs advancing.rider.write.",
            example: true,
          }),
        }),
      )
      .min(1)
      .max(50)
      .meta({ description: "One group per booking, at most 50.", example: [] }),
  })
  .meta({ id: "AuroraApplyContractIntakeRequest", description: "Bookings to add from contracts." });

const AppliedContractIntake = z
  .object({
    engagements: z
      .array(
        z.object({
          suggestion_ids: z.array(z.uuid()).meta({ description: "The group.", example: [] }),
          engagement_id: fields.ref("engagement booked or attached to"),
          created: z.boolean().meta({ description: "A new engagement.", example: true }),
          documents: z
            .array(
              z.object({
                suggestion_id: fields.ref("document"),
                engagement_document_id: orNull(fields.ref("engagement document, for its file")),
                document_type: z.enum(["Contract", "Rider"]).meta({
                  description: "What the document is.",
                  example: "Contract",
                }),
              }),
            )
            .meta({ description: "Each document with the row its file attaches to.", example: [] }),
        }),
      )
      .meta({ description: "One entry per group.", example: [] }),
    riders: fields.int("Riders added.", 1),
  })
  .meta({ id: "AuroraAppliedContractIntake", description: "What a contract review wrote." });

const ApplyInvoiceLinesBody = z
  .object({
    invoice_id: fields.ref("invoice the lines are added to"),
    items: z
      .array(
        z.object({
          suggestion_id: fields.ref("invoice line suggestion kept"),
          values: z.record(z.string(), z.unknown()).meta({
            description:
              "The person's values: description, quantity, unit_price_minor, budget_line_id.",
            example: { quantity: 2 },
          }),
        }),
      )
      .min(1)
      .max(40)
      .meta({ description: "The lines kept, at most 40.", example: [] }),
  })
  .meta({ id: "AuroraApplyInvoiceLinesRequest", description: "Invoice lines to add." });

const AppliedInvoiceLines = z
  .object({
    written: WrittenLines.meta({ description: "Each kept line with its row.", example: [] }),
  })
  .meta({ id: "AuroraAppliedInvoiceLines", description: "What adding invoice lines wrote." });

const InvoiceLineProposalsQuery = z.object({ invoice_id: fields.ref("invoice") });

const DraftAdvanceAnswersBody = z
  .object({
    advance_recipient_id: fields.ref("recipient of a sent packet"),
    inbound_message_id: fields.ref("Verified or Filed project inbox message").optional(),
    media_type: MediaType.optional(),
    content_base64: z.string().min(1).max(14_000_000).optional().meta({
      description: "A file the person chose, in base64.",
      example: "JVBERi0xLjcK",
    }),
    file_name: fields
      .text("File name, shown as the answer's source.", "tour-book.pdf", 300)
      .optional(),
    verbiage: z
      .array(z.object({ term: z.string().min(1).max(100), preferred: z.string().min(1).max(200) }))
      .max(200)
      .default([])
      .meta({
        description: "The org's verbiage library entries to apply.",
        example: [{ term: "loading dock", preferred: "Dock" }],
      }),
  })
  .meta({
    id: "AuroraDraftAdvanceAnswersRequest",
    description:
      "One source for a recipient's open sections: inbound_message_id, or media_type, content_base64 and file_name.",
  });

const ApplyAdvanceAnswerBody = z
  .object({
    suggestion_id: fields.ref("drafted answer accepted"),
    values: z
      .record(z.string(), z.unknown())
      .optional()
      .meta({
        description: "Corrections to text, note or lines.",
        example: { text: "Two trucks at 07:00." },
      }),
  })
  .meta({ id: "AuroraApplyAdvanceAnswerRequest", description: "A drafted answer to record." });

const AppliedAdvanceAnswer = z
  .object({ submission_id: fields.ref("advance answer recorded") })
  .meta({ id: "AuroraAppliedAdvanceAnswer", description: "The answer recorded." });

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
        "Reads a rider, insurance certificate, invoice, receipt, quote, itinerary or contract into proposed fields with a confidence each and provenance agent. A price, date or quantity the document does not show is NO_ANSWER. Nothing is written until the caller confirms. An itinerary or contract needs `project_id` and the write capability on that project, checked before any model call or metering; a fee is read only for a caller who reads pay. A tool call cut off at the token limit stores nothing.",
        ExtractBody,
      ),
      action(
        "draft",
        "Draft text",
        "Drafts an SOP, advance packet, email, day sheet or change order description in the org's verbiage library. Facts the context lacks are marked as gaps, never invented. The draft is returned, not saved or sent. A run of show or risk assessment is drafted into the empty list `target` names: refused with aurora_draft_list_not_empty before any model call when the list has entries, it returns checked lines with their suggestion ids, for `aurora.applyDraft`. An event plan, event brief, approval pack or waste plan names its Document record of the matching subtype as `target` and needs work.record.write on its project, before any model call or metering; the draft is returned for the record's editor.",
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
      collectionQuery("intakeOptions", {
        summary: "Read what an intake review offers",
        description:
          "An itinerary's traveler candidates, names only, or a contract's parties and non-employee rate card rows, with whether the caller reads pay and may add riders. Needs the intake's write capability on the project. Calls no model and meters nothing.",
        query: IntakeOptionsQuery,
        response: IntakeOptions,
      }),
      collectionQuery("openProposals", {
        summary: "Resume an intake review",
        description:
          "The caller's open proposals of a project's intake, with their fields, so a reload resumes the review until they expire at 7 days. Calls no model and meters nothing.",
        query: OpenProposalsQuery,
        response: OpenProposals,
      }),
      collectionQuery("invoiceLineProposals", {
        summary: "Read an invoice's open line proposals",
        description:
          "The caller's open line suggestions of an invoice: those whose extraction's header suggestion was saved as this invoice. Calls no model and meters nothing.",
        query: InvoiceLineProposalsQuery,
        response: OpenProposals,
      }),
      collectionAction("applyItinerary", {
        summary: "Add itinerary lines",
        description:
          "Adds kept itinerary lines as travel segments in one transaction, with the person's traveler and values. A person with no standing on the project refuses aurora_itinerary_traveler; a live segment of the same person, service and departure refuses aurora_itinerary_duplicate. Each refusal names its line and writes nothing. Untouched suggestions stay open. Calls no model and meters nothing.",
        body: ApplyItineraryBody,
        response: AppliedItinerary,
      }),
      collectionAction("applyContractIntake", {
        summary: "Add bookings from contracts",
        description:
          "Books each kept group in one transaction: a new Artist engagement at Onboarding with the person's terms, or the documents attached to the party's live engagement. Contract documents become Agreement rows, rider documents become riders only with advancing.rider.write. A fee without pay access refuses aurora_fee_restricted. Each refusal names its line and writes nothing. Calls no model and meters nothing.",
        body: ApplyContractIntakeBody,
        response: AppliedContractIntake,
      }),
      collectionAction("applyInvoiceLines", {
        summary: "Add invoice lines",
        description:
          "Adds kept lines to the invoice their extraction was saved as, as the caller, numbered after the existing lines. Lines of another invoice refuse aurora_invoice_lines_foreign, a currency mismatch aurora_invoice_currency, and a non-Proposed invoice invoice_locked. Calls no model and meters nothing.",
        body: ApplyInvoiceLinesBody,
        response: AppliedInvoiceLines,
      }),
      action(
        "draftAdvanceAnswers",
        "Draft advance answers from a reply",
        "Reads one source, Verified or Filed project inbox mail or a file the person chose, into proposed answers for a recipient's open sections, one suggestion per answer. Needs advancing.submission.review on the packet's project; Item Request and Credential Request sections also need advancing.packet.write. Unverified mail refuses aurora_advance_source_unverified, a blank body aurora_advance_source_empty and a recipient with no open section aurora_advance_no_open_sections, all before metering. Guest List, File, Crew Roster and per-person sections are never drafted, and the model never receives the roster, a profile or a project fact.",
        DraftAdvanceAnswersBody,
      ),
      collectionAction("applyAdvanceAnswer", {
        summary: "Record a drafted advance answer",
        description:
          "Records one accepted answer through the single writer of advance answers, with its source, and tells the recipient side. The accepter is the answer's submitter, so a second person reviews it. An open answer refuses advance_answer_pending. Calls no model and meters nothing.",
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

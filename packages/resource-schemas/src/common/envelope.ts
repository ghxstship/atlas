/**
 * Shared response shapes from ADR 0003: problem details, refusals, masked fields,
 * cursor pages and NULL-aware money totals.
 */
import { z } from "zod";
import { currency } from "./fields.ts";
import { Refusal } from "./enums.ts";

/** RFC 9457 problem details. */
export const Problem = z
  .object({
    type: z.string().meta({
      description: "URI reference that identifies the problem type.",
      example: "/problems/not-found",
    }),
    title: z
      .string()
      .meta({ description: "Short summary of the problem type.", example: "Not Found" }),
    status: z.int().min(400).max(599).meta({ description: "HTTP status code.", example: 404 }),
    detail: z.string().optional().meta({
      description: "Explanation specific to this occurrence.",
      example: "No project with this identifier is visible to you.",
    }),
    instance: z.string().optional().meta({
      description: "URI reference that identifies this occurrence.",
      example: "/api/v1/projects/0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f",
    }),
  })
  .meta({
    id: "Problem",
    description: "RFC 9457 problem details, served as application/problem+json.",
  });

/** A 422 refusal (Section 3.7): the request was understood and a rule refused it. */
export const RefusalProblem = Problem.extend({
  refusal: Refusal,
  reason: z.string().meta({
    description: "Why the request was refused, in sentence case.",
    example: "The creator of a purchase order cannot approve it.",
  }),
  rule: z.string().optional().meta({
    description: "The rule that refused the request, such as a separation of duties rule.",
    example: "sod.po.creator_cannot_approve",
  }),
}).meta({
  id: "RefusalProblem",
  description: "Problem details for a refusal. Returned with status 422.",
});

/** A 422 validation failure, with one entry per invalid field. */
export const ValidationProblem = Problem.extend({
  errors: z
    .array(
      z.object({
        pointer: z
          .string()
          .meta({ description: "JSON Pointer to the invalid member.", example: "/title" }),
        detail: z
          .string()
          .meta({ description: "What is wrong with the value.", example: "Required." }),
      }),
    )
    .meta({ description: "Invalid members of the request." }),
}).meta({
  id: "ValidationProblem",
  description:
    "Problem details for a request that failed schema validation. Returned with status 422.",
});

/** A Restricted value the caller may not read (Section 8.3). The field stays present. */
export const Masked = z
  .object({
    masked: z.literal(true).meta({ description: "Always true for a masked value.", example: true }),
    reason: z.string().meta({
      description: "Why the value is masked, naming the capability that would reveal it.",
      example: "Requires data.restricted.read.payroll.",
    }),
  })
  .meta({
    id: "Masked",
    description: "A Restricted field the caller may not read. The field stays present.",
  });

/** Read shape of a Restricted field: the value, or the masked marker. */
export function maskable<T extends z.ZodType>(schema: T) {
  return z.union([schema, Masked]);
}

/** Cursor page envelope (ADR 0003). */
export function page<T extends z.ZodType>(item: T, id: string) {
  return z
    .object({
      data: z
        .array(item)
        .meta({ description: "Items on this page, in the documented default order." }),
      next_cursor: z.string().nullable().meta({
        description: "Opaque cursor for the next page; null on the last page.",
        example: "eyJpZCI6IjAxOTJmMWUyIn0",
      }),
    })
    .meta({ id, description: "One page of results with a cursor to the next page." });
}

/** A NULL-aware money total (Section 3.7): blanks stay blank and are counted. */
export const MoneyTotal = z
  .object({
    total_minor: z.int().nullable().meta({
      description: "Sum of priced inputs in minor units; null when every input is unpriced.",
      example: 1250000,
      format: "int64",
    }),
    currency: currency(),
    unpriced_count: z.int().min(0).meta({
      description: "Number of inputs that are unpriced (null) and were not summed.",
      example: 2,
    }),
  })
  .meta({
    id: "MoneyTotal",
    description: "A money aggregate that never coerces unpriced inputs to zero.",
  });

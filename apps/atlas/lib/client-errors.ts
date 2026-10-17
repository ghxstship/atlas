import { z } from "zod";

/**
 * The browser error payload `instrumentation-client.ts` posts to /api/client-errors (ADR 0025).
 * Strict: an unknown field, a query string in the route or a malformed user id refuses the whole
 * payload, so nothing beyond these fields can reach the error reporter.
 */
export const ClientErrorSchema = z.strictObject({
  message: z.string().min(1).max(300),
  stack: z.string().max(4000).optional(),
  route: z
    .string()
    .max(200)
    .regex(/^\/[\w.~[\]/-]*$/),
  source: z.enum(["window", "promise", "boundary"]),
  release: z
    .string()
    .regex(/^[\w.-]{1,64}$/)
    .optional(),
  userId: z.uuid().optional(),
});

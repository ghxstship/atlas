/**
 * RFC 9457 problem responses for handlers as they mount. Validation failures become 422
 * problem details with one JSON Pointer per invalid member.
 */
import type { Context } from "hono";
import type { z } from "@hono/zod-openapi";
import { PROBLEM_MEDIA_TYPE } from "./conventions/components.ts";

export interface ProblemBody {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly instance?: string;
  readonly [extension: string]: unknown;
}

export function problemResponse(body: ProblemBody): Response {
  return new Response(JSON.stringify(body), {
    status: body.status,
    headers: { "Content-Type": PROBLEM_MEDIA_TYPE },
  });
}

/** JSON Pointer (RFC 6901) for a Zod issue path. */
export function toPointer(path: readonly PropertyKey[]): string {
  return path.map((p) => `/${String(p).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

type HookResult = { success: true } | { success: false; error: z.ZodError };

/** `defaultHook` for OpenAPIHono: turns a validation failure into a 422 problem. */
export function validationHook(result: HookResult, c: Context): Response | undefined {
  if (result.success) return undefined;
  return problemResponse({
    type: "/problems/validation",
    title: "Unprocessable Content",
    status: 422,
    detail: `${result.error.issues.length} member(s) of the request are invalid.`,
    instance: new URL(c.req.url).pathname,
    errors: result.error.issues.map((i) => ({ pointer: toPointer(i.path), detail: i.message })),
  });
}

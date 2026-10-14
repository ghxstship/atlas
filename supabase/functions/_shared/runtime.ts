// Shared plumbing for the XOS Edge Functions (Deno). Logic lives in @xos/platform; this file only reads
// the environment, builds the service-role database seam and shapes responses.
import { createClient } from "@supabase/supabase-js";
import { supabaseDb, type PlatformDb } from "../_vendor/xos-platform.js";

/** A required environment variable, or a thrown error naming it. */
export function env(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined || value.length === 0) throw new Error(`${name} is not set`);
  return value;
}

/** The service-role database seam. Never exposed to callers. */
export function serviceDb(): PlatformDb {
  const client = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return supabaseDb(client);
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True when the request carries the expected bearer secret (workers are called by pg_cron with the service key). */
export function hasBearer(request: Request, secret: string): boolean {
  const header = request.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") && constantTimeEqual(header.slice(7), secret);
}

/** Wraps a handler so an unexpected error becomes a 500 with its message, never a silent failure. */
export function serve(handler: (request: Request) => Promise<Response>): void {
  Deno.serve(async (request) => {
    try {
      return await handler(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ level: "error", message }));
      return json(500, {
        type: "/problems/internal",
        title: "Internal error",
        status: 500,
        detail: message,
      });
    }
  });
}

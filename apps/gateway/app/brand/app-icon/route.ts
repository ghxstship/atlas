import { env } from "@/lib/env";
import { getRequestFacts } from "@/lib/shell/context";

/**
 * GET /brand/app-icon: the app icon of the org whose custom domain serves this request (Section 4.4.7, A96), from the
 * public org-brand bucket, served on Gateway's own origin so the manifest and its Content Security Policy need no
 * other origin. 404 on the platform domain or when the org set no app icon.
 */
export const dynamic = "force-dynamic";

const PATH = /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,499}$/;

export async function GET(): Promise<Response> {
  const facts = await getRequestFacts();
  const path = facts.brand.kind === "org" ? facts.brand.org.appIconPath : null;
  if (!path || !PATH.test(path) || path.includes("..")) return new Response(null, { status: 404 });
  const upstream = await fetch(
    `${env().SUPABASE_URL}/storage/v1/object/public/org-brand/${path.split("/").map(encodeURIComponent).join("/")}`,
  );
  const type = upstream.headers.get("content-type") ?? "";
  if (!upstream.ok || !/^image\/(png|jpeg|webp|svg\+xml)/.test(type))
    return new Response(null, { status: 404 });
  return new Response(upstream.body, {
    headers: {
      "Content-Type": type,
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

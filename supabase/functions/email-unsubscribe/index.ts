// One-click unsubscribe (Section 14.5, RFC 8058): POST from the mail client, or GET from the link in the
// footer, with a token signed per org, person and category. GET then sends the person to their
// notification settings. A stakeholder pack token (xpku_, B2, ADR 0141) branches first: the POST stops the emails, and
// the GET goes to Atlas's confirm page without acting, because mail scanners follow links.
import { env, json, serve, serviceDb } from "../_shared/runtime.ts";

serve(async (request) => {
  const token = new URL(request.url).searchParams.get("token");
  if (request.method !== "POST" && request.method !== "GET") {
    return json(405, {
      type: "/problems/method-not-allowed",
      title: "Method not allowed",
      status: 405,
    });
  }
  if (token?.startsWith("xpku_")) {
    if (request.method === "GET") {
      return Response.redirect(`${env("XOS_APP_URL")}/share/pack/unsubscribe/${token}`, 303);
    }
    const stopped = await serviceDb().rpc("unsubscribe_pack_by_token", { p_token: token });
    if (stopped !== true)
      return json(404, { type: "/problems/not-found", title: "Not found", status: 404 });
    return new Response(null, { status: 204 });
  }
  const orgSlug = await serviceDb().rpc("unsubscribe_by_token", { p_token: token });
  if (typeof orgSlug !== "string")
    return json(404, { type: "/problems/not-found", title: "Not found", status: 404 });
  if (request.method === "POST") return new Response(null, { status: 204 });
  return Response.redirect(`${env("XOS_APP_URL")}/${orgSlug}/me/notifications?unsubscribed=1`, 303);
});

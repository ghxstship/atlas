// One-click unsubscribe (Section 14.5, RFC 8058): POST from the mail client, or GET from the link in the
// footer, with a token signed per org, person and category. GET then sends the person to their
// notification settings.
//
// Guest list emails (B8, ADR 0147 decision 7) carry ?guest=<token> instead. A POST, the mail client's one-click
// request, suppresses the address for the org that sent it (api_public.unsubscribe_guest_email) and answers 204
// whether or not the token was known. A GET never unsubscribes: it sends the guest to Gateway's unsubscribe page,
// which asks first, so a mail scanner that only fetches the link changes nothing.
import { env, json, serve, serviceDb } from "../_shared/runtime.ts";

serve(async (request) => {
  const url = new URL(request.url);
  if (request.method !== "POST" && request.method !== "GET") {
    return json(405, {
      type: "/problems/method-not-allowed",
      title: "Method not allowed",
      status: 405,
    });
  }
  const guest = url.searchParams.get("guest");
  if (guest !== null) {
    if (request.method === "GET") {
      return Response.redirect(
        `${env("XOS_GATEWAY_URL")}/unsubscribe/${encodeURIComponent(guest)}`,
        303,
      );
    }
    await serviceDb("api_public").rpc("unsubscribe_guest_email", { p_token: guest });
    return new Response(null, { status: 204 });
  }
  const token = url.searchParams.get("token");
  const orgSlug = await serviceDb().rpc("unsubscribe_by_token", { p_token: token });
  if (typeof orgSlug !== "string")
    return json(404, { type: "/problems/not-found", title: "Not found", status: 404 });
  if (request.method === "POST") return new Response(null, { status: 204 });
  return Response.redirect(`${env("XOS_APP_URL")}/${orgSlug}/me/notifications?unsubscribed=1`, 303);
});

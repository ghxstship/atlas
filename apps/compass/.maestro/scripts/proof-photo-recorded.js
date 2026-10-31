/* global http, json, output, SUPABASE_URL, SUPABASE_ANON_KEY, EMAIL, XOS_DEMO_PASSWORD, ENTITLEMENT, SINCE */
// A140 "see it recorded once": signs in as the sponsor over the auth API and counts the proof photos of ENTITLEMENT
// recorded since SINCE (the flow's start, so a rerun on the same stack counts only its own) through the projection
// Compass downloads (api_external.proof_of_performance_photos, 2332), and checks each one's path is in the
// engagement's folder. Leaves { status, photos, inFolder } in output.proof. Maestro runs scripts in Rhino, so this
// file is ES5.
var auth = http.post(SUPABASE_URL + "/auth/v1/token?grant_type=password", {
  headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: XOS_DEMO_PASSWORD }),
});
var token = json(auth.body).access_token;
var res = http.get(
  SUPABASE_URL +
    "/rest/v1/proof_of_performance_photos?select=id,engagement_id,media_uri&sponsor_entitlement_id=eq." +
    ENTITLEMENT +
    (typeof SINCE !== "undefined" && SINCE ? "&created_at=gte." + encodeURIComponent(SINCE) : ""),
  {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: "Bearer " + token,
      "Accept-Profile": "api_external",
    },
  },
);
var rows = json(res.body);
var inFolder = 0;
for (var i = 0; i < rows.length; i += 1) {
  if (rows[i].media_uri.indexOf("/proof-of-performance/" + rows[i].engagement_id + "/") > 0)
    inFolder += 1;
}
output.proof = { status: res.status, photos: rows.length, inFolder: inFolder, body: res.body };

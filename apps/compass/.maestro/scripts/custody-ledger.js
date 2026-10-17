/* global http, json, output, SUPABASE_URL, SUPABASE_ANON_KEY, EMAIL, XOS_DEMO_PASSWORD, TAG */
// Journey 19, "see the custody ledger": signs in over the auth API and reads the custody rows of the unit
// tagged TAG, newest last, as Atlas's asset page lists them. Leaves { events, lastReturned } in
// output.ledger; a return names no custodian. Maestro runs scripts in Rhino, so this file is ES5.
var auth = http.post(SUPABASE_URL + "/auth/v1/token?grant_type=password", {
  headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: XOS_DEMO_PASSWORD }),
});
var token = json(auth.body).access_token;
var res = http.get(
  SUPABASE_URL +
    "/rest/v1/asset_custody?select=created_at,custodian_membership_id,custodian_engagement_id,asset_units!inner(asset_tag)" +
    "&asset_units.asset_tag=eq." +
    encodeURIComponent(TAG) +
    "&order=created_at.asc",
  {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: "Bearer " + token,
      "Accept-Profile": "app",
    },
  },
);
var rows = json(res.body);
var last = rows.length > 0 ? rows[rows.length - 1] : null;
output.ledger = {
  status: res.status,
  events: rows.length,
  lastReturned:
    last !== null && last.custodian_membership_id === null && last.custodian_engagement_id === null,
  body: res.body,
};

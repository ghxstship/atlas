/* global http, json, output, SUPABASE_URL, SUPABASE_ANON_KEY, XOS_DEMO_PASSWORD, STEP */
// B6 setup for itinerary-changes (G-65): Demo Road Crew (seed 1490) marks their itinerary on the demo project all as
// seen (app.mark_seen), then the demo Owner, signed in as an Atlas writer would be, moves the crew member's flight out
// of LAX by an hour under row level security. STEP=undo moves it back when the flow completes. Every step runs as the
// person whose step it is; nothing writes SQL. Leaves { status } in output.itinerary, naming the first step that
// failed. Maestro runs scripts in Rhino (ES5).
var FLIGHT = "01920000-0000-7000-8000-000014900821";

function signIn(email) {
  var res = http.post(SUPABASE_URL + "/auth/v1/token?grant_type=password", {
    headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: email, password: XOS_DEMO_PASSWORD }),
  });
  return json(res.body).access_token;
}

function headers(token, profile) {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
    "Content-Profile": profile,
    "Accept-Profile": profile,
    Prefer: "return=representation",
  };
}

function moveFlight(token, hours) {
  var rows = json(
    http.get(SUPABASE_URL + "/rest/v1/travel_segments?select=departs_at,arrives_at&id=eq." + FLIGHT, {
      headers: headers(token, "app"),
    }).body,
  );
  if (rows.length !== 1) throw new Error("the flight is not readable");
  var shift = hours * 3600000;
  var res = http.request(SUPABASE_URL + "/rest/v1/travel_segments?id=eq." + FLIGHT, {
    method: "PATCH",
    headers: headers(token, "app"),
    body: JSON.stringify({
      departs_at: new Date(Date.parse(rows[0].departs_at) + shift).toISOString(),
      arrives_at: new Date(Date.parse(rows[0].arrives_at) + shift).toISOString(),
    }),
  });
  if (res.status >= 300) throw new Error("move " + res.status + " " + res.body);
}

var status = "ok";
try {
  var owner = signIn("owner@example.com");
  if (STEP === "undo") {
    status = "undo";
    moveFlight(owner, -1);
  } else {
    status = "mark-seen";
    var crew = signIn("road.crew@example.com");
    var trips = json(
      http.get(SUPABASE_URL + "/rest/v1/travel?select=engagement_id&id=eq." + FLIGHT, {
        headers: headers(crew, "api_external"),
      }).body,
    );
    if (trips.length !== 1) throw new Error("the crew member reads no flight");
    var seen = http.post(SUPABASE_URL + "/rest/v1/rpc/mark_seen", {
      headers: headers(crew, "app"),
      body: JSON.stringify({ p_surface: "Itinerary", p_scope_id: trips[0].engagement_id }),
    });
    if (seen.status >= 300) throw new Error("mark_seen " + seen.status + " " + seen.body);
    status = "move";
    moveFlight(owner, 1);
    status = "ok";
  }
} catch (e) {
  output.itineraryError = String(e);
}
output.itinerary = { status: status };

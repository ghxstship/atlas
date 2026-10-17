/* global http, json, output, SUPABASE_URL, SUPABASE_ANON_KEY, EMAIL, XOS_DEMO_PASSWORD, TITLE */
// Journeys 16 and 54, "see it filed once": signs in as the reporter over the auth API and counts the
// incidents titled TITLE and the photos and voice notes filed with them, as the Atlas dispatch board reads
// them. Leaves { incidents, photos, voiceNotes } in output.filed. Maestro runs scripts in Rhino, so this
// file is ES5.
var auth = http.post(SUPABASE_URL + "/auth/v1/token?grant_type=password", {
  headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: XOS_DEMO_PASSWORD }),
});
var token = json(auth.body).access_token;
var res = http.get(
  SUPABASE_URL +
    "/rest/v1/incidents?select=id,incident_media(id,media_kind)&title=eq." +
    encodeURIComponent(TITLE),
  {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: "Bearer " + token,
      "Accept-Profile": "app",
    },
  },
);
var rows = json(res.body);
var photos = 0;
var voiceNotes = 0;
for (var i = 0; i < rows.length; i += 1) {
  var media = rows[i].incident_media || [];
  for (var j = 0; j < media.length; j += 1) {
    if (media[j].media_kind === "Voice Note") voiceNotes += 1;
    else photos += 1;
  }
}
output.filed = {
  status: res.status,
  incidents: rows.length,
  photos: photos,
  voiceNotes: voiceNotes,
  body: res.body,
};

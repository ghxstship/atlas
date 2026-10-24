/* global http, json, output, NETWORK_HELPER_URL, STEP */
// iOS "offline": asks the network helper (scripts/maestro-network.ts serve) to stop the local stack's API
// gateway (STEP "offline") or start it again and wait until it answers (STEP "online"). Android runs use
// setAirplaneMode instead. Leaves { status, ok } in output.network.
// Maestro runs scripts in Rhino, so this file sticks to ES5.
var base =
  typeof NETWORK_HELPER_URL !== "undefined" && NETWORK_HELPER_URL
    ? NETWORK_HELPER_URL
    : "http://127.0.0.1:57158";
var res = http.post(base + "/" + STEP, {
  headers: { "Content-Type": "application/json" },
  body: "{}",
});
output.network = {
  status: res.status,
  ok: res.status === 200 && json(res.body).ok === true,
  body: res.body,
};

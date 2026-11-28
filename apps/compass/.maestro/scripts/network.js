/* global http, json, output, NETWORK_HELPER_URL, STEP */
// iOS "offline": asks the network helper (scripts/maestro-network.ts serve) to stop the local stack's API
// gateway (STEP "offline") or start it again and wait until it answers (STEP "online"). Android runs use
// setAirplaneMode instead. Leaves { status, ok } in output.network.
// Maestro runs scripts in Rhino, so this file sticks to ES5.
var base =
  typeof NETWORK_HELPER_URL !== "undefined" && NETWORK_HELPER_URL
    ? NETWORK_HELPER_URL
    : "http://127.0.0.1:57158";
// No helper answering (a run by hand without it) leaves ok false instead of stopping the flow: the offline
// flows assert ok, and the sign-in subflow, which only puts the network back after a failed flow, does not.
try {
  var res = http.post(base + "/" + STEP, {
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  output.network = {
    status: res.status,
    ok: res.status === 200 && json(res.body).ok === true,
    body: res.body,
  };
} catch (error) {
  output.network = { status: 0, ok: false, body: String(error) };
}

/* global http, json, output, PUSH_HELPER_URL, STEP */
// Journey 57: asks the local push helper (scripts/journey-57-push.ts serve) to run one step, "push"
// (submit a timesheet and deliver the Producer's approval request with xcrun simctl push) or "verify"
// (read the timesheet back as Approved by the Producer). Leaves the answer in output.helper.
// Maestro runs scripts in Rhino, so this file sticks to ES5.
var base =
  typeof PUSH_HELPER_URL !== "undefined" && PUSH_HELPER_URL
    ? PUSH_HELPER_URL
    : "http://127.0.0.1:57157";
var res = http.post(base + "/" + STEP, {
  headers: { "Content-Type": "application/json" },
  body: "{}",
});
output.helper = {
  status: res.status,
  ok: res.status === 200 && json(res.body).ok === true,
  body: res.body,
};

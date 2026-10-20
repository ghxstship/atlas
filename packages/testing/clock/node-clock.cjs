"use strict";
/* global process */
/**
 * Test clock for Node (A71, RRR-116). Preload it with
 * `NODE_OPTIONS="--require <path>/node-clock.cjs"` and set E2E_CLOCK_OFFSET_MS to shift the wall
 * clock of every Node process that inherits the variable: the Playwright runner, its workers and the
 * Next servers. Only `Date` moves; timers, `performance.now()` and the event loop stay real, so
 * timeouts behave. `pg-clock.sh` prints the offset for a target instant and moves the database
 * clock by the same amount, and the journeys' `engine-test.ts` moves each browser context's clock.
 *
 * Offsets into the past are the safe choice: the auth server and PostgREST keep the real clock, so
 * a token they issue looks fresh to every shifted clock, while a future offset longer than the token
 * lifetime makes the clients refresh without end.
 */
const offset = Number(process.env["E2E_CLOCK_OFFSET_MS"] ?? 0);

if (Number.isFinite(offset) && offset !== 0 && !globalThis.__xosTestClock) {
  const RealDate = Date;
  const realNow = RealDate.now.bind(RealDate);
  const now = () => realNow() + offset;
  function ShiftedDate(...args) {
    if (!new.target) return new RealDate(now()).toString();
    return args.length === 0 ? new RealDate(now()) : new RealDate(...args);
  }
  ShiftedDate.prototype = RealDate.prototype;
  Object.setPrototypeOf(ShiftedDate, RealDate);
  ShiftedDate.now = now;
  ShiftedDate.parse = RealDate.parse;
  ShiftedDate.UTC = RealDate.UTC;
  globalThis.Date = ShiftedDate;
  globalThis.__xosTestClock = { offset, realNow };
}

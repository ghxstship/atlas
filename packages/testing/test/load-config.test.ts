import { describe, expect, it } from "vitest";
import {
  SLO,
  SMOKE,
  TARGETS,
  apiThresholds,
  loadEnv,
  parseDuration,
  rampingScenario,
} from "../load/lib/config.js";
import { apiBudgets, loadTargets } from "../src/budgets.ts";

const key = { SUPABASE_ANON_KEY: "publishable-key-for-tests" };

describe("k6 configuration", () => {
  it("mirrors the Section 5.1 budgets", () => {
    expect(SLO).toEqual({
      readP95: apiBudgets.readP95Ms,
      writeP95: apiBudgets.writeP95Ms,
      p99: apiBudgets.p99Ms,
      syncP95: apiBudgets.compassSyncP95Ms,
    });
    expect(TARGETS).toEqual({
      platformUsers: loadTargets.platformConcurrentUsers,
      tenantUsers: loadTargets.tenantConcurrentUsers,
      compassDevices: loadTargets.compassDevicesPerShow,
    });
  });

  it("defaults to a smoke run against the local stack", () => {
    const env = loadEnv(key);
    expect(env.mode).toBe("smoke");
    expect(env.scale).toEqual(SMOKE);
    expect(env.supabaseUrl).toContain("57421");
    expect(env.users.length).toBeGreaterThan(0);
  });

  it("refuses a hosted target in a smoke run", () => {
    expect(() => loadEnv({ ...key, SUPABASE_URL: "https://abc.supabase.co" })).toThrow(
      /only target a local stack/,
    );
  });

  it("needs the staging host confirmed for a full run", () => {
    const staging = { ...key, LOAD_MODE: "full", ATLAS_URL: "https://staging.example.test" };
    expect(() => loadEnv(staging)).toThrow(/LOAD_CONFIRM_STAGING=staging.example.test/);
    const confirmed = loadEnv({ ...staging, LOAD_CONFIRM_STAGING: "staging.example.test" });
    expect(confirmed.scale).toEqual(TARGETS);
  });

  it("refuses to run without the publishable key", () => {
    expect(() => loadEnv({})).toThrow(/SUPABASE_ANON_KEY/);
  });

  it("ramps up, holds and ramps down within the duration", () => {
    expect(parseDuration("30s")).toBe(30);
    expect(parseDuration("10m")).toBe(600);
    expect(parseDuration("1h")).toBe(3600);
    expect(() => parseDuration("ten")).toThrow();
    const scenario = rampingScenario(100, "10m", "default");
    expect(scenario.stages.map((s) => s.target)).toEqual([100, 100, 0]);
    expect(scenario.stages.map((s) => parseDuration(s.duration)).reduce((a, b) => a + b)).toBe(600);
  });

  it("sets read and write thresholds from the objectives", () => {
    expect(apiThresholds()["http_req_duration{kind:read}"]).toEqual(["p(95)<250", "p(99)<800"]);
    expect(apiThresholds()["http_req_duration{kind:write}"]).toEqual(["p(95)<400", "p(99)<800"]);
  });
});

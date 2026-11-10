import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  apiKey,
  apiKeys,
  carriesSecretKey,
  namedKeys,
} from "../../../supabase/functions/_shared/api-keys.ts";

// ADR 0168: the Edge Functions use Supabase's publishable and secret keys, and the workers take a secret key on the
// apikey header with verify_jwt off.

const functions = fileURLToPath(new URL("../../../supabase/functions/", import.meta.url));
const config = readFileSync(
  fileURLToPath(new URL("../../../supabase/config.toml", import.meta.url)),
  "utf8",
);

const SECRET = "sb_secret_defaultdefaultdefault";
const WORKERS = "sb_secret_workersworkersworkers";
const PUBLISHABLE = "sb_publishable_defaultdefault";
const LEGACY_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature";

const reader =
  (values: Record<string, string>) =>
  (name: string): string | undefined =>
    values[name];

const hosted = {
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET, workers: WORKERS }),
  SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: PUBLISHABLE }),
  SUPABASE_SERVICE_ROLE_KEY: LEGACY_JWT,
  SUPABASE_ANON_KEY: LEGACY_JWT,
  XOS_ENVIRONMENT: "production",
};

describe("namedKeys", () => {
  it("reads the keys of the kind from the platform's JSON object", () => {
    expect([...namedKeys(hosted.SUPABASE_SECRET_KEYS, "sb_secret_")]).toEqual([
      ["default", SECRET],
      ["workers", WORKERS],
    ]);
  });

  it("drops anything that is not a key of the kind, and an unreadable value has none", () => {
    expect(
      namedKeys(JSON.stringify({ a: LEGACY_JWT, b: 7, c: PUBLISHABLE }), "sb_secret_").size,
    ).toBe(0);
    expect(namedKeys("not json", "sb_secret_").size).toBe(0);
    expect(namedKeys('["sb_secret_x"]', "sb_secret_").size).toBe(0);
    expect(namedKeys(undefined, "sb_secret_").size).toBe(0);
  });
});

describe("apiKey and apiKeys", () => {
  it("use the new keys, default first, and never the legacy-named variables when they are there", () => {
    expect(apiKey("secret", reader(hosted))).toBe(SECRET);
    expect(apiKey("publishable", reader(hosted))).toBe(PUBLISHABLE);
    expect(apiKeys("secret", reader(hosted))).toEqual([SECRET, WORKERS]);
  });

  it("refuse the legacy keys in production", () => {
    const legacyOnly = reader({
      SUPABASE_SERVICE_ROLE_KEY: LEGACY_JWT,
      XOS_ENVIRONMENT: "Production",
    });
    expect(apiKeys("secret", legacyOnly)).toEqual([]);
    expect(() => apiKey("secret", legacyOnly)).toThrow("SUPABASE_SECRET_KEYS is not set");
  });

  it("fall back to the local CLI stack's legacy-named variables outside production", () => {
    const local = reader({
      SUPABASE_SERVICE_ROLE_KEY: LEGACY_JWT,
      SUPABASE_ANON_KEY: "local-anon",
    });
    expect(apiKey("secret", local)).toBe(LEGACY_JWT);
    expect(apiKey("publishable", local)).toBe("local-anon");
  });
});

describe("carriesSecretKey", () => {
  const keys = apiKeys("secret", reader(hosted));

  it("accepts any of the project's secret keys on the apikey header, or the same key as a bearer", () => {
    expect(carriesSecretKey({ apikey: WORKERS, authorization: null }, keys)).toBe(true);
    expect(carriesSecretKey({ apikey: SECRET, authorization: null }, keys)).toBe(true);
    expect(carriesSecretKey({ apikey: null, authorization: `Bearer ${SECRET}` }, keys)).toBe(true);
  });

  it("refuses the legacy service_role JWT, the publishable key, a person's session and nothing at all", () => {
    expect(
      carriesSecretKey({ apikey: LEGACY_JWT, authorization: `Bearer ${LEGACY_JWT}` }, keys),
    ).toBe(false);
    expect(carriesSecretKey({ apikey: PUBLISHABLE, authorization: null }, keys)).toBe(false);
    expect(
      carriesSecretKey({ apikey: PUBLISHABLE, authorization: "Bearer eyJ.person.jwt" }, keys),
    ).toBe(false);
    expect(carriesSecretKey({ apikey: `${SECRET}x`, authorization: null }, keys)).toBe(false);
    expect(carriesSecretKey({ apikey: null, authorization: null }, keys)).toBe(false);
    expect(carriesSecretKey({ apikey: "", authorization: "Bearer " }, [""])).toBe(false);
  });
});

describe("the functions", () => {
  const names = readdirSync(functions, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .map((d) => d.name);
  const source = (name: string) => readFileSync(`${functions}${name}/index.ts`, "utf8");
  /** Function names whose block in supabase/config.toml sets verify_jwt = false. */
  const gatewayOff = new Set(
    [
      ...config.matchAll(
        /^\[functions\.([a-z0-9-]+)\]\n(?:(?!\[)[^\n]*\n)*?verify_jwt *= *false/gm,
      ),
    ].map((m) => m[1]),
  );
  const workers = names.filter((name) =>
    /isServiceRequest\(|carriesSecretKey\(/.test(source(name)),
  );

  it("count every scheduled worker as a worker", () => {
    for (const worker of [
      "webhook-dispatch",
      "notification-dispatch",
      "upload-scan",
      "report-run",
      "import-run",
      "integration-worker",
      "subprocessor-notices",
      "automation-run",
      "search-embed",
      "export-render",
      "guest-email",
      "fx-rates-ecb",
      "weather-feed",
      "org-lifecycle",
    ]) {
      expect(workers).toContain(worker);
    }
  });

  it("run every worker with verify_jwt off, or the platform would refuse pg_cron's secret key", () => {
    expect(workers.filter((name) => !gatewayOff.has(name))).toEqual([]);
  });

  it("read the keys only through api-keys.ts, never the legacy-named variables", () => {
    expect(names.filter((name) => /SUPABASE_(SERVICE_ROLE|ANON)_KEY/.test(source(name)))).toEqual(
      [],
    );
  });
});

import { expect, test, type Page } from "./engine-test";
import { uniqueId } from "./support";

/**
 * What the B15 journeys share (RRR-239): they run against an Atlas started outside production with
 * XOS_AI_FAKE=1 (E2E_AURORA_URL), whose fixture model reads the journeys' plain-text documents
 * (apps/atlas/lib/aurora/fixture-intake.ts). The switches are turned on through the public API and
 * the demo seed's switches are restored after each file.
 */

export const AURORA_URL = process.env["E2E_AURORA_URL"] ?? "http://127.0.0.1:3016";

type Feature = "assistant" | "plain_language" | "extraction" | "drafting" | "summaries" | "mapping";
const FEATURES: readonly Feature[] = [
  "assistant",
  "plain_language",
  "extraction",
  "drafting",
  "summaries",
  "mapping",
];
export const SEEDED: readonly Feature[] = ["assistant", "extraction", "summaries"];
export const ALL = FEATURES;

export async function setSwitches(page: Page, on: readonly Feature[]) {
  const response = await page.request.post("/api/v1/ai-settings/save", {
    data: Object.fromEntries(FEATURES.map((f) => [`${f}_enabled`, on.includes(f)])),
    headers: {
      Origin: new URL(page.url()).origin,
      "Idempotency-Key": `b15-switches-${uniqueId()}`,
    },
    timeout: 120_000,
  });
  expect(response.status(), await response.text()).toBe(200);
}

export async function projectId(page: Page, key: string): Promise<string> {
  const response = await page.request.get("/api/v1/projects?limit=100&fields=id,project_key");
  const project = (
    (await response.json()) as { data: { id: string; project_key: string }[] }
  ).data.find((p) => p.project_key === key);
  test.skip(!project, `The demo seed has no project ${key}.`);
  return project?.id ?? "";
}

/** A plain-text file for an input[type=file]. */
export const textFile = (name: string, text: string) => ({
  name,
  mimeType: "text/plain",
  buffer: Buffer.from(text, "utf8"),
});

export async function post(page: Page, path: string, data: unknown) {
  const response = await page.request.post(path, {
    data,
    headers: { Origin: new URL(page.url()).origin, "Idempotency-Key": `b15-${uniqueId()}` },
  });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return (await response.json()) as Record<string, unknown>;
}

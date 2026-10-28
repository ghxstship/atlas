/**
 * Contract tests for the live link handlers (P1, ADR 0130, migrations 2780 to 2782). Requests run
 * through `contractApp` against the in-memory client and every success is checked against
 * openapi/v1.json with `expectContract`. Who may make a link, the allowlist, the hashing and the
 * lockout are the database's (pgTAP 2780 and 2781); here the RPCs answer the way the database does,
 * and refusals stand in for its rules.
 */
import { describe, expect, it } from "vitest";
import { handlers as platform } from "../src/handlers/platform.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, refusal, requests, success, tenantRow } from "./support/memory-db.ts";
import type { Row } from "./support/memory-db.ts";

const ORG = testContext().org?.id as string;
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(215000 + n).padStart(12, "0")}`;
const PROJECT = id(1);
const VIEW = id(2);
const RUN = id(3);
const LINK = id(4);
const MISSING = id(9999);
const VIEW_TOKEN = `xshv_${"ab".repeat(32)}`;
const SCREEN_TOKEN = `xscr_${"cd".repeat(32)}`;

function link(extra: Row = {}): Row {
  return tenantRow(LINK, ORG, {
    created_by: testContext().personId,
    project_id: PROJECT,
    link_kind: "View",
    saved_view_id: VIEW,
    run_of_show_id: null,
    default_mode: null,
    token_hint: "abab",
    note: "Venue screens",
    expires_at: "2026-11-27T23:59:59Z",
    failed_attempts: 0,
    open_count: 0,
    last_opened_at: null,
    rotated_at: null,
    revoked_at: null,
    revoked_by: null,
    ...extra,
  });
}

function world() {
  const rows: Row[] = [link()];
  const db = memoryDb(
    { live_links: rows },
    {
      create_view_link: (args) => {
        if (args["p_saved_view_id"] === MISSING) throw refusal("live_link_view_unsupported");
        return [
          {
            live_link_id: id(5),
            token: VIEW_TOKEN,
            access_code: "042424",
            expires_at: args["p_expires_at"],
          },
        ];
      },
      create_display_link: () => [
        {
          live_link_id: id(6),
          token: SCREEN_TOKEN,
          access_code: "135790",
          expires_at: "2026-11-02T04:00:00Z",
        },
      ],
      regenerate_live_link: () => [
        {
          token: `xshv_${"ef".repeat(32)}`,
          access_code: "246802",
          expires_at: "2026-11-27T23:59:59Z",
        },
      ],
      revoke_live_link: () => {
        Object.assign(rows[0] as Row, {
          revoked_at: "2026-10-28T10:00:00Z",
          revoked_by: testContext().personId,
        });
        return "2026-10-28T10:00:00Z";
      },
    },
  );
  return { db, http: requests(contractApp({ handlers: [platform], db })) };
}

describe("Platform: live links", () => {
  it("lists and reads links without their token or code", async () => {
    const { http } = world();
    const page = (await expectContract(
      await success(http.get(`/live-links?filter[saved_view_id][eq]=${VIEW}`)),
      "liveLinks.list",
    )) as { data: Row[] };
    expect(page.data[0]?.["token_hint"]).toBe("abab");
    expect(Object.keys(page.data[0] ?? {})).not.toContain("token_hash");
    expect(Object.keys(page.data[0] ?? {})).not.toContain("access_code_hash");
    await expectContract(await success(http.get(`/live-links/${LINK}`)), "liveLinks.get");
    expect((await http.get(`/live-links/${MISSING}`)).status).toBe(404);
  });

  it("creates a saved view link and answers its token and code once", async () => {
    const { db, http } = world();
    const response = await success(
      http.post("/live-links/view", {
        saved_view_id: VIEW,
        project_id: PROJECT,
        expires_at: "2026-11-27T23:59:59Z",
      }),
    );
    const made = (await expectContract(response, "liveLinks.createView")) as {
      token: string;
      access_code: string;
    };
    expect(made.token).toBe(VIEW_TOKEN);
    expect(made.access_code).toBe("042424");
    expect(db.calls.find((c) => c.name === "create_view_link")?.args).toEqual({
      p_saved_view_id: VIEW,
      p_project_id: PROJECT,
      p_expires_at: "2026-11-27T23:59:59Z",
    });
  });

  it("has no access code switch: every link asks for a code", async () => {
    const { db, http } = world();
    await success(
      http.post("/live-links/view", {
        saved_view_id: VIEW,
        project_id: PROJECT,
        expires_at: "2026-11-27T23:59:59Z",
        note: "Venue screens",
      }),
    );
    const args = db.calls.find((c) => c.name === "create_view_link")?.args ?? {};
    expect(Object.keys(args)).not.toContain("p_access_code_required");
    expect(args["p_note"]).toBe("Venue screens");
  });

  it("creates a display screen link, leaving the expiry to the database's default", async () => {
    const { db, http } = world();
    const response = await success(
      http.post("/live-links/display", { run_of_show_id: RUN, default_mode: "Presenter Timer" }),
    );
    const made = (await expectContract(response, "liveLinks.createDisplay")) as { token: string };
    expect(made.token).toBe(SCREEN_TOKEN);
    expect(db.calls.find((c) => c.name === "create_display_link")?.args).toEqual({
      p_run_of_show_id: RUN,
      p_default_mode: "Presenter Timer",
    });
  });

  it("answers a refusal as 422 with its rule", async () => {
    const { http } = world();
    const response = await http.post("/live-links/view", {
      saved_view_id: MISSING,
      project_id: PROJECT,
      expires_at: "2026-11-27T23:59:59Z",
    });
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("live_link_view_unsupported");
  });

  it("regenerates a link with a new token and code", async () => {
    const { http } = world();
    const fresh = (await expectContract(
      await success(http.post(`/live-links/${LINK}/regenerate`)),
      "liveLinks.regenerate",
    )) as { token: string; access_code: string };
    expect(fresh.token).toMatch(/^xshv_(ef){32}$/);
    expect(fresh.access_code).toBe("246802");
    expect((await http.post(`/live-links/${MISSING}/regenerate`)).status).toBe(404);
  });

  it("revokes a link", async () => {
    const { http } = world();
    const revoked = (await expectContract(
      await success(http.post(`/live-links/${LINK}/revoke`)),
      "liveLinks.revoke",
    )) as { revoked_at: string };
    expect(revoked.revoked_at).toBe("2026-10-28T10:00:00Z");
    expect((await http.post(`/live-links/${MISSING}/revoke`)).status).toBe(404);
  });
});

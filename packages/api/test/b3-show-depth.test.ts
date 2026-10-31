/**
 * Contract tests for B3 (ADR 0142, migrations 2920 to 2923): the segment library, its cues and calls, segment
 * copies, cue field audiences, the show channel actions on groups and showcaller links. Requests run through
 * `contractApp` against the in-memory client and every success is checked against openapi/v1.json with
 * `expectContract`. Who may do what, the version counter, placement and publishing outcomes, Client exclusion and
 * token hashing are the database's (pgTAP 2920 to 2924); here the RPCs answer as the database does.
 */
import { describe, expect, it } from "vitest";
import { handlers as platform } from "../src/handlers/platform.ts";
import { handlers as show } from "../src/handlers/show.ts";
import { handlers as workforce } from "../src/handlers/workforce.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, refusal, requests, success, tenantRow } from "./support/memory-db.ts";
import type { Row } from "./support/memory-db.ts";

const ORG = testContext().org?.id as string;
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(227000 + n).padStart(12, "0")}`;
const SEGMENT = id(1);
const LIBRARY_CUE = id(2);
const LIBRARY_CALL = id(3);
const RUN = id(4);
const INSTANCE = id(5);
const LINK = id(6);
const PROJECT = id(7);
const FIELD = id(8);
const AUDIENCE = id(9);
const MISSING = id(9999);
const TOKEN = `xscl_${"ab".repeat(32)}`;

type Page = { data: Row[] };

function world() {
  const links: Row[] = [
    tenantRow(LINK, ORG, {
      created_by: testContext().personId,
      project_id: PROJECT,
      run_of_show_id: RUN,
      caller_name: "Sam Okafor",
      note: "Night one guest caller",
      token_hint: "abab",
      expires_at: "2026-11-07T04:00:00Z",
      failed_attempts: 0,
      open_count: 1,
      last_opened_at: "2026-11-05T22:00:00Z",
      rotated_at: null,
      revoked_at: null,
      revoked_by: null,
    }),
  ];
  const db = memoryDb(
    {
      segment_library: [
        tenantRow(SEGMENT, ORG, {
          name: "Awards Block",
          description: "Three awards and the walk-off.",
          color_key: "cat-4",
          version: 3,
        }),
      ],
      segment_library_cues: [
        tenantRow(LIBRARY_CUE, ORG, {
          segment_library_id: SEGMENT,
          position: 1,
          label: "Award One",
          duration: "00:04:00",
          description: "Presenter walks on.",
          script: null,
        }),
      ],
      segment_library_cue_calls: [
        tenantRow(LIBRARY_CALL, ORG, {
          segment_library_cue_id: LIBRARY_CUE,
          call_kind: "Lighting",
          instruction: "LX 40 GO.",
        }),
      ],
      run_segment_instances: [
        tenantRow(INSTANCE, ORG, {
          run_of_show_id: RUN,
          segment_library_id: SEGMENT,
          library_version: 3,
        }),
      ],
      cue_field_audiences: [
        tenantRow(AUDIENCE, ORG, { custom_field_definition_id: FIELD, audience: "Crew" }),
      ],
      showcaller_links: links,
    },
    {
      insert_library_segment: (args) => {
        if (args["p_before_position"] === 1) throw refusal("segment_insert_before_called");
        return id(50);
      },
      publish_library_segment: (args) =>
        (args["p_run_ids"] as string[]).map((run) => ({
          run_of_show_id: run,
          segment_instance_id: run === RUN ? INSTANCE : null,
          outcome: run === RUN ? "Published" : "No Instance",
        })),
      open_show_channel: () => id(60),
      join_show_channel: () => {
        throw refusal("show_channel_client");
      },
      show_channel_status: () => [
        {
          channel_exists: true,
          conversation_id: id(60),
          am_member: true,
          can_join: false,
          can_open: false,
        },
      ],
      create_showcaller_link: (args) => {
        if (args["p_caller_name"] === "") throw refusal("showcaller_link_caller_name");
        return [
          {
            showcaller_link_id: id(70),
            token: TOKEN,
            access_code: "042424",
            expires_at: "2026-11-07T04:00:00Z",
          },
        ];
      },
      regenerate_showcaller_link: () => [
        {
          token: `xscl_${"cd".repeat(32)}`,
          access_code: "135790",
          expires_at: "2026-11-07T04:00:00Z",
        },
      ],
      revoke_showcaller_link: () => {
        Object.assign(links[0] as Row, {
          revoked_at: "2026-11-06T10:00:00Z",
          revoked_by: testContext().personId,
        });
        return "2026-11-06T10:00:00Z";
      },
      sign_out_showcaller_devices: () => 2,
    },
    // The database starts a segment's version at 1 and keeps it (2921); a library cue has no script by default.
    {
      segment_library: { version: 1, description: null },
      segment_library_cues: { duration: null, description: null, script: null },
    },
  );
  return { db, http: requests(contractApp({ handlers: [show, platform, workforce], db })) };
}

describe("Show: the segment library", () => {
  it("lists, reads, creates, updates and deletes library segments", async () => {
    const { http } = world();
    const page = (await expectContract(
      await success(http.get("/segment-library")),
      "segmentLibrary.list",
    )) as Page;
    expect(page.data[0]?.["version"]).toBe(3);
    await expectContract(
      await success(http.get(`/segment-library/${SEGMENT}`)),
      "segmentLibrary.get",
    );
    const r1 = await success(
      http.post("/segment-library", { name: "Sponsor Moment", color_key: "cat-2" }),
    );
    const made = (await expectContract(r1, "segmentLibrary.create")) as Row;
    expect(made).toMatchObject({ name: "Sponsor Moment", org_id: ORG });
    const r2 = await success(
      http.patch(`/segment-library/${SEGMENT}`, { description: "Four awards." }),
    );
    await expectContract(r2, "segmentLibrary.update");
    const gone = await http.delete(`/segment-library/${SEGMENT}`);
    expect(gone.status).toBe(204);
    await expectContract(gone, "segmentLibrary.delete");
  });

  it("copies a segment into a running order and publishes it", async () => {
    const { db, http } = world();
    const r3 = await success(
      http.post(`/segment-library/${SEGMENT}/insert-into-run`, {
        run_of_show_id: RUN,
        before_position: 3,
        starts_at: "2026-11-06T23:30:00Z",
      }),
    );
    const inserted = (await expectContract(r3, "segmentLibrary.insertIntoRun")) as Row;
    expect(inserted["segment_instance_id"]).toBe(id(50));
    expect(db.calls.find((c) => c.name === "insert_library_segment")?.args).toEqual({
      p_run_of_show_id: RUN,
      p_segment_library_id: SEGMENT,
      p_before_position: 3,
      p_starts_at: "2026-11-06T23:30:00Z",
    });
    expect(
      (
        await http.post(`/segment-library/${SEGMENT}/insert-into-run`, {
          run_of_show_id: RUN,
          before_position: 1,
        })
      ).status,
    ).toBe(422);
    const r4 = await success(
      http.post(`/segment-library/${SEGMENT}/publish`, { run_of_show_ids: [RUN, MISSING] }),
    );
    const published = (await expectContract(r4, "segmentLibrary.publish")) as Page;
    expect(published.data.map((r) => r["outcome"])).toEqual(["Published", "No Instance"]);
    expect(
      (await http.post(`/segment-library/${MISSING}/publish`, { run_of_show_ids: [RUN] })).status,
    ).toBe(404);
  });

  it("lists, reads, creates, updates and deletes library cues and their calls", async () => {
    const { http } = world();
    await expectContract(
      await success(http.get(`/segment-library-cues?filter[segment_library_id][eq]=${SEGMENT}`)),
      "segmentLibraryCues.list",
    );
    await expectContract(
      await success(http.get(`/segment-library-cues/${LIBRARY_CUE}`)),
      "segmentLibraryCues.get",
    );
    const r5 = await success(
      http.post("/segment-library-cues", {
        segment_library_id: SEGMENT,
        position: 2,
        label: "Walk-off",
      }),
    );
    await expectContract(r5, "segmentLibraryCues.create");
    const r6 = await success(
      http.patch(`/segment-library-cues/${LIBRARY_CUE}`, { label: "Award One (Gold)" }),
    );
    await expectContract(r6, "segmentLibraryCues.update");
    await expectContract(
      await http.delete(`/segment-library-cues/${LIBRARY_CUE}`),
      "segmentLibraryCues.delete",
    );

    const r7 = await success(
      http.get(`/segment-library-cue-calls?filter[segment_library_cue_id][eq]=${LIBRARY_CUE}`),
    );
    await expectContract(r7, "segmentLibraryCueCalls.list");
    await expectContract(
      await success(http.get(`/segment-library-cue-calls/${LIBRARY_CALL}`)),
      "segmentLibraryCueCalls.get",
    );
    const r8 = await success(
      http.post("/segment-library-cue-calls", {
        segment_library_cue_id: LIBRARY_CUE,
        call_kind: "Audio",
        instruction: "Presenter mic live.",
      }),
    );
    await expectContract(r8, "segmentLibraryCueCalls.create");
    const r9 = await success(
      http.patch(`/segment-library-cue-calls/${LIBRARY_CALL}`, { instruction: "LX 41 GO." }),
    );
    await expectContract(r9, "segmentLibraryCueCalls.update");
    await expectContract(
      await http.delete(`/segment-library-cue-calls/${LIBRARY_CALL}`),
      "segmentLibraryCueCalls.delete",
    );
  });

  it("lists and reads the copies of a segment", async () => {
    const { http } = world();
    const page = (await expectContract(
      await success(http.get(`/run-segment-instances?filter[run_of_show_id][eq]=${RUN}`)),
      "runSegmentInstances.list",
    )) as Page;
    expect(page.data[0]?.["library_version"]).toBe(3);
    await expectContract(
      await success(http.get(`/run-segment-instances/${INSTANCE}`)),
      "runSegmentInstances.get",
    );
  });
});

describe("Platform: cue field audiences", () => {
  it("lists, adds and removes who a cue field is for", async () => {
    const { http } = world();
    const r10 = await success(
      http.get(`/cue-field-audiences?filter[custom_field_definition_id][eq]=${FIELD}`),
    );
    await expectContract(r10, "cueFieldAudiences.list");
    const r11 = await success(
      http.post("/cue-field-audiences", {
        custom_field_definition_id: FIELD,
        audience: "Client",
      }),
    );
    const made = (await expectContract(r11, "cueFieldAudiences.create")) as Row;
    expect(made["audience"]).toBe("Client");
    await expectContract(
      await http.delete(`/cue-field-audiences/${AUDIENCE}`),
      "cueFieldAudiences.delete",
    );
  });
});

describe("Workforce: show channels", () => {
  it("opens, joins and reads a project's show channel through its RPCs", async () => {
    const { db, http } = world();
    const r12 = await success(http.post("/groups/open-show-channel", { project_id: PROJECT }));
    const opened = (await expectContract(r12, "workforceGroups.openShowChannel")) as Row;
    expect(opened["conversation_id"]).toBe(id(60));
    expect(db.calls.find((c) => c.name === "open_show_channel")?.args).toEqual({
      p_project_id: PROJECT,
      p_name_prefix: null,
      p_description: null,
    });
    await success(
      http.post("/groups/open-show-channel", {
        project_id: PROJECT,
        name_prefix: "Canal del show",
        description: "El chat del equipo.",
      }),
    );
    expect(db.calls.filter((c) => c.name === "open_show_channel")[1]?.args).toEqual({
      p_project_id: PROJECT,
      p_name_prefix: "Canal del show",
      p_description: "El chat del equipo.",
    });
    const refused = await http.post("/groups/join-show-channel", { project_id: PROJECT });
    expect(refused.status).toBe(422);
    const status = (await expectContract(
      await success(http.get(`/groups/show-channel-status?project_id=${PROJECT}`)),
      "workforceGroups.showChannelStatus",
    )) as Row;
    expect(status).toMatchObject({ channel_exists: true, am_member: true });
  });

  it("answers the conversation when joining succeeds", async () => {
    const db = memoryDb({}, { join_show_channel: () => id(61) });
    const http = requests(contractApp({ handlers: [workforce], db }));
    const r13 = await success(http.post("/groups/join-show-channel", { project_id: PROJECT }));
    const joined = (await expectContract(r13, "workforceGroups.joinShowChannel")) as Row;
    expect(joined["conversation_id"]).toBe(id(61));
  });
});

describe("Show: showcaller links", () => {
  it("lists and reads links without their token or code", async () => {
    const { http } = world();
    const page = (await expectContract(
      await success(http.get(`/showcaller-links?filter[run_of_show_id][eq]=${RUN}`)),
      "showcallerLinks.list",
    )) as Page;
    expect(page.data[0]?.["caller_name"]).toBe("Sam Okafor");
    expect(Object.keys(page.data[0] ?? {})).not.toContain("token_hash");
    expect(Object.keys(page.data[0] ?? {})).not.toContain("access_code_hash");
    await expectContract(
      await success(http.get(`/showcaller-links/${LINK}`)),
      "showcallerLinks.get",
    );
  });

  it("creates a link and answers its token and code once", async () => {
    const { db, http } = world();
    const r14 = await success(
      http.post("/showcaller-links/create", { run_of_show_id: RUN, caller_name: "Sam Okafor" }),
    );
    const made = (await expectContract(r14, "showcallerLinks.create")) as Row;
    expect(made).toMatchObject({ token: TOKEN, access_code: "042424" });
    expect(db.calls.find((c) => c.name === "create_showcaller_link")?.args).toEqual({
      p_run_of_show_id: RUN,
      p_caller_name: "Sam Okafor",
    });
    expect(
      (await http.post("/showcaller-links/create", { run_of_show_id: RUN, caller_name: "" }))
        .status,
    ).toBe(422);
  });

  it("regenerates, signs devices out and revokes", async () => {
    const { http } = world();
    const r15 = await success(http.post(`/showcaller-links/${LINK}/regenerate`, {}));
    const fresh = (await expectContract(r15, "showcallerLinks.regenerate")) as Row;
    expect(fresh["access_code"]).toBe("135790");
    const r16 = await success(http.post(`/showcaller-links/${LINK}/sign-out-devices`, {}));
    const out = (await expectContract(r16, "showcallerLinks.signOutDevices")) as Row;
    expect(out["devices"]).toBe(2);
    const r17 = await success(http.post(`/showcaller-links/${LINK}/revoke`, {}));
    const revoked = (await expectContract(r17, "showcallerLinks.revoke")) as Row;
    expect(revoked["revoked_at"]).toBe("2026-11-06T10:00:00Z");
    expect((await http.post(`/showcaller-links/${MISSING}/revoke`, {})).status).toBe(404);
  });
});

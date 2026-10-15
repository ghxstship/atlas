/**
 * A04P contract tests for Show (running orders, cues, day sheets, call sheets) and Work record
 * replans. Requests run through `contractApp` against the in-memory client; every response is
 * checked against openapi/v1.json with `expectContract`.
 */
import { describe, expect, it } from "vitest";
import { handlers as show } from "../src/handlers/show.ts";
import { handlers as work } from "../src/handlers/work.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, refusal, requests, success, tenantRow } from "./support/memory-db.ts";
import type { Row } from "./support/memory-db.ts";

const ORG = testContext().org?.id as string;
const ME = testContext().personId as string;
const PROJECT = "0192f1e2-7c3a-7b4d-9e8f-000000001001";
const RUN = "0192f1e2-7c3a-7b4d-9e8f-000000006001";
const CUE = "0192f1e2-7c3a-7b4d-9e8f-000000006101";
const DAY = "0192f1e2-7c3a-7b4d-9e8f-000000006201";
const CALL = "0192f1e2-7c3a-7b4d-9e8f-000000006301";
const REPLAN = "0192f1e2-7c3a-7b4d-9e8f-000000006401";
const RECORD = "0192f1e2-7c3a-7b4d-9e8f-000000006501";

function world() {
  const db = memoryDb(
    {
      run_of_show: [
        tenantRow(RUN, ORG, {
          project_id: PROJECT,
          scope_node_id: null,
          name: "Opening Night",
          show_date: "2027-03-12",
        }),
      ],
      cues: [
        tenantRow(CUE, ORG, {
          project_id: PROJECT,
          run_of_show_id: RUN,
          position: 1,
          label: "House To Half",
          planned_at: "2027-03-12T20:00:00.000Z",
          called_at: null,
          called_by: null,
          duration: "00:05:00",
        }),
      ],
      day_sheets: [
        tenantRow(DAY, ORG, {
          project_id: PROJECT,
          day: "2027-03-12",
          body: "Doors at 18:00.",
          published_at: null,
        }),
      ],
      call_sheets: [
        tenantRow(CALL, ORG, { project_id: PROJECT, day: "2027-03-12", published_at: null }),
      ],
      record_replans: [
        tenantRow(REPLAN, ORG, {
          record_id: RECORD,
          from_state: "Blocked",
          to_state: "Active",
          reason: "Truss arrives Thursday.",
          old_starts_at: null,
          new_starts_at: "2027-03-11T09:00:00.000Z",
          old_ends_at: null,
          new_ends_at: null,
          old_due_at: null,
          new_due_at: null,
        }),
      ],
    },
    {
      call_cue: (args, self) => {
        const cue = self.tables["cues"]?.find((c) => c["id"] === args["p_cue_id"]) as Row;
        if (cue["called_at"] !== null) throw refusal("cue_already_called");
        cue["called_at"] = "2027-03-12T20:01:00.000Z";
        cue["called_by"] = ME;
        return cue["called_at"];
      },
    },
  );
  const app = contractApp({ handlers: [show, work], db });
  return { db, http: requests(app) };
}

describe("running orders", () => {
  it("lists, reads, creates, updates and deletes", async () => {
    const { http } = world();
    const listed = await http.get("/run-of-show");
    const page = (await expectContract(await success(listed), "runsOfShow.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
    const read = await http.get(`/run-of-show/${RUN}`);
    await expectContract(await success(read), "runsOfShow.get");
    const made = await http.post("/run-of-show", {
      name: "Matinee",
      show_date: "2027-03-13",
      project_id: PROJECT,
    });
    const row = (await expectContract(await success(made), "runsOfShow.create")) as Row;
    expect(row["org_id"]).toBe(ORG);
    const changed = await http.patch(`/run-of-show/${RUN}`, { name: "Opening Night Gala" });
    const after = (await expectContract(await success(changed), "runsOfShow.update")) as Row;
    expect(after["name"]).toBe("Opening Night Gala");
    const stale = await http.patch(`/run-of-show/${RUN}`, { name: "Late" }, 'W/"MjAyMC0wMS0wMQ"');
    expect(stale.status).toBe(412);
    const removed = await http.delete(`/run-of-show/${RUN}`);
    await expectContract(await success(removed), "runsOfShow.delete");
    expect((await http.get(`/run-of-show/${RUN}`)).status).toBe(404);
  });
});

describe("cues", () => {
  it("lists, reads, adds, edits, calls and removes cues", async () => {
    const { db, http } = world();
    const listed = await http.get(`/cues?filter[run_of_show_id][eq]=${RUN}`);
    await expectContract(await success(listed), "cues.list");
    const read = await http.get(`/cues/${CUE}`);
    await expectContract(await success(read), "cues.get");
    const added = await http.post("/cues", {
      run_of_show_id: RUN,
      position: 2,
      label: "Go Lights",
      duration: "00:00:30",
    });
    const cue = (await expectContract(await success(added), "cues.create")) as Row;
    expect(cue["project_id"]).toBe(PROJECT);
    const orphan = await http.post("/cues", {
      run_of_show_id: "0192f1e2-7c3a-7b4d-9e8f-000000006999",
      position: 3,
      label: "Nowhere",
    });
    expect(orphan.status).toBe(404);
    const edited = await http.patch(`/cues/${CUE}`, { label: "House Out" });
    await expectContract(await success(edited), "cues.update");
    const fired = await http.post(`/cues/${CUE}/fire`);
    const called = (await expectContract(await success(fired), "cues.fire")) as Row;
    expect(called["called_by"]).toBe(ME);
    const again = await http.post(`/cues/${CUE}/fire`);
    expect(again.status).toBe(422);
    const removed = await http.delete(`/cues/${CUE}`);
    await expectContract(await success(removed), "cues.delete");
    expect(db.calls.map((c) => c.name)).toContain("call_cue");
  });
});

describe("day sheets and call sheets", () => {
  it("serves day sheets and publishes one", async () => {
    const { http } = world();
    const listed = await http.get("/day-sheets");
    await expectContract(await success(listed), "daySheets.list");
    const read = await http.get(`/day-sheets/${DAY}`);
    await expectContract(await success(read), "daySheets.get");
    const made = await http.post("/day-sheets", {
      day: "2027-03-13",
      body: "Load-out after the encore.",
      project_id: PROJECT,
    });
    await expectContract(await success(made), "daySheets.create");
    const edited = await http.patch(`/day-sheets/${DAY}`, { body: "Doors at 18:30." });
    await expectContract(await success(edited), "daySheets.update");
    const published = await http.post(`/day-sheets/${DAY}/publish`);
    const sheet = (await expectContract(await success(published), "daySheets.publish")) as Row;
    expect(sheet["published_at"]).not.toBeNull();
    const removed = await http.delete(`/day-sheets/${DAY}`);
    await expectContract(await success(removed), "daySheets.delete");
  });

  it("serves call sheets and publishes one", async () => {
    const { db, http } = world();
    const listed = await http.get("/call-sheets");
    await expectContract(await success(listed), "callSheets.list");
    const read = await http.get(`/call-sheets/${CALL}`);
    await expectContract(await success(read), "callSheets.get");
    const made = await http.post("/call-sheets", { day: "2027-03-13", project_id: PROJECT });
    await expectContract(await success(made), "callSheets.create");
    const edited = await http.patch(`/call-sheets/${CALL}`, { day: "2027-03-14" });
    await expectContract(await success(edited), "callSheets.update");
    const published = await http.post(`/call-sheets/${CALL}/publish`);
    await expectContract(await success(published), "callSheets.publish");
    db.fail("call_sheets", refusal("sheet_published", "A published sheet is not removed."));
    const refused = await http.delete(`/call-sheets/${CALL}`);
    expect(refused.status).toBe(422);
    const removed = await http.delete(`/call-sheets/${CALL}`);
    await expectContract(await success(removed), "callSheets.delete");
  });
});

describe("record replans", () => {
  it("lists and reads replans with the replan time", async () => {
    const { http } = world();
    const listed = await http.get(`/record-replans?filter[record_id][eq]=${RECORD}`);
    const page = (await expectContract(await success(listed), "recordReplans.list")) as {
      data: Row[];
    };
    expect(page.data[0]?.["replanned_at"]).toBe("2026-10-01T12:00:00.000Z");
    const read = await http.get(`/record-replans/${REPLAN}`);
    await expectContract(await success(read), "recordReplans.get");
  });
});

import { describe, expect, it } from "vitest";
import {
  cuePosition,
  durationSeconds,
  parseCsv,
  parseDelimited,
  parsePasted,
  plannedAt,
  playbookFieldMap,
  proposeTarget,
  rowsToCsv,
  suggestWithSources,
} from "../src/import-parse.ts";
import {
  columnSamples,
  ImportWriteError,
  markInFileDuplicates,
  runImportJobs,
  validateRow,
  type ImportDestination,
  type ImportJobKind,
  type ImportStore,
  type MappedColumn,
  type RunOfShowContext,
  type TargetLookups,
} from "../src/import-worker.ts";

/**
 * P3 (RRR-217): cues and guest list entries as import targets. The paste reader and the rundown cell readers, the
 * validation of both targets inside their destination, repeats within a file, the Playbook Run of Show sheet, and the
 * worker's order of strong-key matching and cue writes against a fake store.
 */

type Row = Record<string, unknown>;

const CUE_FIELDS = [
  { name: "position", required: false, strongKey: true },
  { name: "label", required: true, strongKey: false },
  { name: "segment", required: false, strongKey: false },
  { name: "description", required: false, strongKey: false },
  { name: "planned_at", required: false, strongKey: false },
  { name: "duration", required: false, strongKey: false },
  { name: "space_id", required: false, strongKey: false },
];

const GUEST_FIELDS = [
  { name: "guest_name", required: true, strongKey: true },
  { name: "plus_ones", required: false, strongKey: false },
  { name: "note", required: false, strongKey: false },
  { name: "scope_node_id", required: false, strongKey: false },
  { name: "counterparty_id", required: false, strongKey: false },
];

const RUN: ImportDestination = {
  runOfShow: {
    id: "ros1",
    projectId: "prj1",
    showDate: "2026-11-14",
    timeZone: "America/New_York",
    venueId: "venue1",
  },
};
const PROJECT: ImportDestination = { project: { id: "prj1" } };

function lookups(writes: Row[] = [], called: ReadonlySet<string> = new Set()): TargetLookups {
  return {
    counterpartyTypeExists: async () => false,
    jurisdictionExists: async () => false,
    vendorIdByName: async () => null,
    elementExists: async () => false,
    assetClassId: async () => null,
    venueId: async () => null,
    strongKeyMatch: async () => null,
    runOfShow: async (id) => (id === "ros1" ? (RUN.runOfShow ?? null) : null),
    spaceId: async (venue, v) =>
      venue === "venue1" && v.trim().toLowerCase() === "main stage" ? "space1" : null,
    scopeNodeId: async (project, v) => (project === "prj1" && v === "Night 1" ? "show1" : null),
    counterpartyIdByName: async (_o, v) =>
      v.trim().toLowerCase() === "harbor sound" ? "cp1" : null,
    destinationKeyMatch: async (_job, keys) =>
      keys["position"] === "1" || keys["label"] === "House to half"
        ? "cue1"
        : keys["guest_name"] === "jordan pike" && keys["scope_node_id"] === "show1"
          ? "guest1"
          : null,
    // The running order holds cue 1; the next position follows the highest cue written so far.
    nextCuePosition: async () =>
      Math.max(1, ...writes.map((w) => (typeof w["position"] === "number" ? w["position"] : 0))) +
      1,
    cueCalled: async (id) => called.has(id),
    async create(_o, target, values) {
      writes.push({ op: "create", target, ...values });
      return `new-${writes.length}`;
    },
    async update(target, id, values) {
      writes.push({ op: "update", target, id, ...values });
      return { id };
    },
  };
}

const columnsFor = (fields: readonly string[]): MappedColumn[] =>
  fields.map((fieldName, index) => ({ index, fieldName }));

describe("pasted rows", () => {
  it("reads tab-separated rows, quoted cells with line breaks, and CSV when there is no tab", () => {
    const tsv = 'Cue\tScene\tNotes\r\nQ1\t"House\nto half"\tslow\n2\tWalk-in\t\n';
    expect(parsePasted(tsv)).toEqual([
      ["Cue", "Scene", "Notes"],
      ["Q1", "House\nto half", "slow"],
      ["2", "Walk-in", ""],
    ]);
    expect(parsePasted("\n\nName,Plus\nJordan,1\n")).toEqual([
      [""],
      [""],
      ["Name", "Plus"],
      ["Jordan", "1"],
    ]);
    expect(parseDelimited("a;b\n1;2", ";")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("writes rows back as CSV that reads the same", () => {
    const rows = [
      ["Cue", "Scene"],
      ["1", 'The "Big" one, live'],
      ["2", "line\nbreak"],
    ];
    const csv = rowsToCsv(rows);
    expect(csv).toBe('Cue,Scene\r\n1,"The ""Big"" one, live"\r\n2,"line\nbreak"');
    expect(parseCsv(csv)).toEqual(rows);
  });
});

describe("rundown cells", () => {
  it("reads cue numbers as positive whole numbers", () => {
    expect(["12", "Q12", "CUE-07", "Cue 7", "q 3", "#4"].map(cuePosition)).toEqual([
      12, 12, 7, 7, 3, 4,
    ]);
    expect(["12.5", "0", "Q", "", "A12", "-3"].map(cuePosition)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("places a time on the show date in the project's zone, across zones and clock changes", () => {
    expect(plannedAt("7:30 PM", "2026-11-14", "America/New_York")).toBe("2026-11-15T00:30:00.000Z");
    expect(plannedAt("19:30", "2026-11-14", "America/New_York")).toBe("2026-11-15T00:30:00.000Z");
    expect(plannedAt("19:30", "2026-07-14", "America/New_York")).toBe("2026-07-14T23:30:00.000Z");
    expect(plannedAt("19:30:15", "2026-07-14", "Europe/Madrid")).toBe("2026-07-14T17:30:15.000Z");
    expect(plannedAt("12:05 am", "2026-11-01", "America/Los_Angeles")).toBe(
      "2026-11-01T07:05:00.000Z",
    );
    // 1 November 2026: New York falls back at 2:00, so 3:00 is already standard time.
    expect(plannedAt("3:00", "2026-11-01", "America/New_York")).toBe("2026-11-01T08:00:00.000Z");
    expect(plannedAt("2026-11-14T19:00:00-05:00", "2026-01-01", "UTC")).toBe(
      "2026-11-15T00:00:00.000Z",
    );
    expect(plannedAt("2026-11-14 19:00+0100", "2026-01-01", "UTC")).toBe(
      "2026-11-14T18:00:00.000Z",
    );
    for (const bad of ["25:00", "7:75 PM", "13:00 PM", "soon", "2026-11-14T19:00"]) {
      expect(plannedAt(bad, "2026-11-14", "America/New_York")).toBeNull();
    }
    expect(plannedAt("19:00", "2026-11-14", "Mars/Olympus")).toBeNull();
  });

  it("reads durations from minutes, m:ss and h:mm:ss, up to a day", () => {
    expect(["90", "1:30:00", "1:30", "2.5", "0", "24:00:00"].map(durationSeconds)).toEqual([
      5400, 5400, 90, 150, 0, 86_400,
    ]);
    expect(["24:00:01", "1441", "1:75", "-5", "long"].map(durationSeconds)).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  });
});

describe("cue rows", () => {
  const columns = columnsFor([
    "position",
    "label",
    "segment",
    "description",
    "planned_at",
    "duration",
    "space_id",
  ]);
  const check = (cells: string[]) =>
    validateRow("o", "cues", CUE_FIELDS, columns, { rowNumber: 2, cells }, lookups(), RUN);

  it("checks every cell inside the running order", async () => {
    const good = await check([
      "CUE-07",
      "Walk-in",
      "Act I",
      "Doors open",
      "7:30 PM",
      "90",
      "Main Stage",
    ]);
    expect(good).toMatchObject({
      state: "Valid",
      values: {
        position: 7,
        label: "Walk-in",
        segment: "Act I",
        description: "Doors open",
        planned_at: "2026-11-15T00:30:00.000Z",
        duration: "5400 seconds",
        space_id: "space1",
      },
      strongKeys: { position: "7" },
      matchName: null,
    });
    const bad = await check(["12.5", "x".repeat(201), "", "", "later", "forever", "Loading Dock"]);
    expect(bad.state).toBe("Invalid");
    expect(bad.issues.map((i) => `${i.columnIndex}:${i.issue}`)).toEqual([
      "1:too_long",
      "0:invalid_position",
      "4:invalid_time",
      "5:invalid_duration",
      "6:unknown_space",
    ]);
    expect(
      (await check(["", "", "", "y".repeat(2001), "", "", ""])).issues.map((i) => i.issue),
    ).toEqual(["required", "too_long"]);
  });

  it("keys an unnumbered cue on its label and time, and finds no space without a venue", async () => {
    const unnumbered = await check(["", "House to half", "", "", "19:00", "", ""]);
    expect(unnumbered.strongKeys).toEqual({
      label: "House to half",
      planned_at: "2026-11-15T00:00:00.000Z",
    });
    expect((await check(["", "Blackout", "", "", "", "", ""])).strongKeys).toEqual({
      label: "Blackout",
    });
    const noVenue = await validateRow(
      "o",
      "cues",
      CUE_FIELDS,
      columns,
      { rowNumber: 3, cells: ["", "Bows", "", "", "", "", "Main Stage"] },
      lookups(),
      { runOfShow: { ...(RUN.runOfShow as RunOfShowContext), venueId: null } },
    );
    expect(noVenue.issues.map((i) => i.issue)).toEqual(["unknown_space"]);
  });

  it("marks a row repeating an earlier position, or an earlier label and time, as a duplicate in the file", async () => {
    const rows = await Promise.all([
      check(["1", "A", "", "", "", "", ""]),
      check(["Q1", "B", "", "", "", "", ""]),
      check(["", "Bows", "", "", "21:00", "", ""]),
      check(["", "Bows", "", "", "9:00 PM", "", ""]),
      check(["", "Bows", "", "", "", "", ""]),
    ]);
    const marked = markInFileDuplicates("cues", columns, rows);
    expect(marked.map((m) => m.state)).toEqual(["Valid", "Invalid", "Valid", "Invalid", "Valid"]);
    expect(marked[1]?.issues).toEqual([{ columnIndex: 0, issue: "duplicate_in_file" }]);
    expect(marked[3]?.issues).toEqual([{ columnIndex: 1, issue: "duplicate_in_file" }]);
    expect(markInFileDuplicates("venues", columns, rows)).toEqual(rows);
  });
});

describe("guest rows", () => {
  const columns = columnsFor([
    "guest_name",
    "plus_ones",
    "note",
    "scope_node_id",
    "counterparty_id",
  ]);
  const check = (cells: string[]) =>
    validateRow(
      "o",
      "guest_list_entries",
      GUEST_FIELDS,
      columns,
      { rowNumber: 2, cells },
      lookups(),
      PROJECT,
    );

  it("checks plus-ones, the show and the company, and keys on the normalized name and show", async () => {
    const good = await check(["  Jordan Pike ", "2", "Side door", "Night 1", " HARBOR SOUND "]);
    expect(good).toMatchObject({
      state: "Valid",
      values: {
        guest_name: "Jordan Pike",
        plus_ones: 2,
        note: "Side door",
        scope_node_id: "show1",
        counterparty_id: "cp1",
      },
      strongKeys: { guest_name: "jordan pike", scope_node_id: "show1" },
      matchName: "Jordan Pike",
    });
    const bad = await check(["Riley", "21", "n".repeat(501), "Night 9", "Nobody Inc"]);
    expect(bad.issues.map((i) => i.issue)).toEqual([
      "too_long",
      "invalid_plus_ones",
      "unknown_show",
      "unknown_party",
    ]);
    expect((await check(["Riley", "1.5", "", "", ""])).issues.map((i) => i.issue)).toEqual([
      "invalid_plus_ones",
    ]);
    expect((await check(["Riley Chen", "", "", "", ""])).strongKeys).toEqual({
      guest_name: "riley chen",
    });
  });

  it("marks the same guest for the same show twice as a duplicate, but not for another show", async () => {
    const rows = await Promise.all([
      check(["Jordan Pike", "", "", "Night 1", ""]),
      check(["jordan pike ", "1", "", "Night 1", ""]),
      check(["Jordan Pike", "", "", "", ""]),
    ]);
    expect(markInFileDuplicates("guest_list_entries", columns, rows).map((r) => r.state)).toEqual([
      "Valid",
      "Invalid",
      "Valid",
    ]);
  });
});

describe("Run of Show sheets", () => {
  const playbook = [
    { sheet: "Run of Show", header: "RECORD ID", target: "app.cues.id" },
    { sheet: "Run of Show", header: "CUE ID", target: "app.cues.position" },
    { sheet: "Run of Show", header: "ACT", target: "app.cues.segment" },
    { sheet: "Run of Show", header: "SCENE", target: "app.cues.label" },
    { sheet: "Run of Show", header: "DESCRIPTION", target: "app.cues.description" },
    { sheet: "Run of Show", header: "START TIME", target: "app.cues.planned_at" },
    { sheet: "Run of Show", header: "DURATION (MIN)", target: "app.cues.duration" },
    { sheet: "Run of Show", header: "LOCATION ID", target: "app.cues.space_id" },
    { sheet: "Run of Show", header: "PERSONNEL ID", target: "app.cues.called_by" },
    { sheet: "Vendor Directory", header: "COMPANY", target: "app.organizations.name" },
    { sheet: "Rooms", header: "VENUE", target: "app.venues.name" },
  ];
  const fields = CUE_FIELDS.map((f) => f.name);
  const heads = [
    "CUE ID",
    "ACT",
    "SCENE",
    "DESCRIPTION",
    "START TIME",
    "DURATION (MIN)",
    "LOCATION ID",
  ];
  const targets = [
    {
      code: "venues",
      fields: ["name", "locality", "jurisdiction_id", "time_zone"],
      required: ["name", "jurisdiction_id", "time_zone"],
    },
    { code: "counterparties", fields: ["name", "counterparty_type"], required: ["name"] },
    { code: "cues", fields, required: ["label"] },
    {
      code: "guest_list_entries",
      fields: GUEST_FIELDS.map((f) => f.name),
      required: ["guest_name"],
    },
  ];
  const sheets = [
    { sheet: "Vendor Directory", entity: "app.vendors" },
    { sheet: "Run of Show", entity: "app.cues" },
  ];
  const sheet = (name: string, head: string[]) => ({ name, rows: [head, head.map(() => "x")] });

  it("suggests every Playbook column from the Playbook map", () => {
    const map = playbookFieldMap(playbook, "cues", fields);
    expect(suggestWithSources(heads, fields, new Map(), map)).toEqual(
      ["position", "segment", "label", "description", "planned_at", "duration", "space_id"].map(
        (field) => ({ field, source: "Playbook" }),
      ),
    );
  });

  it("suggests rundown and guest headers by name, a lone # as the cue number", () => {
    expect(
      suggestWithSources(["#", "Title", "Section", "Start", "Length", "Room"], fields).map(
        (s) => s.field,
      ),
    ).toEqual(["position", "label", "segment", "planned_at", "duration", "space_id"]);
    const guest = GUEST_FIELDS.map((f) => f.name);
    expect(
      suggestWithSources(
        ["Name", "Plus 1", "Access", "Night", "On list of", "Guests", "Date"],
        guest,
      ).map((s) => s.field),
    ).toEqual(["guest_name", "plus_ones", "note", "scope_node_id", "counterparty_id", null, null]);
  });

  it("proposes cues for a Run of Show sheet, and the earlier proposals stay as they were", () => {
    expect(proposeTarget(sheet("Run of Show", ["X"]), targets, sheets, playbook)).toEqual({
      targetCode: "cues",
      fromPlaybook: true,
    });
    expect(proposeTarget(sheet("Show 1", heads), targets, sheets, playbook)).toEqual({
      targetCode: "cues",
      fromPlaybook: false,
    });
    expect(proposeTarget(sheet("vendor directory", ["X"]), targets, sheets, playbook)).toEqual({
      targetCode: "counterparties",
      fromPlaybook: true,
    });
    expect(
      proposeTarget(sheet("Rooms", ["Venue", "City", "Time Zone"]), targets, sheets, playbook),
    ).toEqual({ targetCode: "venues", fromPlaybook: false });
    expect(proposeTarget(sheet("Clients", ["Customer"]), targets, sheets, playbook)).toEqual({
      targetCode: "counterparties",
      fromPlaybook: false,
    });
    expect(proposeTarget(sheet("Notes", ["Thoughts"]), targets, sheets, playbook)).toEqual({
      targetCode: null,
      fromPlaybook: false,
    });
  });
});

describe("column samples", () => {
  it("keeps the first three data rows aligned under each column", () => {
    const samples = columnSamples(
      ["c0", "c1"],
      [
        { rowNumber: 2, cells: ["1", "House"] },
        { rowNumber: 3, cells: ["2"] },
        { rowNumber: 5, cells: ["3", "z".repeat(250)] },
        { rowNumber: 6, cells: ["4", "Never"] },
      ],
    );
    expect(
      samples.map((s) => `${s.columnId}:${s.index}:${s.value.length > 20 ? "long" : s.value}`),
    ).toEqual(["c0:1:1", "c1:1:House", "c0:2:2", "c1:2:", "c0:3:3", "c1:3:long"]);
    expect(samples[5]?.value).toHaveLength(200);
  });
});

/** A cue or guest list import through detect, validate and commit, over memory. */
function memoryStore(
  csv: string,
  targetCode: "cues" | "guest_list_entries",
  called: string[] = [],
) {
  const writes: Row[] = [];
  const queue: { kind: ImportJobKind; jobId: string; subjectId: string }[] = [
    { kind: "import.detect", jobId: "q1", subjectId: "j1" },
  ];
  const job = {
    id: "j1",
    orgId: "o",
    targetCode,
    source: "CSV",
    path: "p/u.csv",
    filename: "rundown.csv",
    status: "Uploaded",
    profileId: null,
    sheetName: null as string | null,
    runOfShowId: targetCode === "cues" ? "ros1" : null,
    projectId: targetCode === "guest_list_entries" ? "prj1" : null,
  };
  const fields = targetCode === "cues" ? CUE_FIELDS : GUEST_FIELDS;
  const columns: { header: string; suggested: string | null; fieldName: string | null }[] = [];
  const samples: { columnId: string; index: number; value: string }[] = [];
  const rows: {
    id: string;
    rowNumber: number;
    state: string;
    reason: string | null;
    matchName: string | null;
    match: string | null;
    written?: Row;
  }[] = [];
  const store: ImportStore = {
    lookups: lookups(writes, new Set(called)),
    async claim(kind) {
      const mine = queue.filter((q) => q.kind === kind);
      for (const m of mine) queue.splice(queue.indexOf(m), 1);
      return mine.map((m) => ({ jobId: m.jobId, subjectId: m.subjectId }));
    },
    finishJob: async (_id, ok) => (ok ? "Succeeded" : "Failed"),
    job: async () => ({ ...job }),
    batchJob: async () => "j1",
    scanStatus: async () => "Clean",
    download: async () => new TextEncoder().encode(csv),
    targetFields: async () => fields,
    profileMapping: async () => new Map(),
    async setStatus(_id, status) {
      job.status = status;
    },
    async insertColumns(_id, _sheet, cols) {
      for (const c of cols)
        columns.push({ header: c.header, suggested: c.suggested, fieldName: null });
      return cols.map((_c, i) => `col${i}`);
    },
    async recordColumnSamples(_id, list) {
      samples.push(...list);
    },
    insertSheets: async () => {},
    async setSheet(_id, name) {
      job.sheetName = name;
    },
    playbook: async () => ({ columns: [], sheets: [] }),
    importTargets: async () => [],
    driveCredential: async () => null,
    saveUpload: async () => {},
    failImport: async () => {},
    mappedColumns: async () => columns.map((c, index) => ({ index, fieldName: c.fieldName })),
    async recordRow(input) {
      const id = `r${input.rowNumber}`;
      rows.push({
        id,
        rowNumber: input.rowNumber,
        state: input.state,
        reason: input.reason,
        matchName: input.matchName,
        match: null,
      });
      return id;
    },
    recordCellIssues: async () => {},
    async recordMatch(rowId, targetId) {
      const r = rows.find((x) => x.id === rowId);
      if (r) r.match = targetId;
    },
    validRows: async () =>
      rows
        .filter((r) => r.state === "Valid")
        .map((r) => ({ id: r.id, rowNumber: r.rowNumber, matchedId: r.match, mergeInto: null })),
    async commitWrite(input) {
      const r = rows.find((x) => x.id === input.rowId);
      if (r) r.written = { action: input.action, target: input.targetId };
    },
    async refuseRow(rowId, reason) {
      const r = rows.find((x) => x.id === rowId);
      if (r) Object.assign(r, { state: "Refused", reason });
    },
    async finishBatch() {
      job.status = "Committed";
    },
    orgSlug: async () => "northwind-live",
    notifyFinished: async () => {},
  };
  return {
    store,
    job,
    columns,
    samples,
    rows,
    writes,
    async run() {
      await runImportJobs(store, "w");
    },
    confirm() {
      for (const c of columns) c.fieldName = c.suggested;
      queue.push({ kind: "import.validate", jobId: "q2", subjectId: "j1" });
    },
    commit() {
      job.status = "Committing";
      queue.push({ kind: "import.commit", jobId: "q3", subjectId: "b1" });
    },
  };
}

describe("the worker on a rundown", () => {
  it("records samples, matches strong keys before fuzzy matching, and appends unnumbered cues after numbered ones", async () => {
    const csv = [
      "Cue,Title,Time",
      ",Preshow loop,",
      "1,House to half,",
      "Q3,Lights up,19:00",
      ",Band walk-on,",
      "Q9,Bows,22:00",
      "3,Repeat of three,",
    ].join("\n");
    const s = memoryStore(csv, "cues");
    await s.run();
    expect(s.job.status).toBe("Mapped");
    expect(s.columns.map((c) => c.suggested)).toEqual(["position", "label", "planned_at"]);
    expect(s.samples.filter((x) => x.columnId === "col1").map((x) => x.value)).toEqual([
      "Preshow loop",
      "House to half",
      "Lights up",
    ]);
    s.confirm();
    await s.run();
    expect(s.rows.map((r) => `${r.rowNumber}:${r.state}:${r.match ?? "-"}`)).toEqual([
      "2:Valid:-",
      "3:Valid:cue1",
      "4:Valid:-",
      "5:Valid:-",
      "6:Valid:-",
      "7:Invalid:-",
    ]);
    expect(s.rows.every((r) => r.matchName === null)).toBe(true);
    s.commit();
    await s.run();
    expect(
      s.writes.map((w) => `${w["op"]}:${String(w["position"] ?? w["id"])}:${String(w["label"])}`),
    ).toEqual([
      "update:cue1:House to half",
      "create:3:Lights up",
      "create:9:Bows",
      "create:10:Preshow loop",
      "create:11:Band walk-on",
    ]);
    expect(
      s.writes.filter((w) => w["op"] === "create").every((w) => w["run_of_show_id"] === "ros1"),
    ).toBe(true);
    expect(s.writes[0]).not.toHaveProperty("position");
    expect(s.job.status).toBe("Committed");
  });

  it("refuses to update a cue that was already called", async () => {
    const s = memoryStore("Cue,Title\n1,House to half\n", "cues", ["cue1"]);
    await s.run();
    s.confirm();
    await s.run();
    s.commit();
    await s.run();
    expect(s.writes).toEqual([]);
    expect(s.rows[0]).toMatchObject({ state: "Refused", reason: "This cue was already called" });
    expect(new ImportWriteError("x")).toBeInstanceOf(Error);
  });
});

describe("the worker on a guest list", () => {
  it("updates an exact match without merge review and creates the rest as Requested in the project", async () => {
    const csv = "Guest,Plus,Show\nJordan Pike,2,Night 1\nRiley Chen,0,\n";
    const s = memoryStore(csv, "guest_list_entries");
    await s.run();
    expect(s.columns.map((c) => c.suggested)).toEqual(["guest_name", "plus_ones", "scope_node_id"]);
    s.confirm();
    await s.run();
    expect(s.rows.map((r) => [r.match, r.matchName])).toEqual([
      ["guest1", null],
      [null, "Riley Chen"],
    ]);
    s.commit();
    await s.run();
    expect(s.writes).toEqual([
      { op: "update", target: "guest_list_entries", id: "guest1", plus_ones: 2 },
      {
        op: "create",
        target: "guest_list_entries",
        guest_name: "Riley Chen",
        plus_ones: 0,
        project_id: "prj1",
        entry_state: "Requested",
      },
    ]);
  });
});

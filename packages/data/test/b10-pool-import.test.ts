import { describe, expect, it } from "vitest";
import {
  markInFileDuplicates,
  runImportJobs,
  validateRow,
  type ImportDestination,
  type ImportJobRecord,
  type ImportStore,
  type MappedColumn,
  type PoolInvitationContext,
  type TargetLookups,
} from "../src/import-worker.ts";

type Row = Record<string, unknown>;

const FIELDS = [
  "email",
  "pool_name",
  "invitee_name",
  "work_phone",
  "role",
  "rate",
  "rate_currency",
  "rate_type",
  "note",
].map((name) => ({ name, required: name === "email", strongKey: name === "email" }));

const CONTEXT: PoolInvitationContext = {
  talentPoolId: "pool1",
  numberFormat: "dot-comma",
  canWriteRates: true,
  language: "en-US",
  baseCurrency: "USD",
  exponents: new Map([
    ["USD", 2],
    ["EUR", 2],
  ]),
};

function lookups(
  context: PoolInvitationContext = CONTEXT,
  existing: Readonly<Record<string, { expiresAt: string; hasRate: boolean }>> = {},
  writes: Row[] = [],
): TargetLookups {
  return {
    counterpartyTypeExists: async () => false,
    jurisdictionExists: async () => false,
    vendorIdByName: async () => null,
    elementExists: async () => false,
    assetClassId: async () => null,
    venueId: async () => null,
    strongKeyMatch: async () => null,
    runOfShow: async () => null,
    spaceId: async () => null,
    scopeNodeId: async () => null,
    counterpartyIdByName: async () => null,
    nextCuePosition: async () => 1,
    cueCalled: async () => false,
    talentPoolIdByName: async (_o, name) => (name.toLowerCase() === "riggers" ? "pool2" : null),
    roleCode: async (v) => (v.toLowerCase() === "rigger" ? "5000.51.02" : null),
    poolInvitationContext: async () => context,
    poolInvitation: async (id) => existing[id] ?? null,
    destinationKeyMatch: async (_j, keys) =>
      keys["email"] === "match@x.test" ? "inv1" : keys["email"] === "old@x.test" ? "inv2" : null,
    async create(_o, target, values) {
      writes.push({ op: "create", target, ...values });
      if (values["email"] === "said-no@x.test") {
        const { ImportWriteError } = await import("../src/import-worker.ts");
        throw new ImportWriteError("pool_invitation_declined: This address declined.");
      }
      if (values["email"] === "capped@x.test") {
        const { ImportWriteError } = await import("../src/import-worker.ts");
        throw new ImportWriteError("pool_invitation_daily_limit: This organization reached 2000.");
      }
      return `new-${String(values["email"])}`;
    },
    async update(target, id, values) {
      writes.push({ op: "update", target, id, ...values });
      const before: Row = {};
      for (const key of Object.keys(values)) before[key] = null;
      return before;
    },
  };
}

const COLUMNS: MappedColumn[] = FIELDS.map((f, index) => ({ index, fieldName: f.name }));
const DEST: ImportDestination = { pools: CONTEXT };

const row = (cells: Partial<Record<(typeof FIELDS)[number]["name"], string>>) => ({
  rowNumber: 2,
  cells: FIELDS.map((f) => cells[f.name] ?? ""),
});

const check = (cells: Parameters<typeof row>[0], dest: ImportDestination = DEST) =>
  validateRow("org", "pool_invitations", FIELDS, COLUMNS, row(cells), lookups(dest.pools), dest);

describe("validating a pool invitation row (B10)", () => {
  it("writes the values of a clean row, with no person", async () => {
    const v = await check({
      email: " Ana@X.Test ",
      invitee_name: "Ana",
      work_phone: "(305) 555-0142",
      role: "Rigger",
      rate: "1.250,50 €/día",
      note: "Good",
    });
    expect(v.state).toBe("Valid");
    expect(v.values).toEqual({
      email: "ana@x.test",
      talent_pool_id: "pool1",
      invitee_name: "Ana",
      work_phone: "+13055550142",
      role_code: "5000.51.02",
      rate_minor: 125050,
      currency_code: "EUR",
      rate_type: "Day",
      note: "Good",
    });
    expect(v.strongKeys).toEqual({ email: "ana@x.test", talent_pool_id: "pool1" });
    expect(v.matchName).toBe("Ana");
  });

  it("names every problem", async () => {
    const issues = async (cells: Parameters<typeof row>[0], dest?: ImportDestination) =>
      (await check(cells, dest)).issues.map((i) => i.issue);
    expect(await issues({ email: "nope" })).toEqual(["invalid_email"]);
    expect(await issues({ email: "a@x.test", pool_name: "Nobody" })).toEqual(["unknown_pool"]);
    expect(
      await issues({ email: "a@x.test" }, { pools: { ...CONTEXT, talentPoolId: null } }),
    ).toEqual(["pool_required"]);
    expect(await issues({ email: "a@x.test", work_phone: "12" })).toEqual(["invalid_phone"]);
    expect(await issues({ email: "a@x.test", role: "Astronaut" })).toEqual(["unknown_role"]);
    expect(await issues({ email: "a@x.test", rate: "1,5,5 €/día" })).toEqual(["invalid_rate"]);
    expect(
      await issues(
        { email: "a@x.test", rate: "$25/día" },
        { pools: { ...CONTEXT, baseCurrency: "EUR" } },
      ),
    ).toEqual(["rate_currency_required"]);
    expect(await issues({ email: "a@x.test", rate: "25" })).toEqual(["rate_type_required"]);
    expect(await issues({ email: "a@x.test", rate: "25/día", rate_type: "por hora" })).toEqual([
      "rate_type_conflict",
    ]);
    expect(
      await issues(
        { email: "a@x.test", rate: "25/día" },
        { pools: { ...CONTEXT, canWriteRates: false } },
      ),
    ).toEqual(["rate_not_permitted"]);
    expect(await issues({ rate: "" })).toContain("required");
  });

  it("names the pool from the row over the import's", async () => {
    expect(
      (await check({ email: "a@x.test", pool_name: "riggers" })).values["talent_pool_id"],
    ).toBe("pool2");
  });

  it("marks a repeat of email and pool within the file", async () => {
    const first = await check({ email: "a@x.test" });
    const other = await check({ email: "a@x.test", pool_name: "Riggers" });
    const marked = markInFileDuplicates("pool_invitations", COLUMNS, [first, first, other]);
    expect(marked.map((m) => m.state)).toEqual(["Valid", "Invalid", "Valid"]);
    expect(marked[1]?.issues.at(-1)).toEqual({ columnIndex: 0, issue: "duplicate_in_file" });
  });
});

function world(
  csv: string,
  existing: Parameters<typeof lookups>[1] = {},
  merges: Readonly<Record<number, string>> = {},
) {
  const writes: Row[] = [];
  const rows: {
    id: string;
    rowNumber: number;
    state: string;
    reason: string | null;
    match: string | null;
    written?: Row;
  }[] = [];
  const job: { -readonly [K in keyof ImportJobRecord]: ImportJobRecord[K] } = {
    id: "j1",
    orgId: "org",
    targetCode: "pool_invitations",
    source: "CSV",
    path: "p/x.csv",
    filename: "x.csv",
    status: "Mapped",
    profileId: null,
    sheetName: "x.csv",
    talentPoolId: "pool1",
    numberFormat: "dot-comma",
    createdBy: "person1",
  };
  const queue: { kind: string; jobId: string; subjectId: string }[] = [];
  const store = {
    lookups: lookups(CONTEXT, existing, writes),
    async claim(kind: string) {
      const mine = queue.filter((q) => q.kind === kind);
      for (const m of mine) queue.splice(queue.indexOf(m), 1);
      return mine.map((m) => ({ jobId: m.jobId, subjectId: m.subjectId }));
    },
    finishJob: async (_id: string, ok: boolean, error: string | null) => {
      if (!ok) throw new Error(`job failed: ${String(error)}`);
      return "Succeeded";
    },
    job: async () => ({ ...job }),
    batchJob: async () => "j1",
    scanStatus: async () => "Clean",
    download: async () => new TextEncoder().encode(csv),
    targetFields: async () => FIELDS,
    profileMapping: async () => new Map(),
    setStatus: async (_id: string, status: string) => {
      job.status = status;
    },
    insertColumns: async () => [],
    recordColumnSamples: async () => {},
    insertSheets: async () => {},
    setSheet: async () => {},
    playbook: async () => ({ columns: [], sheets: [] }),
    importTargets: async () => [],
    driveCredential: async () => null,
    saveUpload: async () => {},
    failImport: async () => {},
    mappedColumns: async () => COLUMNS,
    recordRow: async (input: { rowNumber: number; state: string; reason: string | null }) => {
      const id = `r${input.rowNumber}`;
      rows.push({
        id,
        rowNumber: input.rowNumber,
        state: input.state,
        reason: input.reason,
        match: null,
      });
      return id;
    },
    recordCellIssues: async () => {},
    recordMatch: async (rowId: string, target: string) => {
      const r = rows.find((x) => x.id === rowId);
      if (r) r.match = target;
    },
    validRows: async () =>
      rows
        .filter((r) => r.state === "Valid")
        .map((r) => ({
          id: r.id,
          rowNumber: r.rowNumber,
          matchedId: r.match,
          mergeInto: merges[r.rowNumber]
            ? { table: "app.pool_members", id: merges[r.rowNumber] as string }
            : null,
        })),
    commitWrite: async (input: {
      rowId: string;
      action: string;
      targetId: string;
      before: Row | null;
    }) => {
      const r = rows.find((x) => x.id === input.rowId);
      if (r) Object.assign(r, { state: "Written", written: input });
    },
    refuseRow: async (id: string, reason: string) => {
      const r = rows.find((x) => x.id === id);
      if (r) Object.assign(r, { state: "Refused", reason });
    },
    skipRow: async (id: string, reason: string) => {
      const r = rows.find((x) => x.id === id);
      if (r) Object.assign(r, { state: "Skipped", reason });
    },
    noteRow: async (id: string, reason: string) => {
      const r = rows.find((x) => x.id === id);
      if (r) r.reason = reason;
    },
    finishBatch: async () => {},
    orgSlug: async () => "org",
    notifyFinished: async () => {},
  } as unknown as ImportStore;
  return {
    rows,
    writes,
    async validateAndCommit() {
      queue.push({ kind: "import.validate", jobId: "q1", subjectId: "j1" });
      await runImportJobs(store, "w");
      job.status = "Committing";
      queue.push({ kind: "import.commit", jobId: "q2", subjectId: "b1" });
      await runImportJobs(store, "w");
    },
  };
}

const CSV = (lines: readonly string[]) =>
  [`email,pool_name,invitee_name,work_phone,role,rate,rate_currency,rate_type,note`, ...lines].join(
    "\n",
  );

describe("committing pool invitations (B10)", () => {
  it("creates an invitation with the creator as inviter, and writes no person", async () => {
    const w = world(CSV(["new@x.test,,Ana,,,,,,"]));
    await w.validateAndCommit();
    expect(w.writes).toEqual([
      {
        op: "create",
        target: "pool_invitations",
        email: "new@x.test",
        talent_pool_id: "pool1",
        invitee_name: "Ana",
        invited_by: "person1",
      },
    ]);
    expect(w.rows[0]?.state).toBe("Written");
  });

  it("updates a pending match without moving its expiry, so no email goes", async () => {
    const w = world(CSV(["match@x.test,,Ana,,,,,,"]), {
      inv1: { expiresAt: new Date(Date.now() + 86_400_000).toISOString(), hasRate: false },
    });
    await w.validateAndCommit();
    expect(w.writes[0]).toMatchObject({ op: "update", id: "inv1", invitee_name: "Ana" });
    expect(w.writes[0]).not.toHaveProperty("expires_at");
    expect(w.writes[0]).not.toHaveProperty("email");
  });

  it("reissues an expired match", async () => {
    const w = world(CSV(["old@x.test,,Ana,,,,,,"]), {
      inv2: { expiresAt: new Date(Date.now() - 86_400_000).toISOString(), hasRate: false },
    });
    await w.validateAndCommit();
    expect(w.writes[0]).toMatchObject({ op: "update", id: "inv2" });
    expect(w.writes[0]).toHaveProperty("expires_at");
    expect(w.rows[0]?.state).toBe("Written");
  });

  it("never reads a rate that is already there into the before image, and says so", async () => {
    const w = world(CSV(["match@x.test,,Ana,,,25/día,EUR,,"]), {
      inv1: { expiresAt: new Date(Date.now() + 86_400_000).toISOString(), hasRate: true },
    });
    await w.validateAndCommit();
    expect(w.writes[0]).not.toHaveProperty("rate_minor");
    expect((w.rows[0]?.written as { before: Row }).before).not.toHaveProperty("rate_minor");
    expect(w.rows[0]?.reason).toBe("pool_rate_kept");
  });

  it("fills a rate the invitation lacks", async () => {
    const w = world(CSV(["match@x.test,,Ana,,,25/día,EUR,,"]), {
      inv1: { expiresAt: new Date(Date.now() + 86_400_000).toISOString(), hasRate: false },
    });
    await w.validateAndCommit();
    expect(w.writes[0]).toMatchObject({ rate_minor: 2500, currency_code: "EUR", rate_type: "Day" });
  });

  it("skips a row a person decided as Merged, and never updates a pool member", async () => {
    const w = world(CSV(["new@x.test,,Ana,,,,,,"]), {}, { 2: "member1" });
    await w.validateAndCommit();
    expect(w.writes).toEqual([]);
    expect(w.rows[0]?.state).toBe("Skipped");
  });

  it("skips someone who declined, and refuses a row past the daily cap, without failing the job", async () => {
    const w = world(CSV(["said-no@x.test,,,,,,,,", "capped@x.test,,,,,,,,"]));
    await w.validateAndCommit();
    expect(w.rows.map((r) => r.state)).toEqual(["Skipped", "Refused"]);
    expect(w.rows[1]?.reason).toContain("pool_invitation_daily_limit");
  });
});

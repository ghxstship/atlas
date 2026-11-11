import type { SubjectApproval } from "@xos/data/workflow";
import { describe, expect, it } from "vitest";
import { subjectWithdrawal } from "@/components/workflow/subject-withdrawal";
import type { OrgContext } from "@/lib/shell/context";

/**
 * Who Approvals offers Withdraw to, over the real capability read with the database faked. The fake answers what the
 * read asks for, so a capability the read never asks for stays hidden, and pgTAP 6230 holds the function to answering
 * it. An allocation writer who is no rule writer sees Withdraw on an Equipment approval only on their own projects.
 */

const ME = "person-me";
const OTHER = "person-other";

function approval(overrides: Partial<SubjectApproval>): SubjectApproval {
  return {
    id: "approval-1",
    projectId: "project-a",
    state: "In Review",
    requestedBy: OTHER,
    credentialId: null,
    dockSlotId: null,
    advanceAllocationId: "allocation-1",
    ...overrides,
  } as SubjectApproval;
}

/** The signed-in person, with org-reach capabilities and what they hold per project. */
function viewer(
  held: Readonly<Record<string, readonly string[]>>,
  org: readonly string[] = [],
): OrgContext {
  const rpc = async (name: string, args: { p_project_id: string; p_capabilities: string[] }) => {
    if (name !== "my_capabilities_on_project") throw new Error(`Unexpected call ${name}`);
    const mine = held[args.p_project_id];
    if (!mine)
      return { data: null, error: { code: "XX000", message: "Down.", details: "", hint: "" } };
    return { data: args.p_capabilities.filter((c) => mine.includes(c)), error: null };
  };
  return {
    capabilities: new Set(org),
    viewer: { db: { rpc } },
    org: { id: "org-1" },
  } as unknown as OrgContext;
}

describe("Withdraw on a subject approval", () => {
  it("offers it to an allocation writer on the project they write, and not on another", async () => {
    const onA = approval({ projectId: "project-a" });
    const onB = approval({ projectId: "project-b" });
    const may = await subjectWithdrawal(
      viewer({ "project-a": ["advancing.packet.write"], "project-b": [] }),
      [onA, onB],
      ME,
    );
    expect(may(onA)).toBe(true);
    expect(may(onB)).toBe(false);
  });

  it("keeps each writer to their own subject", async () => {
    const equipment = approval({});
    const pass = approval({ advanceAllocationId: null, credentialId: "credential-1" });
    const allocationWriter = await subjectWithdrawal(
      viewer({ "project-a": ["advancing.packet.write"] }),
      [equipment, pass],
      ME,
    );
    expect(allocationWriter(pass)).toBe(false);
    const passWriter = await subjectWithdrawal(
      viewer({ "project-a": ["credentials.credential.issue"] }),
      [equipment, pass],
      ME,
    );
    expect(passWriter(equipment)).toBe(false);
    expect(passWriter(pass)).toBe(true);
  });

  it("offers it to the requester, without needing the capability", async () => {
    const mine = approval({ requestedBy: ME });
    expect((await subjectWithdrawal(viewer({}), [mine], ME))(mine)).toBe(true);
  });

  it("offers it to a rule writer on every row, and on no row past In Review", async () => {
    const open = approval({});
    const may = await subjectWithdrawal(viewer({}, ["org.approval_policies.write"]), [open], ME);
    expect(may(open)).toBe(true);
    expect(may(approval({ state: "Approved" }))).toBe(false);
  });

  it("hides it when the capability read fails", async () => {
    const open = approval({});
    expect((await subjectWithdrawal(viewer({}), [open], ME))(open)).toBe(false);
  });
});

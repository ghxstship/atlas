import { describe, expect, it } from "vitest";
import {
  createSign,
  defaultSignUrid,
  listPoLineOptions,
  listSigns,
  markSignStep,
  nextSignStep,
  signageSummary,
  updateSign,
} from "../src/signage.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

const signRow = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  project_id: "pr1",
  sign_number: 3,
  title: "Main entrance arrow",
  sign_type: "Directional",
  urid: "4000.05.02",
  message: null,
  quantity: 4,
  width_in: "24",
  height_in: 36,
  substrate: "Coroplast",
  double_sided: false,
  site_plan_pin_id: "pin1",
  location_text: null,
  printer_vendor_id: null,
  po_line_id: null,
  artwork_version_id: null,
  needed_by: null,
  ordered_at: null,
  printed_at: null,
  placed_at: null,
  placed_by: null,
  updated_at: "2026-10-01T00:00:00Z",
  deleted_at: null,
  project: { project_key: "NWL" },
  ...over,
});

describe("signage register (B1, ADR 0140 D6)", () => {
  it("lists signs with their computed state and display key", async () => {
    const { db, calls } = fakeClient({
      "from:signs": [
        okResponse([signRow(), signRow({ id: "s2", sign_number: 4, po_line_id: "l1" })]),
      ],
      "from:sign_production": [
        okResponse([
          {
            sign_id: "s1",
            production_state: "Printed",
            ordered_via_po: false,
            received: false,
            located: true,
            overdue: false,
          },
          {
            sign_id: "s2",
            production_state: "Ordered",
            ordered_via_po: true,
            received: false,
            located: false,
            overdue: true,
          },
        ]),
      ],
    });
    const signs = await listSigns(db, { orgId: "o1", projectId: "pr1" });
    expect(signs.ok && signs.data.map((s) => [s.key, s.state, s.widthIn, s.overdue])).toEqual([
      ["NWL-SGN-3", "Printed", 24, false],
      ["NWL-SGN-4", "Ordered", 24, true],
    ]);
    expect(calls[1]?.steps).toContainEqual(["in", ["sign_id", ["s1", "s2"]]]);
  });

  it("writes a sign without the printer once a line orders it, and keeps the line when none is sent", async () => {
    const { db, calls } = fakeClient({
      "from:signs": [okResponse([{ id: "s1" }]), okResponse([{ id: "s1" }])],
    });
    await createSign(db, {
      projectId: "pr1",
      title: " Menu ",
      type: "Menu",
      printerVendorId: "v1",
      poLineId: "l1",
    });
    expect(calls[0]?.steps[0]?.[1]?.[0]).toMatchObject({
      project_id: "pr1",
      title: "Menu",
      urid: "4000.05.01",
      printer_vendor_id: null,
      po_line_id: "l1",
    });
    await updateSign(db, "s1", { title: "Menu", type: "Digital", printerVendorId: "v1" });
    const patch = calls[1]?.steps[0]?.[1]?.[0] as Record<string, unknown>;
    expect(patch["printer_vendor_id"]).toBe("v1");
    expect(patch["urid"]).toBe("9000.09.01");
    expect(patch).not.toHaveProperty("po_line_id");
  });

  it("marks steps through the RPC and offers the next step", async () => {
    const { db, calls } = fakeClient({
      "rpc:mark_sign_step": [
        okResponse("s1"),
        errorResponse("XR001", "sign_ordered_by_po: x", "sign_ordered_by_po"),
      ],
    });
    await markSignStep(db, { id: "s1", step: "Printed" });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [{ p_sign_id: "s1", p_step: "Printed", p_done: true }],
    ]);
    const refused = await markSignStep(db, { id: "s1", step: "Ordered" });
    expect(refused.ok === false && refused.error.kind === "refusal" && refused.error.rule).toBe(
      "sign_ordered_by_po",
    );
    expect(nextSignStep({ state: "To Order", orderedViaPo: false })).toBe("Ordered");
    expect(nextSignStep({ state: "To Order", orderedViaPo: true })).toBe("Printed");
    expect(nextSignStep({ state: "Printed", orderedViaPo: false })).toBe("Placed");
    expect(nextSignStep({ state: "Placed", orderedViaPo: false })).toBeNull();
    expect(defaultSignUrid("Directional")).toBe("4000.05.02");
  });

  it("reads the summary and the order lines a procurement reader may link", async () => {
    const { db, calls } = fakeClient({
      "from:project_signage_summary": [
        okResponse([
          {
            project_id: "pr1",
            to_order: 2,
            ordered: 1,
            printed: 1,
            placed: 0,
            unplaced: 1,
            unlocated: 3,
            overdue: 1,
          },
        ]),
      ],
      "from:po_lines": [
        okResponse([
          {
            id: "l2",
            purchase_order_id: "po1",
            line_number: 2,
            description: "Banners",
            order: {
              po_number: "NWL-PO-1",
              vendor: { counterparty: { counterparty_name: "Harbor Print" } },
            },
          },
          {
            id: "l1",
            purchase_order_id: "po1",
            line_number: 1,
            description: "Arrows",
            order: { po_number: "NWL-PO-1", vendor: null },
          },
        ]),
      ],
    });
    const summary = await signageSummary(db, { orgId: "o1" });
    expect(summary.ok && summary.data[0]?.unlocated).toBe(3);
    const lines = await listPoLineOptions(db, "pr1");
    expect(lines.ok && lines.data.map((l) => [l.id, l.vendorName])).toEqual([
      ["l1", null],
      ["l2", "Harbor Print"],
    ]);
    expect(calls[1]?.steps).toContainEqual(["neq", ["order.po_state", "Canceled"]]);
  });
});

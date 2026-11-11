import { toDataError } from "@xos/data";
import { describe, expect, it } from "vitest";
import enFinance from "../../../packages/i18n/messages/en-US/finance.json";
import esFinance from "../../../packages/i18n/messages/es-US/finance.json";
import { fieldErrorOf } from "@/lib/finance/field-errors";

/**
 * Crawl 4.9: a repeated invoice number came back as "Someone else saved this first". The unique keys
 * on invoice numbers (0321 invoices_number_key, 1120 invoices_person_number_key) now read as a field
 * error on Invoice number, in both languages.
 */
describe("a repeated invoice number", () => {
  for (const constraint of ["invoices_number_key", "invoices_person_number_key"]) {
    it(`reads on the number field for ${constraint}`, () => {
      const error = toDataError({
        code: "23505",
        message: `duplicate key value violates unique constraint "${constraint}"`,
      });
      expect(fieldErrorOf(error)).toEqual({ field: "number", key: "numberTaken" });
    });
  }

  it("leaves other refusals to the generic feedback", () => {
    expect(fieldErrorOf(toDataError({ code: "23505", message: "dup" }))).toBeNull();
    expect(fieldErrorOf({ kind: "invalid", message: "x", field: "unitBasis" })).toBeNull();
  });

  it("has its sentence in en-US and es-US", () => {
    expect(enFinance.errors.fields.numberTaken).toMatch(/already has an invoice/);
    expect(esFinance.errors.fields.numberTaken).toMatch(/ya tiene una factura/);
  });
});

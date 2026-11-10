import { getMessages } from "@xos/i18n";
import { describe, expect, it } from "vitest";

/**
 * What Compass says around an incident report and a failed inspection (launch flags, 2026-11-06). XOS is not an emergency
 * service: the wording says to call first, holds outside the US ("emergency number", never 911), and an offline report
 * says it has not been sent. A failed inspection never implies XOS blocked or tracked the unit.
 */
type Tree = { readonly [key: string]: string | Tree };
const compass = (locale: "en-US" | "es-US") =>
  (getMessages(locale) as unknown as Record<string, Tree>)["compass"] as Tree;
const incidents = (locale: "en-US" | "es-US") => compass(locale)["incidents"] as Tree;
const inspections = (locale: "en-US" | "es-US") => compass(locale)["inspections"] as Tree;

describe("Compass safety wording", () => {
  it("tells people to call first and that XOS does not alert emergency services", () => {
    expect(incidents("en-US")["emergencyFirst"]).toMatch(/call your local emergency number first/);
    expect(incidents("en-US")["emergencyFirst"]).toMatch(/does not alert emergency services/);
    expect(incidents("es-US")["emergencyFirst"]).toMatch(/número local de emergencias/);
    expect(incidents("es-US")["emergencyFirst"]).toMatch(/no avisa a los servicios de emergencia/);
  });

  it("says an offline report has not been sent, and to call now", () => {
    expect(incidents("en-US")["queued"]).toMatch(/not sent/);
    expect(incidents("en-US")["queued"]).toMatch(/call your local emergency number now/);
    expect(incidents("es-US")["queued"]).toMatch(/no enviado/);
    expect(incidents("es-US")["queued"]).toMatch(/llama ahora/);
  });

  it("never names one country's number", () => {
    for (const locale of ["en-US", "es-US"] as const) {
      expect(JSON.stringify(incidents(locale))).not.toMatch(/\b911\b/);
    }
  });

  it("says how to log a near miss so it can be found", () => {
    expect(incidents("en-US")["nearMiss"]).toMatch(/Level 5 - Advisory/);
    expect(incidents("en-US")["nearMiss"]).toMatch(/Near miss/);
    expect(incidents("es-US")["nearMiss"]).toMatch(/Level 5 - Advisory/);
    // One marker in every language, in the field as it is labelled, so a mixed crew's reports are found by one search.
    expect(incidents("es-US")["nearMiss"]).toMatch(/Near miss/);
    for (const locale of ["en-US", "es-US"] as const) {
      expect(incidents(locale)["nearMiss"]).toContain(String(incidents(locale)["titleLabel"]));
    }
  });

  it("does not imply XOS took a failed unit out of service", () => {
    expect(inspections("en-US")["criticalFailures"]).not.toMatch(/Stop use until/);
    expect(inspections("en-US")["criticalFailures"]).toMatch(/out of use/);
    expect(inspections("en-US")["criticalFailures"]).toMatch(/tell your supervisor/);
    expect(inspections("en-US")["criticalFailures"]).toMatch(/not blocked or tracked/);
    expect(inspections("es-US")["criticalFailures"]).toMatch(/Saca el elemento de uso/);
  });
});

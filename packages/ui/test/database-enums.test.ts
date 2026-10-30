// @vitest-environment node
import { databaseEnums } from "@xos/config/database-enums";
import { describe, expect, it } from "vitest";
import type { ServiceWorkerConfig } from "../src/pwa/service-worker.ts";

/**
 * The design system sits below @xos/data and cannot read its Constants (ADR 0123). Its copies of
 * database enum values are held here to the same values as their enums, in any order. A Record over
 * a union type must name each member once, so its keys are the union's members.
 */
const apps: Record<ServiceWorkerConfig["app"], true> = { Atlas: true, Gateway: true };

describe("lists that mirror a database enum", () => {
  it("app.shortcut_shell", () => {
    expect(Object.keys(apps).sort()).toEqual(
      [...(databaseEnums()["app.shortcut_shell"] ?? [])].sort(),
    );
  });
});

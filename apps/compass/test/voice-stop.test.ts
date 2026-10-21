import { readFileSync } from "node:fs";
import { getMessages } from "@xos/i18n";
import { describe, expect, it } from "vitest";
import { keepVoiceNote, VOICE_STOP_TIMEOUT_MS, voiceStopOutcome } from "../src/domain/incidents";

describe("A66: a slow save is not a microphone that never started", () => {
  it("keeps 'did not start' for a recorder that never recorded, and gives a slow stop its own outcome", () => {
    const note = keepVoiceNote("file:///n.m4a", 2_000, "2026-10-20T12:00:00Z", () => "vn-1");
    expect(voiceStopOutcome({ started: false, stopped: false, note: null })).toBe("didNotStart");
    expect(voiceStopOutcome({ started: true, stopped: false, note: null })).toBe("didNotSave");
    expect(voiceStopOutcome({ started: true, stopped: true, note: null })).toBe("tooShort");
    expect(voiceStopOutcome({ started: true, stopped: true, note })).toBe("kept");
    expect(VOICE_STOP_TIMEOUT_MS).toBeGreaterThan(3_000);
  });

  it("says why in both languages, and the screen uses the outcome", () => {
    for (const locale of ["en-US", "es-US"] as const) {
      const voice = (
        getMessages(locale) as unknown as {
          compass: { incidents: { voice: Record<string, string> } };
        }
      ).compass.incidents.voice;
      expect(typeof voice["didNotSave"]).toBe("string");
      expect(voice["didNotSave"]).not.toBe(voice["micDidNotStart"]);
    }
    expect(
      (
        getMessages("en-US") as unknown as {
          compass: { incidents: { voice: Record<string, string> } };
        }
      ).compass.incidents.voice["didNotSave"],
    ).toBe("The recording did not finish saving. Try again.");
    const screen = readFileSync(new URL("../src/screens/VoiceNotes.tsx", import.meta.url), "utf8");
    expect(screen).toContain('t("compass.incidents.voice.didNotSave")');
    expect(screen).toContain("VOICE_STOP_TIMEOUT_MS");
    expect(screen).not.toContain("STOP_TIMEOUT_MS = 3_000");
  });
});

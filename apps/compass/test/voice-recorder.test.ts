import { describe, expect, it, vi } from "vitest";
import { refuseTestOnlySwitches } from "../app.config";
import { keepVoiceNote } from "../src/domain/incidents";

// The device recorder's hooks come from expo-audio, a native module; the tests only need to see which
// hook the bundle picked.
vi.mock("expo-audio", () => ({
  RecordingPresets: { HIGH_QUALITY: {} },
  useAudioRecorder: vi.fn(),
  useAudioRecorderState: vi.fn(),
}));
vi.mock("expo-image-manipulator", () => ({ ImageManipulator: {}, SaveFormat: {} }));

const { FakeVoiceRecorder, SILENT_M4A_URI, fakeRecorderRequested, useVoiceRecorder } =
  await import("../src/runtime/voiceRecorder");
const { readLocalFile } = await import("../src/runtime/media");

describe("voice-note recorder (A66)", () => {
  it("records from the microphone unless the build asks for the fake", () => {
    expect(fakeRecorderRequested({})).toBe(false);
    expect(fakeRecorderRequested({ EXPO_PUBLIC_XOS_FAKE_RECORDER: "0" })).toBe(false);
    expect(fakeRecorderRequested({ EXPO_PUBLIC_XOS_FAKE_RECORDER: "true" })).toBe(false);
    expect(fakeRecorderRequested({ EXPO_PUBLIC_XOS_FAKE_RECORDER: "1" })).toBe(true);
    // This test run sets no flag, so the bundle uses the device recorder.
    expect(useVoiceRecorder.name).toBe("useDeviceRecorder");
  });

  it("refuses the fake recorder in an EAS build, which may reach people", () => {
    expect(() =>
      refuseTestOnlySwitches({ EXPO_PUBLIC_XOS_FAKE_RECORDER: "1", EAS_BUILD: "true" }),
    ).toThrow(/Maestro builds only/);
    expect(() => refuseTestOnlySwitches({ EXPO_PUBLIC_XOS_FAKE_RECORDER: "1" })).not.toThrow();
    expect(() => refuseTestOnlySwitches({ EAS_BUILD: "true" })).not.toThrow();
  });

  it("keeps time like a recorder and leaves a silent AAC file a voice note keeps", async () => {
    let now = 1_000;
    const recorder = new FakeVoiceRecorder(() => now);
    await recorder.prepareToRecordAsync();
    expect(recorder.isRecording).toBe(false);
    expect(recorder.uri).toBeNull();
    recorder.record();
    now += 2_400;
    expect(recorder.isRecording).toBe(true);
    expect(recorder.currentTime).toBeCloseTo(2.4);
    await recorder.stop();
    now += 5_000;
    expect(recorder.isRecording).toBe(false);
    expect(recorder.durationMillis).toBe(2_400);
    expect(recorder.uri).toBe(SILENT_M4A_URI);
    const note = keepVoiceNote(recorder.uri, recorder.currentTime * 1000, "2026-10-20T12:00:00Z");
    expect(note?.durationMs).toBe(2_400);
    // A stop with nothing recording leaves no file, as the device recorder does.
    await recorder.prepareToRecordAsync();
    await recorder.stop();
    expect(recorder.uri).toBeNull();
  });

  it("uploads the fake note as audio/mp4 bytes of an MPEG-4 file", async () => {
    const { body, contentType } = await readLocalFile("org/incidents/i/n.m4a", SILENT_M4A_URI);
    expect(contentType).toBe("audio/mp4");
    const bytes = new Uint8Array(body);
    expect(String.fromCharCode(...bytes.slice(4, 8))).toBe("ftyp");
    expect(String.fromCharCode(...bytes.slice(8, 11))).toBe("M4A");
  });
});

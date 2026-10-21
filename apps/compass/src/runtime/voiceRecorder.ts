/**
 * The recorder behind incident voice notes (SIM-003, journey 54). Every build records from the device's
 * microphone through expo-audio (ADR 0001), except a Maestro test build made with
 * EXPO_PUBLIC_XOS_FAKE_RECORDER=1 (A66, RRR-111): an iOS simulator records from the Mac's current input,
 * and a CI runner or a closed laptop has none, so the hold to record could never start there. The fake
 * keeps time like a recorder and leaves a short silent AAC file, so the flow still walks hold, release,
 * play back, delete and upload. app.config.ts refuses the flag in a production build, and the screen
 * code is the same either way: only the hook below changes, chosen once when the bundle loads.
 */
import { RecordingPresets, useAudioRecorder, useAudioRecorderState } from "expo-audio";
import { useEffect, useMemo, useState } from "react";

/** The part of expo-audio's AudioRecorder the voice notes use. */
export interface VoiceRecorder {
  readonly isRecording: boolean;
  /** Seconds recorded so far. */
  readonly currentTime: number;
  /** The finished recording, once stopped. */
  readonly uri: string | null;
  prepareToRecordAsync(): Promise<void>;
  record(): void;
  stop(): Promise<void>;
}

/** The part of expo-audio's RecorderState the record button shows. */
export interface VoiceRecorderState {
  readonly isRecording: boolean;
  readonly durationMillis: number;
}

/** Whether this bundle was built as a Maestro test build with the fake recorder. */
export function fakeRecorderRequested(env: Readonly<Record<string, string | undefined>>): boolean {
  return env["EXPO_PUBLIC_XOS_FAKE_RECORDER"] === "1";
}

/**
 * A quarter second of silence as AAC in an MPEG-4 audio file (8 kHz mono, made with afconvert). The
 * field-media bucket takes it as audio/mp4, like a recorded note.
 */
export const SILENT_M4A_BASE64 =
  "AAAAHGZ0eXBNNEEgAAAAAE00QSBtcDQyaXNvbQAAA1Ztb292AAAAbG12aGQAAAAA5v0PU+b9D1MAAB9AAAAUAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAB6HRyYWsAAABcdGtoZAAAAAfm/Q9T5v0PUwAAAAEAAAAAAAAUAAAAAAAAAAAAAAAAAAEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAYRtZGlhAAAAIG1kaGQAAAAA5v0PU+b9D1MAAB9AAAAUAAAAAAAAAAAiaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAAAAAAABOm1pbmYAAAAQc21oZAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAA/nN0YmwAAAB2c3RzZAAAAAAAAAABAAAAZm1wNGEAAAAAAAAAAQAAAAAAAAAAAAIAEAAAAAAfQAAAAAAAM2VzZHMAAAAAA4CAgCIAAAAEgICAFEAUABgAAAAAgAAAPoAFgICAAhWIBoCAgAECAAAAD3NidGQAAAAASTE2AAAAGHN0dHMAAAAAAAAAAQAAAAUAAAQAAAAAKHN0c2MAAAAAAAAAAgAAAAEAAAAEAAAAAQAAAAIAAAABAAAAAQAAAChzdHN6AAAAAAAAAAAAAAAFAAAABAAAAAQAAAAEAAAABAAAAAQAAAAYc3RjbwAAAAAAAAACAAADegAAA4oAAAD6dWR0YQAAAPJtZXRhAAAAAAAAACJoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAAADEaWxzdAAAALwtLS0tAAAAHG1lYW4AAAAAY29tLmFwcGxlLmlUdW5lcwAAABRuYW1lAAAAAGlUdW5TTVBCAAAAhGRhdGEAAAABAAAAACAwMDAwMDAwMCAwMDAwMDg0MCAwMDAwMDNDMCAwMDAwMDAwMDAwMDAwODAwIDAwMDAwMDAwIDAwMDAwMDAwIDAwMDAwMDAwIDAwMDAwMDAwIDAwMDAwMDAwIDAwMDAwMDAwIDAwMDAwMDAwIDAwMDAwMDAwAAAAHG1kYXQA0AAHANAABwDQAAcA0AAHANAABw==";

export const SILENT_M4A_URI = `data:audio/mp4;base64,${SILENT_M4A_BASE64}`;

/**
 * A recorder that records nothing: it starts and stops on command, counts the time between from the
 * clock it is given, and leaves SILENT_M4A_URI as its file.
 */
export class FakeVoiceRecorder implements VoiceRecorder {
  #startedAt: number | null = null;
  #stoppedAfterMs = 0;
  #uri: string | null = null;
  readonly #now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  get isRecording(): boolean {
    return this.#startedAt !== null;
  }

  get currentTime(): number {
    return this.durationMillis / 1000;
  }

  get durationMillis(): number {
    return this.#startedAt === null ? this.#stoppedAfterMs : this.#now() - this.#startedAt;
  }

  get uri(): string | null {
    return this.#uri;
  }

  prepareToRecordAsync(): Promise<void> {
    this.#uri = null;
    this.#stoppedAfterMs = 0;
    return Promise.resolve();
  }

  record(): void {
    if (this.#startedAt === null) this.#startedAt = this.#now();
  }

  stop(): Promise<void> {
    if (this.#startedAt !== null) {
      this.#stoppedAfterMs = this.#now() - this.#startedAt;
      this.#startedAt = null;
      this.#uri = SILENT_M4A_URI;
    }
    return Promise.resolve();
  }
}

function useDeviceRecorder(): { recorder: VoiceRecorder; state: VoiceRecorderState } {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const state = useAudioRecorderState(recorder, 250);
  return { recorder, state };
}

function useFakeRecorder(): { recorder: VoiceRecorder; state: VoiceRecorderState } {
  const recorder = useMemo(() => new FakeVoiceRecorder(), []);
  const [state, setState] = useState<VoiceRecorderState>({ isRecording: false, durationMillis: 0 });
  useEffect(() => {
    const timer = setInterval(() => {
      setState((last) =>
        last.isRecording === recorder.isRecording && last.durationMillis === recorder.durationMillis
          ? last
          : { isRecording: recorder.isRecording, durationMillis: recorder.durationMillis },
      );
    }, 250);
    return () => clearInterval(timer);
  }, [recorder]);
  return { recorder, state };
}

/** The voice-note recorder and its state for the record button, polled every 250 ms. */
// Read as process.env.EXPO_PUBLIC_..., which Expo inlines into the bundle at build time.
export const useVoiceRecorder = fakeRecorderRequested({
  EXPO_PUBLIC_XOS_FAKE_RECORDER: process.env["EXPO_PUBLIC_XOS_FAKE_RECORDER"],
})
  ? useFakeRecorder
  : useDeviceRecorder;

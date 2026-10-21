/**
 * The clock Live Activity native module (SIM-005), which also feeds the home screen widgets (A65-011 part 4).
 * Absent on Android, on iOS before 16.2 and in tests, so callers get null and keep the in-app Live Activity
 * card as the fallback.
 */
import { requireOptionalNativeModule } from "expo";

export interface ClockLabels {
  readonly projectName: string;
  readonly onShift: string;
  readonly onBreak: string;
  readonly since: string;
  readonly worked: string;
  readonly startBreak: string;
  readonly endBreak: string;
  readonly clockOut: string;
  /** "Next cue", beside the shift timer (A65-011 part 4). */
  readonly nextCue: string;
}

export interface ClockContent {
  /** "cue": clocked out, showing only the next cue. */
  readonly state: "on" | "break" | "cue";
  readonly onShiftSince: number;
  readonly segmentStart: number;
  readonly workedBaseSeconds: number;
  readonly breakSince: number | null;
  readonly nextCueLabel?: string;
  readonly nextCueAt?: number;
}

export interface QueuedPunchRecord {
  readonly id: string;
  readonly kind: string;
  readonly at: number;
  readonly context: string;
}

export interface CompassLiveActivityModule {
  isSupported(): boolean;
  start(labels: ClockLabels, content: ClockContent, context: string): Promise<string | null>;
  update(content: ClockContent): Promise<void>;
  end(): Promise<void>;
  /** Stores the Clock In App Shortcut's payload (JSON of ClockInPrepared); "" clears it. */
  prepareClockIn(json: string): void;
  peekQueue(): QueuedPunchRecord[];
  ackQueue(ids: readonly string[]): void;
  /** Writes the home screen widgets' JSON (src/domain/glance.ts widgetPayload) and reloads them; "" clears. */
  setWidgetData(json: string): void;
  addListener(event: "onPunchQueued", listener: () => void): { remove(): void };
}

export const CompassLiveActivity =
  requireOptionalNativeModule<CompassLiveActivityModule>("CompassLiveActivity");

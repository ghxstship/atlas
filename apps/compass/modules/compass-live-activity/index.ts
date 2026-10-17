/**
 * The clock Live Activity native module (SIM-005). Absent on Android, on iOS before 16.2 and in tests, so
 * callers get null and keep the in-app Live Activity card as the fallback.
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
}

export interface ClockContent {
  readonly state: "on" | "break";
  readonly onShiftSince: number;
  readonly segmentStart: number;
  readonly workedBaseSeconds: number;
  readonly breakSince: number | null;
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
  addListener(event: "onPunchQueued", listener: () => void): { remove(): void };
}

export const CompassLiveActivity =
  requireOptionalNativeModule<CompassLiveActivityModule>("CompassLiveActivity");

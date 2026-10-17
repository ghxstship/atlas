/**
 * The iOS Live Activity for the clock (SIM-005, journey 52; Section 11.13 Clock: "The Live Activity has
 * Break and Clock Out buttons"). Pure functions: what the activity shows for a clock snapshot, and how a
 * punch made on the lock screen or in the Dynamic Island becomes the same app.record_punch mutation an
 * in-app punch queues.
 *
 * The lock screen buttons run an App Intent in the app's process. It appends the punch to a queue in the
 * shared App Group and updates the activity at once, so the person sees the new state without opening
 * Compass. The app drains that queue into the sync outbox when it next runs, keyed by the punch id the
 * intent minted, so a drain that repeats after a crash replays the same punch and the server stores it once.
 */
import type { EventTime, MutationInput } from "@xos/sync";
import { buildPunch, type ClockSnapshot, type PunchContext, type PunchKind } from "./clock";

/** What the activity shows; times are epoch milliseconds. Mirrors ClockActivityAttributes.ContentState. */
export interface ActivityContent {
  readonly state: "on" | "break";
  /** When the open entry began (clock in). */
  readonly onShiftSince: number;
  /** When the current worked segment began; the running timer counts from here plus workedBaseSeconds. */
  readonly segmentStart: number;
  /** Worked seconds before the current segment (or before the running break). */
  readonly workedBaseSeconds: number;
  /** When the running break began; null while working. */
  readonly breakSince: number | null;
}

/** The activity content for a snapshot, or null when clocked out (no activity). */
export function activityContent(snapshot: ClockSnapshot, nowMs: number): ActivityContent | null {
  if (snapshot.state === "out" || snapshot.onSince === null) return null;
  if (snapshot.state === "break" && snapshot.breakSince !== null) {
    const worked = snapshot.breakSince - snapshot.onSince - snapshot.breakMs;
    return {
      state: "break",
      onShiftSince: snapshot.onSince,
      segmentStart: snapshot.breakSince,
      workedBaseSeconds: Math.max(0, Math.floor(worked / 1000)),
      breakSince: snapshot.breakSince,
    };
  }
  // Working: worked time is now - onSince - breakMs, so a timer counting up from onSince + breakMs reads it
  // exactly, with breaks folded into its start; the widget needs one date and no base.
  return {
    state: "on",
    onShiftSince: snapshot.onSince,
    segmentStart: Math.min(nowMs, snapshot.onSince + snapshot.breakMs),
    workedBaseSeconds: 0,
    breakSince: null,
  };
}

/** True when the activity on screen must change to show the next content. */
export function activityChanged(
  prev: ActivityContent | null,
  next: ActivityContent | null,
): boolean {
  if (prev === null || next === null) return prev !== next;
  return (
    prev.state !== next.state ||
    prev.onShiftSince !== next.onShiftSince ||
    prev.breakSince !== next.breakSince ||
    prev.workedBaseSeconds !== next.workedBaseSeconds
  );
}

/** A punch the App Intent queued in the App Group. */
export interface QueuedPunch {
  /** UUIDv7 the intent minted; becomes the punch id, so a repeated drain replays rather than duplicates. */
  readonly id: string;
  readonly kind: PunchKind;
  /** When the button was pressed, epoch milliseconds. */
  readonly at: number;
  /** The punch context the app stored when it started the activity, as JSON. */
  readonly context: string;
}

const KINDS: readonly PunchKind[] = ["In", "Break Start", "Break End", "Out"];

/** Parses the stored context, or null when it is missing or malformed. */
export function parseContext(raw: string): PunchContext | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const projectId = value["projectId"];
    const membershipId = value["membershipId"] ?? null;
    const engagementId = value["engagementId"] ?? null;
    if (typeof projectId !== "string") return null;
    if ((membershipId === null) === (engagementId === null)) return null;
    return {
      projectId,
      shiftId: typeof value["shiftId"] === "string" ? value["shiftId"] : null,
      membershipId: typeof membershipId === "string" ? membershipId : null,
      engagementId: typeof engagementId === "string" ? engagementId : null,
      source: "Mobile",
    };
  } catch {
    return null;
  }
}

export function serializeContext(ctx: PunchContext): string {
  return JSON.stringify({
    projectId: ctx.projectId,
    shiftId: ctx.shiftId,
    membershipId: ctx.membershipId,
    engagementId: ctx.engagementId,
  });
}

/**
 * The record_punch mutation for a lock screen punch. Device time is the press; the monotonic reading is
 * placed so the uploader computes the punch's real age from this JS session's clock. No location fix exists
 * off-app, so the server's own geofence check decides as it does for any punch without one.
 */
export function queuedPunchMutation(
  item: QueuedPunch,
  clock: {
    readonly wallNow: () => number;
    readonly monotonicNow: () => number;
    readonly bootId: () => string;
  },
): MutationInput | null {
  const ctx = parseContext(item.context);
  if (!ctx || !KINDS.includes(item.kind) || !Number.isFinite(item.at)) return null;
  const age = Math.max(0, clock.wallNow() - item.at);
  const event: EventTime = {
    deviceAt: new Date(item.at).toISOString(),
    monotonicOffsetMs: null,
    anchorServerAt: null,
    estimatedServerAt: null,
    skewMs: null,
    monotonicAt: clock.monotonicNow() - age,
    bootId: clock.bootId(),
  };
  return buildPunch(item.kind, ctx, event, null, [], item.at, () => item.id);
}

/** The activity labels, as ClockLabels in the native module. */
export interface ClockInLabels {
  readonly projectName: string;
  readonly onShift: string;
  readonly onBreak: string;
  readonly since: string;
  readonly worked: string;
  readonly startBreak: string;
  readonly endBreak: string;
  readonly clockOut: string;
}

/**
 * What the Clock In App Shortcut needs for the next clock in (Section 11.13; ClockInIntent.swift's
 * ClockInPrepared): the punch context, the labels its Live Activity shows and its two replies, already in
 * the person's language. Null while clocked in or before Today knows the context, so a stale shortcut never
 * punches against yesterday's shift.
 */
export function clockInPayload(
  snapshot: ClockSnapshot,
  context: PunchContext | null,
  labels: ClockInLabels,
  replies: { readonly clockedIn: string; readonly alreadyIn: string },
): string | null {
  if (snapshot.state !== "out" || context === null) return null;
  return JSON.stringify({
    context: serializeContext(context),
    labels,
    clockedIn: replies.clockedIn,
    alreadyIn: replies.alreadyIn,
  });
}

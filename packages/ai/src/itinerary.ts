/**
 * The checks of an itinerary intake (B15, parity gap G-59): proposed segments become instants in
 * their zones and are flagged for the person to look at. Deterministic code, never the model: the
 * server runs it on the extraction and the Atlas panel runs it again on every edit. No zod and no
 * model code, so the panel can import it. packages/ai has no database, so the active airport codes
 * are an argument.
 */
import { zonedInstant } from "./lists.ts";

/** One proposed segment as the checks read it, with the local times as printed. */
export interface ItineraryLine {
  readonly passengerName: string | null;
  readonly travelMode: string | null;
  readonly serviceIdentifier: string | null;
  readonly departsFrom: string | null;
  /** YYYY-MM-DDTHH:MM, or null. */
  readonly departsLocal: string | null;
  readonly departsTimeZone: string | null;
  readonly arrivesAtPlace: string | null;
  readonly arrivesLocal: string | null;
  readonly arrivesTimeZone: string | null;
}

/** Instants of a segment, ISO 8601 UTC, or null when the time or the zone is unread. */
export interface SegmentInstants {
  readonly departsAt: string | null;
  readonly arrivesAt: string | null;
}

export type ItineraryFlagType =
  | "arrival_before_departure"
  | "unknown_airport"
  | "duplicate_in_batch"
  | "inferred_zone"
  | "inferred_year";

export interface ItineraryFlag {
  readonly type: ItineraryFlagType;
  /** Position of the line in the batch, 0-based. */
  readonly line: number;
}

/** The instant a local YYYY-MM-DDTHH:MM names in a zone, through P6's zonedInstant. */
export function localInstant(local: string | null, zone: string | null): string | null {
  if (!local || !zone) return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(local);
  if (!match) return null;
  try {
    return zonedInstant(match[1] as string, match[2] as string, zone);
  } catch {
    return null;
  }
}

/**
 * The instants of each line: its own zones, or the fallbacks (the zone the person set for the whole
 * batch) when the line's zone is unread.
 */
export function toSegments(
  lines: readonly ItineraryLine[],
  fallbacks: {
    readonly departsTimeZone?: string | null;
    readonly arrivesTimeZone?: string | null;
  } = {},
): SegmentInstants[] {
  return lines.map((line) => ({
    departsAt: localInstant(
      line.departsLocal,
      line.departsTimeZone ?? fallbacks.departsTimeZone ?? null,
    ),
    arrivesAt: localInstant(
      line.arrivesLocal,
      line.arrivesTimeZone ?? fallbacks.arrivesTimeZone ?? null,
    ),
  }));
}

/** The three-letter capitals of a place, the IATA codes it may name ("MIA Terminal D" names MIA). */
export function airportCodes(place: string | null): string[] {
  return place ? [...place.matchAll(/\b[A-Z]{3}\b/g)].map((m) => m[0]) : [];
}

const fold = (text: string | null) =>
  (text ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Flags in line order: an arrival before its departure; a Flight whose departure or arrival place
 * names no active airport code (`airports`, from app.airports); a line repeating the passenger,
 * service and departure of an earlier one; every line with a zone, since a zone is read from the
 * place rather than printed (inferred_zone); and the lines whose year came from elsewhere in the
 * document (`inferredYear`, from the extraction).
 */
export function checkItinerary(
  lines: readonly ItineraryLine[],
  airports: ReadonlySet<string>,
  options: {
    readonly instants?: readonly SegmentInstants[];
    readonly inferredYear?: readonly number[];
  } = {},
): ItineraryFlag[] {
  const instants = options.instants ?? toSegments(lines);
  const flags: ItineraryFlag[] = [];
  const seen = new Set<string>();
  lines.forEach((line, i) => {
    const at = instants[i];
    if (at?.departsAt && at.arrivesAt && Date.parse(at.arrivesAt) < Date.parse(at.departsAt)) {
      flags.push({ type: "arrival_before_departure", line: i });
    }
    if (line.travelMode === "Flight") {
      const known = (place: string | null) =>
        airportCodes(place).some((code) => airports.has(code));
      if (!known(line.departsFrom) || !known(line.arrivesAtPlace))
        flags.push({ type: "unknown_airport", line: i });
    }
    if (line.serviceIdentifier && at?.departsAt) {
      const key = `${fold(line.passengerName)}|${fold(line.serviceIdentifier)}|${at.departsAt}`;
      if (seen.has(key)) flags.push({ type: "duplicate_in_batch", line: i });
      seen.add(key);
    }
    if (line.departsTimeZone || line.arrivesTimeZone)
      flags.push({ type: "inferred_zone", line: i });
    if (options.inferredYear?.includes(i)) flags.push({ type: "inferred_year", line: i });
  });
  return flags;
}

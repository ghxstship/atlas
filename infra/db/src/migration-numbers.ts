/**
 * Migration numbers (ADR 0022, amendment of 2026-11-09). Two eras, so every name still sorts in the order it applies:
 *
 * - the closed 4.0 era, four digits from 0001 to 6999, which releases 4.0 to 4.8 applied and which never changes;
 * - release numbers, nine digits `9 MM mm BB SS` from the first migration after 4.8: the release that first ships the
 *   migration (major MM, minor mm), its block BB in that release, and its place SS in the block (01 to 99).
 *
 * Supabase sorts versions as text, so the leading 9 puts every release number after 6999, and the fixed width keeps
 * text order and number order the same. A release's blocks: 00 for fixes made on the release train itself, 01 to 98
 * for its packages in dependency order (5.0's are the post-launch packages, PL1 to PL68), and 99 for the release's
 * integration (its one notification kind seed and clash fixes) and every patch release after it ships.
 */

export const LEGACY_LAST = 6999;

/** The first release on release numbers: the next after 4.8. */
export const FIRST_RELEASE = { major: 4, minor: 9 } as const;

export const INTEGRATION_BLOCK = 99;

export type MigrationNumber =
  | { readonly era: "legacy"; readonly number: number }
  | {
      readonly era: "release";
      readonly major: number;
      readonly minor: number;
      readonly block: number;
      readonly place: number;
    };

const LEGACY = /^(\d{4})_[a-z0-9_]+$/;
const RELEASE = /^9(\d{2})(\d{2})(\d{2})(\d{2})_[a-z0-9_]+$/;

/** Reads a migration's base name (without .sql or .test.sql); a name that breaks a rule throws, saying which. */
export function parseMigrationName(name: string): MigrationNumber {
  const legacy = LEGACY.exec(name);
  if (legacy) {
    const number = Number(legacy[1]);
    if (number > LEGACY_LAST) {
      throw new Error(
        `${name}: four-digit numbers end at ${LEGACY_LAST}; new migrations take a release number, 9MMmmBBSS (ADR 0022)`,
      );
    }
    return { era: "legacy", number };
  }
  const release = RELEASE.exec(name);
  if (!release) {
    throw new Error(
      `${name}: a migration is <number>_<snake_case>, numbered 9MMmmBBSS for its release (ADR 0022)`,
    );
  }
  const [major, minor, block, place] = release.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
  ];
  if (
    major < FIRST_RELEASE.major ||
    (major === FIRST_RELEASE.major && minor < FIRST_RELEASE.minor)
  ) {
    throw new Error(
      `${name}: release numbers start at ${FIRST_RELEASE.major}.${FIRST_RELEASE.minor}; 4.8 and earlier are four digits`,
    );
  }
  if (place === 0) throw new Error(`${name}: places in a block run from 01 to 99`);
  return { era: "release", major, minor, block, place };
}

/** The release number for a release, block and place: `releaseNumber(5, 0, 12, 3)` is "905001203". */
export function releaseNumber(major: number, minor: number, block: number, place: number): string {
  const two = (n: number, what: string) => {
    if (!Number.isInteger(n) || n < 0 || n > 99) throw new RangeError(`${what} is two digits`);
    return String(n).padStart(2, "0");
  };
  if (place < 1) throw new RangeError("places in a block run from 01 to 99");
  const number = `9${two(major, "major")}${two(minor, "minor")}${two(block, "block")}${two(place, "place")}`;
  parseMigrationName(`${number}_check`);
  return number;
}

/** A release number's release, as people write it: "5.0". Legacy numbers name no release. */
export function releaseOf(parsed: MigrationNumber): string | null {
  return parsed.era === "release" ? `${parsed.major}.${parsed.minor}` : null;
}

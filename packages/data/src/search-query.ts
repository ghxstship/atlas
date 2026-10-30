import { addCalendarDays } from "./calendar.ts";

/**
 * The global search query grammar (Section 11.7 Search, Section 11.10 item 1; finding A65-005). One
 * parser for every surface: the command menu shows the operators it recognized as chips, and the
 * search RPC (`app.global_search`, migrations 1440, 2181 and 2841) receives the structured request this module
 * builds, never the raw text. Pure and dependency free, so it runs in the browser and on the server.
 *
 * Grammar, tokens separated by spaces:
 *   word              a word the result contains; the last word also matches as a prefix
 *   "a phrase"        the words together, in order
 *   -word, -"phrase"  results without them
 *   op:value          a filter; values may be quoted (project:"North Stage") or listed (status:blocked,active)
 *   -op:value         results the filter does not match
 *
 * Operators (English, with the Section 11.7 names and Spanish aliases):
 *   type: kind: tipo:            record, incident, person, document, sop, article, asset (an asset unit),
 *                                asset class, or a record kind (task, permit)
 *   project: proyecto:           project key (NWS) or the start of its name
 *   assignee: owner: asignado:   me, or part of a person's name
 *   status: state: estado:       a record or incident state (blocked, in-review), open or closed
 *   phase: fase:                 phase code (ADV) or name
 *   urid:                        URID or its start (5000.01)
 *   dept: depto:                 department or discipline, by code or name
 *   is: es:                      blocked, open, closed, overdue, mine, archived (only archived
 *                                records and documents, which are otherwise left out)
 *   before: antes:               on a day before the date
 *   after: despues: después:     on a day after the date
 *   due: vence:                  today, overdue, <date, >date or a date
 * Dates are 2026-10-21, today, yesterday, tomorrow, or a count of days or weeks: -7d is a week ago,
 * +2w is two weeks ahead, and an unsigned count means ago for before and after and ahead for due
 * (due:<7d is due within the next seven days). The database resolves every date on the org's
 * calendar (its locale.time_zone), never on UTC.
 */

/** Result types the search returns. */
export const SEARCH_TYPES = [
  "record",
  "incident",
  "person",
  "document",
  "sop",
  "article",
  "asset",
  "asset_class",
] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

/** Filter operators, by their canonical name. */
export const SEARCH_OPERATORS = [
  "type",
  "project",
  "assignee",
  "status",
  "phase",
  "urid",
  "dept",
  "is",
  "before",
  "after",
  "due",
] as const;
export type SearchOperator = (typeof SEARCH_OPERATORS)[number];

const ALIASES: Readonly<Record<string, SearchOperator>> = {
  type: "type",
  kind: "type",
  tipo: "type",
  project: "project",
  proyecto: "project",
  assignee: "assignee",
  owner: "assignee",
  asignado: "assignee",
  status: "status",
  state: "status",
  estado: "status",
  phase: "phase",
  fase: "phase",
  urid: "urid",
  dept: "dept",
  department: "dept",
  depto: "dept",
  is: "is",
  es: "is",
  before: "before",
  antes: "before",
  after: "after",
  despues: "after",
  después: "after",
  due: "due",
  vence: "due",
};

const TYPE_WORDS: Readonly<Record<string, SearchType>> = {
  record: "record",
  records: "record",
  registro: "record",
  registros: "record",
  incident: "incident",
  incidents: "incident",
  incidente: "incident",
  incidentes: "incident",
  person: "person",
  people: "person",
  member: "person",
  members: "person",
  persona: "person",
  personas: "person",
  document: "document",
  documents: "document",
  doc: "document",
  docs: "document",
  file: "document",
  documento: "document",
  documentos: "document",
  sop: "sop",
  sops: "sop",
  procedure: "sop",
  procedures: "sop",
  procedimiento: "sop",
  article: "article",
  articles: "article",
  handbook: "article",
  articulo: "article",
  artículo: "article",
  manual: "article",
  asset: "asset",
  assets: "asset",
  unit: "asset",
  units: "asset",
  gear: "asset",
  activo: "asset",
  activos: "asset",
  unidad: "asset",
  unidades: "asset",
  "asset class": "asset_class",
  "asset-class": "asset_class",
  asset_class: "asset_class",
  assetclass: "asset_class",
  class: "asset_class",
  classes: "asset_class",
  "clase de activo": "asset_class",
  "clase-de-activo": "asset_class",
  clase: "asset_class",
  clases: "asset_class",
};

/** `is:` values, with Spanish aliases. */
const IS_WORDS: Readonly<Record<string, SearchIs>> = {
  blocked: "blocked",
  bloqueado: "blocked",
  open: "open",
  abierto: "open",
  closed: "closed",
  done: "closed",
  cerrado: "closed",
  overdue: "overdue",
  vencido: "overdue",
  mine: "mine",
  mio: "mine",
  mío: "mine",
  archived: "archived",
  archivado: "archived",
  archivada: "archived",
};
export type SearchIs = "blocked" | "open" | "closed" | "overdue" | "mine" | "archived";

/** Limits that keep one query cheap: the RPC refuses nothing, it simply ignores what is past them. */
export const SEARCH_LIMITS = {
  query: 200,
  terms: 12,
  phrases: 4,
  values: 8,
  value: 100,
} as const;

/** A token as the command menu shows it: plain text, a phrase, or a filter chip. */
export type SearchToken =
  | { readonly kind: "term"; readonly text: string; readonly negated: boolean }
  | { readonly kind: "phrase"; readonly text: string; readonly negated: boolean }
  | {
      readonly kind: "filter";
      readonly operator: SearchOperator;
      /** The operator as typed, for example `kind` for the type filter. */
      readonly typed: string;
      readonly value: string;
      readonly negated: boolean;
      /** False when the value is not one the operator understands (before:someday). */
      readonly valid: boolean;
    };

/** A day bound: a calendar date (`2026-10-21`) or days from today on the org's calendar (`-7`). */
export type SearchDay = string;

export interface ParsedSearch {
  readonly terms: readonly string[];
  readonly phrases: readonly string[];
  readonly excludeTerms: readonly string[];
  readonly excludePhrases: readonly string[];
  readonly types: readonly SearchType[];
  readonly excludeTypes: readonly SearchType[];
  /** Record kinds as typed, lowercased; the server maps them to canon kinds. */
  readonly kinds: readonly string[];
  readonly excludeKinds: readonly string[];
  readonly projects: readonly string[];
  readonly excludeProjects: readonly string[];
  readonly assignees: readonly string[];
  readonly excludeAssignees: readonly string[];
  /** States without spaces or punctuation, lowercased (`inreview`), or `open` and `closed`. */
  readonly statuses: readonly string[];
  readonly excludeStatuses: readonly string[];
  readonly phases: readonly string[];
  readonly urids: readonly string[];
  readonly depts: readonly string[];
  readonly is: readonly SearchIs[];
  /** Strictly after this day: on or after the start of the next day. */
  readonly after: SearchDay | null;
  /** Strictly before this day: before its start. */
  readonly before: SearchDay | null;
  readonly dueAfter: SearchDay | null;
  readonly dueBefore: SearchDay | null;
  readonly tokens: readonly SearchToken[];
}

/** True when the query asks for nothing but plain words (no operators, phrases or exclusions). */
export function isPlainSearch(query: ParsedSearch): boolean {
  return query.tokens.every((t) => t.kind === "term" && !t.negated);
}

/** True when the query has anything to search for. */
export function hasSearchCriteria(query: ParsedSearch): boolean {
  return query.tokens.some((t) => t.kind !== "filter" || t.valid);
}

interface RawToken {
  readonly negated: boolean;
  /** Operator name as typed, lowercased, or null for a word or phrase. */
  readonly operator: string | null;
  readonly value: string;
  readonly quoted: boolean;
}

const QUOTES = new Set(['"', "“", "”"]);
const OPERATOR = /^([a-zA-Zé]+):(.*)$/s;

/** Splits the query into tokens, honoring quotes; an unclosed quote runs to the end. */
function tokenize(input: string): RawToken[] {
  const text = input.slice(0, SEARCH_LIMITS.query);
  const tokens: RawToken[] = [];
  let i = 0;
  const readQuoted = (): string => {
    // At an opening quote: read to the closing one.
    i += 1;
    let out = "";
    while (i < text.length && !QUOTES.has(text[i] as string)) {
      out += text[i];
      i += 1;
    }
    i += 1;
    return out.replace(/\s+/g, " ").trim();
  };
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i] as string)) i += 1;
    if (i >= text.length) break;
    let negated = false;
    if (text[i] === "-" && i + 1 < text.length && !/\s/.test(text[i + 1] as string)) {
      negated = true;
      i += 1;
    }
    if (QUOTES.has(text[i] as string)) {
      tokens.push({ negated, operator: null, value: readQuoted(), quoted: true });
      continue;
    }
    let word = "";
    while (i < text.length && !/\s/.test(text[i] as string)) {
      if (QUOTES.has(text[i] as string) && word.endsWith(":")) break;
      word += text[i];
      i += 1;
    }
    const op = OPERATOR.exec(word);
    if (op && (op[1] as string).toLowerCase() in ALIASES) {
      const name = (op[1] as string).toLowerCase();
      if ((op[2] as string) === "" && QUOTES.has(text[i] as string)) {
        tokens.push({ negated, operator: name, value: readQuoted(), quoted: true });
      } else {
        tokens.push({ negated, operator: name, value: op[2] as string, quoted: false });
      }
      continue;
    }
    if (word === "-" || word === "") continue;
    tokens.push({ negated, operator: null, value: word, quoted: false });
  }
  return tokens;
}

/** Lowercase without spaces, hyphens or underscores: `In Review`, `in-review` and `in_review` agree. */
export function normalizeState(value: string): string {
  return value
    .toLocaleLowerCase("en-US")
    .replace(/[\s_-]+/g, "")
    .trim();
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const RELATIVE = /^([+-]?)(\d{1,4})([dw])$/i;

/** A real calendar date in `YYYY-MM-DD`. */
function isCalendarDate(value: string): boolean {
  const m = ISO_DAY.exec(value);
  if (!m) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * A date token as a day bound: the date itself, or days from today. `unsigned` says which way an
 * unsigned count points: -1 (ago) for before and after, +1 (ahead) for due.
 */
export function parseSearchDay(value: string, unsigned: 1 | -1): SearchDay | null {
  const v = value.trim().toLocaleLowerCase("en-US");
  if (isCalendarDate(v)) return v;
  if (v === "today" || v === "hoy") return "0";
  if (v === "yesterday" || v === "ayer") return "-1";
  if (v === "tomorrow" || v === "mañana" || v === "manana") return "1";
  const m = RELATIVE.exec(v);
  if (!m) return null;
  const count = Number(m[2]) * ((m[3] as string).toLowerCase() === "w" ? 7 : 1);
  if (count > 3650) return null;
  const sign = m[1] === "-" ? -1 : m[1] === "+" ? 1 : unsigned;
  return String(sign * count);
}

/** A day bound moved by some days; relative bounds stay relative. */
export function shiftSearchDay(day: SearchDay, days: number): SearchDay {
  return isCalendarDate(day) ? addCalendarDays(day, days) : String(Number(day) + days);
}

/** The calendar date of a bound, given today's date on the org's calendar. */
export function resolveSearchDay(day: SearchDay, today: string): string {
  return isCalendarDate(day) ? day : addCalendarDays(today, Number(day));
}

interface DueBounds {
  readonly after: SearchDay | null;
  readonly before: SearchDay | null;
  readonly overdue: boolean;
}

function parseDue(value: string): DueBounds | null {
  const v = value.trim().toLocaleLowerCase("en-US");
  if (v === "overdue" || v === "vencido") return { after: null, before: "0", overdue: true };
  const cmp = /^(<=|>=|<|>)(.+)$/.exec(v);
  if (cmp) {
    const day = parseSearchDay(cmp[2] as string, 1);
    if (day === null) return null;
    switch (cmp[1]) {
      case "<":
        return { after: null, before: day, overdue: false };
      case "<=":
        return { after: null, before: shiftSearchDay(day, 1), overdue: false };
      case ">":
        return { after: day, before: null, overdue: false };
      default:
        return { after: shiftSearchDay(day, -1), before: null, overdue: false };
    }
  }
  const day = parseSearchDay(v, 1);
  if (day === null) return null;
  // On that day: after the day before, before the day after.
  return { after: shiftSearchDay(day, -1), before: shiftSearchDay(day, 1), overdue: false };
}

/** Values of a filter: a quoted value is one value, otherwise a comma-separated list. */
function valuesOf(token: RawToken): string[] {
  const parts = token.quoted ? [token.value] : token.value.split(",");
  return parts
    .map((v) => v.trim().slice(0, SEARCH_LIMITS.value))
    .filter((v) => v.length > 0)
    .slice(0, SEARCH_LIMITS.values);
}

/** Plain words of a phrase or term, for the term lists; punctuation is left to the database. */
function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, SEARCH_LIMITS.value);
}

function pushUnique<T>(list: T[], value: T): void {
  if (!list.includes(value)) list.push(value);
}

/** Parses a search query. Never throws: what it does not understand stays plain text or an invalid chip. */
export function parseSearchQuery(input: string): ParsedSearch {
  const terms: string[] = [];
  const phrases: string[] = [];
  const excludeTerms: string[] = [];
  const excludePhrases: string[] = [];
  const types: SearchType[] = [];
  const excludeTypes: SearchType[] = [];
  const kinds: string[] = [];
  const excludeKinds: string[] = [];
  const projects: string[] = [];
  const excludeProjects: string[] = [];
  const assignees: string[] = [];
  const excludeAssignees: string[] = [];
  const statuses: string[] = [];
  const excludeStatuses: string[] = [];
  const phases: string[] = [];
  const urids: string[] = [];
  const depts: string[] = [];
  const is: SearchIs[] = [];
  let after: SearchDay | null = null;
  let before: SearchDay | null = null;
  let dueAfter: SearchDay | null = null;
  let dueBefore: SearchDay | null = null;
  const tokens: SearchToken[] = [];

  for (const raw of tokenize(input)) {
    if (raw.operator === null) {
      const text = cleanText(raw.value);
      if (text === "") continue;
      if (raw.quoted) {
        const list = raw.negated ? excludePhrases : phrases;
        if (list.length < SEARCH_LIMITS.phrases) pushUnique(list, text);
        tokens.push({ kind: "phrase", text, negated: raw.negated });
      } else {
        const list = raw.negated ? excludeTerms : terms;
        if (list.length < SEARCH_LIMITS.terms) pushUnique(list, text);
        tokens.push({ kind: "term", text, negated: raw.negated });
      }
      continue;
    }
    const operator = ALIASES[raw.operator] as SearchOperator;
    const values = valuesOf(raw);
    let valid = values.length > 0;
    const value = raw.quoted ? raw.value : values.join(",");
    switch (operator) {
      case "type":
        for (const v of values) {
          const lower = v.toLocaleLowerCase("es-US");
          const type = TYPE_WORDS[lower];
          if (type) pushUnique(raw.negated ? excludeTypes : types, type);
          else pushUnique(raw.negated ? excludeKinds : kinds, lower);
        }
        break;
      case "project":
        for (const v of values) pushUnique(raw.negated ? excludeProjects : projects, v);
        break;
      case "assignee":
        for (const v of values) {
          const lower = v.toLocaleLowerCase("es-US");
          const me = lower === "me" || lower === "yo" || lower === "@me";
          pushUnique(raw.negated ? excludeAssignees : assignees, me ? "me" : v.replace(/^@/, ""));
        }
        break;
      case "status":
        for (const v of values) {
          const s = normalizeState(v);
          const word = IS_WORDS[s];
          const state = word === "open" || word === "closed" ? word : s;
          if (state) pushUnique(raw.negated ? excludeStatuses : statuses, state);
        }
        break;
      case "phase":
      case "urid":
      case "dept":
        if (raw.negated) {
          // Exclusions are offered for the filters people narrow most; these narrow only.
          valid = false;
          break;
        }
        for (const v of values) {
          pushUnique(operator === "phase" ? phases : operator === "urid" ? urids : depts, v);
        }
        break;
      case "is":
        for (const v of values) {
          const word = IS_WORDS[normalizeState(v)];
          if (!word) {
            valid = false;
            continue;
          }
          if (raw.negated) {
            // -is:open is is:closed and the reverse; other negations are not offered.
            if (word === "open") pushUnique(is, "closed");
            else if (word === "closed") pushUnique(is, "open");
            else valid = false;
          } else {
            pushUnique(is, word);
          }
        }
        break;
      case "before":
      case "after": {
        const day =
          values.length === 1 && !raw.negated ? parseSearchDay(values[0] as string, -1) : null;
        if (day === null) valid = false;
        else if (operator === "before") before = day;
        else after = day;
        break;
      }
      case "due": {
        const due = values.length === 1 && !raw.negated ? parseDue(values[0] as string) : null;
        if (due === null) {
          valid = false;
          break;
        }
        if (due.after !== null) dueAfter = due.after;
        if (due.before !== null) dueBefore = due.before;
        if (due.overdue) pushUnique(is, "open");
        break;
      }
    }
    tokens.push({
      kind: "filter",
      operator,
      typed: raw.operator,
      value,
      negated: raw.negated,
      valid,
    });
  }

  return {
    terms,
    phrases,
    excludeTerms,
    excludePhrases,
    types,
    excludeTypes,
    kinds,
    excludeKinds,
    projects,
    excludeProjects,
    assignees,
    excludeAssignees,
    statuses,
    excludeStatuses,
    phases,
    urids,
    depts,
    is,
    after,
    before,
    dueAfter,
    dueBefore,
    tokens,
  };
}

/** The request body of `app.global_search` (p_query), in the database's snake_case names. */
export interface SearchRequest {
  readonly terms: readonly string[];
  readonly phrases: readonly string[];
  readonly exclude_terms: readonly string[];
  readonly exclude_phrases: readonly string[];
  readonly types: readonly SearchType[];
  readonly exclude_types: readonly SearchType[];
  readonly kinds: readonly string[];
  readonly exclude_kinds: readonly string[];
  readonly projects: readonly string[];
  readonly exclude_projects: readonly string[];
  readonly assignees: readonly string[];
  readonly exclude_assignees: readonly string[];
  readonly statuses: readonly string[];
  readonly exclude_statuses: readonly string[];
  readonly phases: readonly string[];
  readonly urids: readonly string[];
  readonly depts: readonly string[];
  readonly is: readonly SearchIs[];
  readonly after: SearchDay | null;
  readonly before: SearchDay | null;
  readonly due_after: SearchDay | null;
  readonly due_before: SearchDay | null;
  /**
   * Types left out because the caller cannot open them (P7). Unlike `exclude_types` they are not something
   * to search for, so a query with nothing else to look for still returns nothing.
   */
  readonly omit_types?: readonly SearchType[];
}

/**
 * The RPC request for a parsed query. `kinds` replaces the typed kinds with the canon kinds the caller
 * resolved (labels in the person's language); unresolved kinds pass through for the database to match.
 */
export function searchRequest(
  query: ParsedSearch,
  resolved?: {
    readonly kinds?: readonly string[];
    readonly excludeKinds?: readonly string[];
  },
): SearchRequest {
  return {
    terms: query.terms,
    phrases: query.phrases,
    exclude_terms: query.excludeTerms,
    exclude_phrases: query.excludePhrases,
    types: query.types,
    exclude_types: query.excludeTypes,
    kinds: resolved?.kinds ?? query.kinds,
    exclude_kinds: resolved?.excludeKinds ?? query.excludeKinds,
    projects: query.projects,
    exclude_projects: query.excludeProjects,
    assignees: query.assignees,
    exclude_assignees: query.excludeAssignees,
    statuses: query.statuses,
    exclude_statuses: query.excludeStatuses,
    phases: query.phases,
    urids: query.urids,
    depts: query.depts,
    is: query.is,
    after: query.after,
    before: query.before,
    due_after: query.dueAfter,
    due_before: query.dueBefore,
  };
}

/** The words of the query that carry meaning, for the semantic half: terms and phrases, no filters. */
export function semanticText(query: ParsedSearch): string {
  return [...query.phrases, ...query.terms].join(" ").trim();
}

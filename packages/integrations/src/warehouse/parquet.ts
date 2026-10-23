/**
 * A small Parquet writer for warehouse delivery (A83, finding A65-029; Section 4.6.4 asks for Parquet). It
 * writes what a warehouse loader needs and nothing more: one row group, one uncompressed data page per column
 * (format version 1), PLAIN values, every column OPTIONAL with RLE definition levels so NULL stays NULL, and
 * the file footer in the Thrift compact protocol. Types follow the published schema:
 *
 *   string    BYTE_ARRAY, logical STRING (UTF8)
 *   int32     INT32
 *   int64     INT64
 *   double    DOUBLE
 *   boolean   BOOLEAN
 *   date      INT32, logical DATE (days since 1970-01-01)
 *   timestamp INT64, logical TIMESTAMP (UTC, microseconds)
 *
 * Reference: apache/parquet-format, parquet.thrift and Encodings.md. No dependency, so the Edge bundle stays
 * small; the tests read every file back with their own decoder of the same format.
 */

export type ParquetType =
  "string" | "int32" | "int64" | "double" | "boolean" | "date" | "timestamp";

export interface ParquetColumn {
  readonly name: string;
  readonly type: ParquetType;
}

export type ParquetValue = string | number | bigint | boolean | null;

const MAGIC = new TextEncoder().encode("PAR1");

// Thrift compact protocol ----------------------------------------------------------------------------------------

const T_TRUE = 1;
const T_FALSE = 2;
const T_I32 = 5;
const T_I64 = 6;
const T_BINARY = 8;
const T_LIST = 9;
const T_STRUCT = 12;

class Bytes {
  private chunks: Uint8Array[] = [];
  length = 0;

  push(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.length += bytes.byteLength;
  }

  byte(value: number): void {
    this.push(Uint8Array.of(value & 0xff));
  }

  varint(value: bigint): void {
    let v = value;
    const out: number[] = [];
    do {
      let b = Number(v & 0x7fn);
      v >>= 7n;
      if (v !== 0n) b |= 0x80;
      out.push(b);
    } while (v !== 0n);
    this.push(Uint8Array.from(out));
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.byteLength;
    }
    return out;
  }
}

const zigzag = (n: bigint) => (n << 1n) ^ (n >> 63n);

/** A Thrift struct field: id plus value. Structs nest; lists hold structs, strings or i32s. */
type Field =
  | { readonly id: number; readonly i32: number }
  | { readonly id: number; readonly i64: bigint | number }
  | { readonly id: number; readonly str: string }
  | { readonly id: number; readonly bool: boolean }
  | { readonly id: number; readonly struct: readonly Field[] }
  | { readonly id: number; readonly structs: readonly (readonly Field[])[] }
  | { readonly id: number; readonly strs: readonly string[] }
  | { readonly id: number; readonly i32s: readonly number[] };

function writeStruct(out: Bytes, fields: readonly Field[]): void {
  let last = 0;
  const header = (id: number, type: number) => {
    const delta = id - last;
    if (delta > 0 && delta <= 15) out.byte((delta << 4) | type);
    else {
      out.byte(type);
      out.varint(zigzag(BigInt(id)));
    }
    last = id;
  };
  const listHeader = (size: number, type: number) => {
    if (size < 15) out.byte((size << 4) | type);
    else {
      out.byte(0xf0 | type);
      out.varint(BigInt(size));
    }
  };
  const writeString = (value: string) => {
    const bytes = new TextEncoder().encode(value);
    out.varint(BigInt(bytes.byteLength));
    out.push(bytes);
  };
  for (const field of [...fields].sort((a, b) => a.id - b.id)) {
    if ("i32" in field) {
      header(field.id, T_I32);
      out.varint(zigzag(BigInt(field.i32)));
    } else if ("i64" in field) {
      header(field.id, T_I64);
      out.varint(zigzag(BigInt(field.i64)));
    } else if ("str" in field) {
      header(field.id, T_BINARY);
      writeString(field.str);
    } else if ("bool" in field) {
      header(field.id, field.bool ? T_TRUE : T_FALSE);
    } else if ("struct" in field) {
      header(field.id, T_STRUCT);
      writeStruct(out, field.struct);
    } else if ("structs" in field) {
      header(field.id, T_LIST);
      listHeader(field.structs.length, T_STRUCT);
      for (const s of field.structs) writeStruct(out, s);
    } else if ("strs" in field) {
      header(field.id, T_LIST);
      listHeader(field.strs.length, T_BINARY);
      for (const s of field.strs) writeString(s);
    } else {
      header(field.id, T_LIST);
      listHeader(field.i32s.length, T_I32);
      for (const v of field.i32s) out.varint(zigzag(BigInt(v)));
    }
  }
  out.byte(0); // STOP
}

export function thriftCompact(fields: readonly Field[]): Uint8Array {
  const out = new Bytes();
  writeStruct(out, fields);
  return out.bytes();
}

// Parquet enums (parquet.thrift) ------------------------------------------------------------------------------------

const PHYSICAL: Readonly<Record<ParquetType, number>> = {
  boolean: 0,
  int32: 1,
  int64: 2,
  double: 5,
  string: 6,
  date: 1,
  timestamp: 2,
};
const OPTIONAL = 1;
const ENCODING_PLAIN = 0;
const ENCODING_RLE = 3;
const CONVERTED_UTF8 = 0;
const CONVERTED_DATE = 6;
const CONVERTED_TIMESTAMP_MICROS = 10;

function schemaElement(column: ParquetColumn): Field[] {
  const fields: Field[] = [
    { id: 1, i32: PHYSICAL[column.type] },
    { id: 3, i32: OPTIONAL },
    { id: 4, str: column.name },
  ];
  if (column.type === "string") {
    fields.push({ id: 6, i32: CONVERTED_UTF8 }, { id: 10, struct: [{ id: 1, struct: [] }] });
  } else if (column.type === "date") {
    fields.push({ id: 6, i32: CONVERTED_DATE }, { id: 10, struct: [{ id: 6, struct: [] }] });
  } else if (column.type === "timestamp") {
    fields.push(
      { id: 6, i32: CONVERTED_TIMESTAMP_MICROS },
      // LogicalType.TIMESTAMP = TimestampType { isAdjustedToUTC: true, unit: TimeUnit.MICROS }
      {
        id: 10,
        struct: [
          {
            id: 8,
            struct: [
              { id: 1, bool: true },
              { id: 2, struct: [{ id: 2, struct: [] }] },
            ],
          },
        ],
      },
    );
  }
  return fields;
}

// Values ------------------------------------------------------------------------------------------------------------

/** Days since 1970-01-01 for a `YYYY-MM-DD` date. */
function epochDays(value: string): number {
  const ms = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new RangeError(`${value} is not a date.`);
  return Math.round(ms / 86_400_000);
}

/** Microseconds since the epoch for an ISO timestamp, keeping the microseconds Postgres sends. */
function epochMicros(value: string): bigint {
  const match = /^(.*?)(?:\.(\d+))?(Z|[+-]\d\d:?\d\d)?$/.exec(value.trim());
  const base = Date.parse(`${match?.[1] ?? value}${match?.[3] ?? "Z"}`);
  if (Number.isNaN(base)) throw new RangeError(`${value} is not a timestamp.`);
  const fraction = (match?.[2] ?? "").padEnd(6, "0").slice(0, 6);
  return BigInt(base) * 1000n + BigInt(fraction || "0");
}

function plainValues(type: ParquetType, values: readonly ParquetValue[]): Uint8Array {
  const out = new Bytes();
  if (type === "boolean") {
    const packed = new Uint8Array(Math.ceil(values.length / 8));
    values.forEach((v, i) => {
      if (v === true) packed[i >> 3] = (packed[i >> 3] ?? 0) | (1 << (i & 7));
    });
    out.push(packed);
    return out.bytes();
  }
  for (const v of values) {
    if (type === "string") {
      const bytes = new TextEncoder().encode(String(v));
      const len = new Uint8Array(4);
      new DataView(len.buffer).setUint32(0, bytes.byteLength, true);
      out.push(len);
      out.push(bytes);
    } else if (type === "int32" || type === "date") {
      const b = new Uint8Array(4);
      const n = type === "date" ? epochDays(String(v)) : Number(v);
      if (!Number.isInteger(n)) throw new RangeError(`${String(v)} is not an int32.`);
      new DataView(b.buffer).setInt32(0, n, true);
      out.push(b);
    } else if (type === "int64" || type === "timestamp") {
      const b = new Uint8Array(8);
      const n =
        type === "timestamp" ? epochMicros(String(v)) : BigInt(v as number | bigint | string);
      new DataView(b.buffer).setBigInt64(0, n, true);
      out.push(b);
    } else {
      const b = new Uint8Array(8);
      new DataView(b.buffer).setFloat64(0, Number(v), true);
      out.push(b);
    }
  }
  return out.bytes();
}

/** Definition levels (1 present, 0 NULL) in the RLE/bit-packing hybrid with bit width 1, length-prefixed. */
function definitionLevels(values: readonly ParquetValue[]): Uint8Array {
  const runs = new Bytes();
  let i = 0;
  while (i < values.length) {
    const present = values[i] !== null;
    let j = i + 1;
    while (j < values.length && (values[j] !== null) === present) j += 1;
    runs.varint(BigInt(j - i) << 1n); // RLE run header: count << 1, low bit 0
    runs.byte(present ? 1 : 0);
    i = j;
  }
  const body = runs.bytes();
  const out = new Uint8Array(4 + body.byteLength);
  new DataView(out.buffer).setUint32(0, body.byteLength, true);
  out.set(body, 4);
  return out;
}

/** Normalizes a JSON value from the database into the column's type, or null. Objects become JSON text. */
export function toParquetValue(type: ParquetType, value: unknown): ParquetValue {
  if (value === null || value === undefined) return null;
  switch (type) {
    case "string":
      return typeof value === "string" ? value : JSON.stringify(value);
    case "boolean":
      return value === true || value === "true";
    case "int32":
    case "int64":
    case "double":
      return typeof value === "number" ? value : Number(value);
    default:
      return String(value);
  }
}

/** Writes rows (one array of values per row, in column order) as a complete Parquet file. */
export function writeParquet(
  columns: readonly ParquetColumn[],
  rows: readonly (readonly ParquetValue[])[],
  createdBy = "XOS warehouse delivery",
): Uint8Array {
  if (columns.length === 0) throw new RangeError("A Parquet file needs at least one column.");
  const file = new Bytes();
  file.push(MAGIC);
  const chunks: Field[][] = [];
  let totalBytes = 0;
  columns.forEach((column, c) => {
    const all = rows.map((r) => r[c] ?? null);
    const present = all.filter((v): v is Exclude<ParquetValue, null> => v !== null);
    const levels = definitionLevels(all);
    const data = plainValues(column.type, present);
    const pageBody = new Uint8Array(levels.byteLength + data.byteLength);
    pageBody.set(levels, 0);
    pageBody.set(data, levels.byteLength);
    const pageHeader = thriftCompact([
      { id: 1, i32: 0 }, // DATA_PAGE
      { id: 2, i32: pageBody.byteLength },
      { id: 3, i32: pageBody.byteLength },
      {
        id: 5,
        struct: [
          { id: 1, i32: all.length },
          { id: 2, i32: ENCODING_PLAIN },
          { id: 3, i32: ENCODING_RLE },
          { id: 4, i32: ENCODING_RLE },
        ],
      },
    ]);
    const offset = file.length;
    file.push(pageHeader);
    file.push(pageBody);
    const size = pageHeader.byteLength + pageBody.byteLength;
    totalBytes += size;
    chunks.push([
      { id: 2, i64: offset },
      {
        id: 3,
        struct: [
          { id: 1, i32: PHYSICAL[column.type] },
          { id: 2, i32s: [ENCODING_PLAIN, ENCODING_RLE] },
          { id: 3, strs: [column.name] },
          { id: 4, i32: 0 }, // UNCOMPRESSED
          { id: 5, i64: all.length },
          { id: 6, i64: size },
          { id: 7, i64: size },
          { id: 9, i64: offset },
        ],
      },
    ]);
  });
  const footer = thriftCompact([
    { id: 1, i32: 1 },
    {
      id: 2,
      structs: [
        [
          { id: 4, str: "schema" },
          { id: 5, i32: columns.length },
        ],
        ...columns.map(schemaElement),
      ],
    },
    { id: 3, i64: rows.length },
    {
      id: 4,
      structs: [
        [
          { id: 1, structs: chunks },
          { id: 2, i64: totalBytes },
          { id: 3, i64: rows.length },
        ],
      ],
    },
    { id: 6, str: createdBy },
  ]);
  file.push(footer);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, footer.byteLength, true);
  file.push(length);
  file.push(MAGIC);
  return file.bytes();
}

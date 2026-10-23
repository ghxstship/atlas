/**
 * A test-only Parquet reader for the files src/warehouse/parquet.ts writes: Thrift compact decoding of the
 * footer and page headers, RLE definition levels and PLAIN values. Written from the format specification
 * (apache/parquet-format), independently of the writer, so a round trip checks the bytes on disk.
 */

type ThriftValue = number | bigint | boolean | string | Uint8Array | ThriftStruct | ThriftValue[];
export type ThriftStruct = Map<number, ThriftValue>;

class Reader {
  at = 0;
  constructor(private readonly bytes: Uint8Array) {}

  byte(): number {
    const b = this.bytes[this.at];
    if (b === undefined) throw new Error("read past the end");
    this.at += 1;
    return b;
  }

  varint(): bigint {
    let shift = 0n;
    let result = 0n;
    for (;;) {
      const b = this.byte();
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
    }
  }

  zigzag(): bigint {
    const n = this.varint();
    return (n >> 1n) ^ -(n & 1n);
  }

  take(length: number): Uint8Array {
    const out = this.bytes.slice(this.at, this.at + length);
    this.at += length;
    return out;
  }

  value(type: number): ThriftValue {
    switch (type) {
      case 1:
        return true;
      case 2:
        return false;
      case 3:
        return this.byte();
      case 4:
      case 5:
        return Number(this.zigzag());
      case 6:
        return this.zigzag();
      case 8:
        return this.take(Number(this.varint()));
      case 9: {
        const header = this.byte();
        let size = header >> 4;
        const elem = header & 0x0f;
        if (size === 15) size = Number(this.varint());
        const items: ThriftValue[] = [];
        for (let i = 0; i < size; i += 1) {
          items.push(elem === 1 || elem === 2 ? this.byte() === 1 : this.value(elem));
        }
        return items;
      }
      case 12:
        return this.struct();
      default:
        throw new Error(`unsupported thrift type ${type}`);
    }
  }

  struct(): ThriftStruct {
    const fields: ThriftStruct = new Map();
    let last = 0;
    for (;;) {
      const header = this.byte();
      if (header === 0) return fields;
      const type = header & 0x0f;
      const delta = header >> 4;
      const id = delta === 0 ? Number(this.zigzag()) : last + delta;
      last = id;
      fields.set(id, this.value(type));
    }
  }
}

const text = (v: ThriftValue | undefined) => new TextDecoder().decode(v as Uint8Array);

export interface ReadColumn {
  readonly name: string;
  readonly physical: number;
  readonly converted: number | null;
  readonly logical: ThriftStruct | null;
  readonly values: (string | number | bigint | boolean | null)[];
}

export interface ReadFile {
  readonly version: number;
  readonly numRows: bigint;
  readonly createdBy: string;
  readonly columns: readonly ReadColumn[];
}

export function readParquet(file: Uint8Array): ReadFile {
  const magic = new TextDecoder().decode(file.slice(0, 4));
  const tail = new TextDecoder().decode(file.slice(file.length - 4));
  if (magic !== "PAR1" || tail !== "PAR1") throw new Error("not a Parquet file");
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const footerLength = view.getUint32(file.length - 8, true);
  const footer = new Reader(file.slice(file.length - 8 - footerLength, file.length - 8)).struct();
  const schema = footer.get(2) as ThriftStruct[];
  const numRows = footer.get(3) as bigint;
  const rowGroup = (footer.get(4) as ThriftStruct[])[0];
  if (rowGroup === undefined) throw new Error("no row group");
  const chunks = rowGroup.get(1) as ThriftStruct[];
  const columns: ReadColumn[] = [];
  schema.slice(1).forEach((element, i) => {
    const chunk = chunks[i];
    if (chunk === undefined) throw new Error("missing column chunk");
    const meta = chunk.get(3) as ThriftStruct;
    const physical = meta.get(1) as number;
    const offset = Number(meta.get(9) as bigint);
    const reader = new Reader(file);
    reader.at = offset;
    const page = reader.struct();
    const dataHeader = page.get(5) as ThriftStruct;
    const count = dataHeader.get(1) as number;
    const body = reader.take(page.get(3) as number);
    const bodyView = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const levelsLength = bodyView.getUint32(0, true);
    const levels: number[] = [];
    const lr = new Reader(body.slice(4, 4 + levelsLength));
    while (levels.length < count) {
      const header = Number(lr.varint());
      if ((header & 1) === 1) throw new Error("bit-packed runs are not expected");
      const value = lr.byte();
      for (let n = 0; n < header >> 1; n += 1) levels.push(value);
    }
    let at = 4 + levelsLength;
    let bit = 0;
    const values = levels.map((level) => {
      if (level === 0) return null;
      switch (physical) {
        case 0: {
          const v = ((body[at + (bit >> 3)] ?? 0) >> (bit & 7)) & 1;
          bit += 1;
          return v === 1;
        }
        case 1: {
          const v = bodyView.getInt32(at, true);
          at += 4;
          return v;
        }
        case 2: {
          const v = bodyView.getBigInt64(at, true);
          at += 8;
          return v;
        }
        case 5: {
          const v = bodyView.getFloat64(at, true);
          at += 8;
          return v;
        }
        case 6: {
          const length = bodyView.getUint32(at, true);
          const v = new TextDecoder().decode(body.slice(at + 4, at + 4 + length));
          at += 4 + length;
          return v;
        }
        default:
          throw new Error(`unexpected physical type ${physical}`);
      }
    });
    columns.push({
      name: text(element.get(4)),
      physical,
      converted: (element.get(6) as number | undefined) ?? null,
      logical: (element.get(10) as ThriftStruct | undefined) ?? null,
      values,
    });
  });
  return { version: footer.get(1) as number, numRows, createdBy: text(footer.get(6)), columns };
}

/**
 * Protobuf **decoder** for OTLP logs — the inverse of `./otlp-protobuf`,
 * written for tests so they can assert on what actually went over the wire.
 *
 * Not part of any package entry point (see `tsdown.config.ts`), so it never
 * ships: production code has no reason to read an OTLP payload back.
 *
 * It reconstructs the exact tree `encodeLogsPayload` produces, which makes
 * `encode → decode` a round-trip identity and lets a test compare against a
 * plain object literal. Fields absent from the bytes come back as their proto3
 * defaults, since that is what a real receiver would see.
 */

import type {
  OtlpAnyValue,
  OtlpKeyValue,
  OtlpLogRecord,
  OtlpLogsPayload,
  OtlpResourceLogs,
  OtlpScopeLogs,
} from './otlp-exporter.ts';

const UTF8 = new TextDecoder();

class ProtoReader {
  private pos = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.pos >= this.bytes.length;
  }

  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const byte = this.bytes[this.pos++]!;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
  }

  fixed64(): bigint {
    let result = 0n;
    for (let i = 0n; i < 8n; i++) {
      result |= BigInt(this.bytes[this.pos++]!) << (i * 8n);
    }
    return result;
  }

  double(): number {
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.pos, 8);
    this.pos += 8;
    return view.getFloat64(0, true);
  }

  lengthDelimited(): Uint8Array {
    const length = Number(this.varint());
    const slice = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    return slice;
  }

  string(): string {
    return UTF8.decode(this.lengthDelimited());
  }

  /** Next field header → its number and wire type. */
  header(): { field: number; wireType: number } {
    const tag = this.varint();
    return { field: Number(tag >> 3n), wireType: Number(tag & 0x7n) };
  }

  skip(wireType: number): void {
    if (wireType === 0) this.varint();
    else if (wireType === 1) this.pos += 8;
    else if (wireType === 2) this.lengthDelimited();
    else if (wireType === 5) this.pos += 4;
    else throw new Error(`unsupported wire type ${wireType}`);
  }
}

/** Read every field of a message, dispatching on field number. */
function eachField(
  bytes: Uint8Array,
  visit: (field: number, reader: ProtoReader, wireType: number) => boolean
): void {
  const reader = new ProtoReader(bytes);
  while (!reader.done) {
    const { field, wireType } = reader.header();
    if (!visit(field, reader, wireType)) reader.skip(wireType);
  }
}

export function decodeLogsProtobuf(bytes: Uint8Array): OtlpLogsPayload {
  const resourceLogs: OtlpResourceLogs[] = [];
  eachField(bytes, (field, reader) => {
    if (field !== 1) return false;
    resourceLogs.push(decodeResourceLogs(reader.lengthDelimited()));
    return true;
  });
  return { resourceLogs };
}

function decodeResourceLogs(bytes: Uint8Array): OtlpResourceLogs {
  const attributes: OtlpKeyValue[] = [];
  const scopeLogs: OtlpScopeLogs[] = [];

  eachField(bytes, (field, reader) => {
    if (field === 1) {
      eachField(reader.lengthDelimited(), (inner, resource) => {
        if (inner !== 1) return false;
        attributes.push(decodeKeyValue(resource.lengthDelimited()));
        return true;
      });
      return true;
    }
    if (field === 2) {
      scopeLogs.push(decodeScopeLogs(reader.lengthDelimited()));
      return true;
    }
    return false;
  });

  return { resource: { attributes }, scopeLogs };
}

function decodeScopeLogs(bytes: Uint8Array): OtlpScopeLogs {
  let name = '';
  const logRecords: OtlpLogRecord[] = [];

  eachField(bytes, (field, reader) => {
    if (field === 1) {
      eachField(reader.lengthDelimited(), (inner, scope) => {
        if (inner !== 1) return false;
        name = scope.string();
        return true;
      });
      return true;
    }
    if (field === 2) {
      logRecords.push(decodeLogRecord(reader.lengthDelimited()));
      return true;
    }
    return false;
  });

  return { scope: { name }, logRecords };
}

function decodeLogRecord(bytes: Uint8Array): OtlpLogRecord {
  const record: OtlpLogRecord = {
    timeUnixNano: '0',
    observedTimeUnixNano: '0',
    severityNumber: 0,
    severityText: '',
    body: { stringValue: '' },
    attributes: [],
  };

  eachField(bytes, (field, reader) => {
    switch (field) {
      case 1:
        record.timeUnixNano = String(reader.fixed64());
        return true;
      case 2:
        record.severityNumber = Number(reader.varint());
        return true;
      case 3:
        record.severityText = reader.string();
        return true;
      case 5:
        record.body = decodeAnyValue(reader.lengthDelimited());
        return true;
      case 6:
        record.attributes.push(decodeKeyValue(reader.lengthDelimited()));
        return true;
      case 11:
        record.observedTimeUnixNano = String(reader.fixed64());
        return true;
      default:
        return false;
    }
  });

  return record;
}

function decodeKeyValue(bytes: Uint8Array): OtlpKeyValue {
  let key = '';
  let value: OtlpAnyValue = { stringValue: '' };

  eachField(bytes, (field, reader) => {
    if (field === 1) {
      key = reader.string();
      return true;
    }
    if (field === 2) {
      value = decodeAnyValue(reader.lengthDelimited());
      return true;
    }
    return false;
  });

  return { key, value };
}

function decodeAnyValue(bytes: Uint8Array): OtlpAnyValue {
  let value: OtlpAnyValue = { stringValue: '' };

  eachField(bytes, (field, reader) => {
    switch (field) {
      case 1:
        value = { stringValue: reader.string() };
        return true;
      case 2:
        value = { boolValue: reader.varint() !== 0n };
        return true;
      case 3:
        value = { intValue: String(BigInt.asIntN(64, reader.varint())) };
        return true;
      case 4:
        value = { doubleValue: reader.double() };
        return true;
      case 5: {
        const values: OtlpAnyValue[] = [];
        eachField(reader.lengthDelimited(), (inner, array) => {
          if (inner !== 1) return false;
          values.push(decodeAnyValue(array.lengthDelimited()));
          return true;
        });
        value = { arrayValue: { values } };
        return true;
      }
      case 6: {
        const values: OtlpKeyValue[] = [];
        eachField(reader.lengthDelimited(), (inner, list) => {
          if (inner !== 1) return false;
          values.push(decodeKeyValue(list.lengthDelimited()));
          return true;
        });
        value = { kvlistValue: { values } };
        return true;
      }
      default:
        return false;
    }
  });

  return value;
}

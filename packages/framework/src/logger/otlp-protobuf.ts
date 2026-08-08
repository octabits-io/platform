/**
 * OTLP/HTTP **protobuf** encoding — hand-written, no protobuf runtime.
 *
 * Protobuf is the encoding the OTLP spec requires of every receiver; JSON is
 * optional and plenty of backends decline it (VictoriaLogs answers an OTLP/JSON
 * POST with `400 … json encoding isn't supported`). Emitting protobuf is
 * therefore what makes this exporter portable, and it has to happen without an
 * SDK for the reason `./logger` has no dependencies at all: every module
 * imports it.
 *
 * The wire format is small enough to write out by hand. Only what OTLP logs
 * actually uses is implemented — varint, 64-bit, and length-delimited fields:
 *
 * ```
 * ExportLogsServiceRequest { 1: repeated ResourceLogs }
 * ResourceLogs   { 1: Resource, 2: repeated ScopeLogs }
 * Resource       { 1: repeated KeyValue }
 * ScopeLogs      { 1: InstrumentationScope, 2: repeated LogRecord }
 * LogRecord      { 1: fixed64 time, 2: severity number, 3: severity text,
 *                  5: AnyValue body, 6: repeated KeyValue,
 *                  11: fixed64 observed time }
 * KeyValue       { 1: string key, 2: AnyValue value }
 * AnyValue       { oneof 1: string | 2: bool | 3: int64 | 4: double
 *                        | 5: ArrayValue | 6: KeyValueList }
 * ```
 *
 * It consumes the same payload tree {@link encodeLogsPayload} builds for JSON,
 * so grouping, attribute mapping, and timestamp handling have exactly one
 * implementation and the two encodings cannot drift apart.
 *
 * @see https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/logs/v1/logs.proto
 * @see https://protobuf.dev/programming-guides/encoding/
 */

import type {
  OtlpAnyValue,
  OtlpKeyValue,
  OtlpLogRecord,
  OtlpLogsPayload,
} from './otlp-exporter.ts';

/** Protobuf wire types. Only these three appear in OTLP logs. */
const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH_DELIMITED = 2;

/** 2^64, for two's-complement encoding of negative int64 values. */
const TWO_POW_64 = 1n << 64n;

const UTF8 = new TextEncoder();

/**
 * Growable byte buffer with just the protobuf primitives OTLP logs need.
 *
 * Everything is written into one buffer. A length-delimited field has to know
 * its payload length before writing it, which the encoder resolves by
 * backpatching (see {@link ProtoWriter.messageField}) rather than by giving
 * each nested message its own writer — a batch of 512 records nests ~9000
 * messages, so a sub-writer per message is ~9 MB of throwaway buffers.
 */
class ProtoWriter {
  private buffer = new Uint8Array(1024);
  private length = 0;

  private reserve(extra: number): void {
    if (this.length + extra <= this.buffer.length) return;
    let capacity = this.buffer.length * 2;
    while (capacity < this.length + extra) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
  }

  private pushByte(byte: number): void {
    this.reserve(1);
    this.buffer[this.length++] = byte;
  }

  private pushBytes(source: Uint8Array): void {
    this.reserve(source.length);
    this.buffer.set(source, this.length);
    this.length += source.length;
  }

  /** Base-128 varint, low group first, continuation bit on all but the last. */
  varint(value: bigint): void {
    let remaining = value < 0n ? value + TWO_POW_64 : value;
    while (remaining > 0x7fn) {
      this.pushByte(Number((remaining & 0x7fn) | 0x80n));
      remaining >>= 7n;
    }
    this.pushByte(Number(remaining));
  }

  /** Field header: field number and wire type packed into one varint. */
  tag(field: number, wireType: number): void {
    this.varint((BigInt(field) << 3n) | BigInt(wireType));
  }

  uint32Field(field: number, value: number): void {
    this.tag(field, WIRE_VARINT);
    this.varint(BigInt(value));
  }

  int64Field(field: number, value: bigint): void {
    this.tag(field, WIRE_VARINT);
    this.varint(value);
  }

  boolField(field: number, value: boolean): void {
    this.tag(field, WIRE_VARINT);
    this.varint(value ? 1n : 0n);
  }

  fixed64Field(field: number, value: bigint): void {
    this.tag(field, WIRE_FIXED64);
    const normalized = value < 0n ? value + TWO_POW_64 : value;
    this.reserve(8);
    for (let i = 0n; i < 8n; i++) {
      this.buffer[this.length++] = Number((normalized >> (i * 8n)) & 0xffn);
    }
  }

  /** IEEE-754 double, little-endian — wire type 1, same as fixed64. */
  doubleField(field: number, value: number): void {
    this.tag(field, WIRE_FIXED64);
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, true);
    this.pushBytes(bytes);
  }

  stringField(field: number, value: string): void {
    const encoded = UTF8.encode(value);
    this.tag(field, WIRE_LENGTH_DELIMITED);
    this.varint(BigInt(encoded.length));
    this.pushBytes(encoded);
  }

  /**
   * Nested message, written in place: reserve one byte for the length, encode
   * the body straight into this buffer, then backpatch the length once it is
   * known.
   *
   * One byte covers any message under 128 bytes, which is nearly all of them —
   * a `KeyValue` or an `AnyValue` rarely comes close. A longer body needs a
   * wider varint, so its bytes shift right to make room; that costs a
   * `copyWithin` on the rare large message instead of an allocation on every
   * small one.
   */
  messageField(field: number, encode: (writer: ProtoWriter) => void): void {
    this.tag(field, WIRE_LENGTH_DELIMITED);
    const lengthPos = this.length;
    this.pushByte(0);
    const start = this.length;

    encode(this);

    const size = this.length - start;
    if (size < 0x80) {
      this.buffer[lengthPos] = size;
      return;
    }

    let width = 1;
    for (let remaining = size; remaining > 0x7f; remaining >>>= 7) width++;
    const extra = width - 1;
    this.reserve(extra);
    this.buffer.copyWithin(start + extra, start, this.length);
    this.length += extra;

    let remaining = size;
    let pos = lengthPos;
    while (remaining > 0x7f) {
      this.buffer[pos++] = (remaining & 0x7f) | 0x80;
      remaining >>>= 7;
    }
    this.buffer[pos] = remaining;
  }

  // `Uint8Array<ArrayBuffer>`, not a bare `Uint8Array`: the default type
  // parameter is `ArrayBufferLike`, which includes `SharedArrayBuffer` and so
  // is not a valid `fetch` body.
  finish(): Uint8Array<ArrayBuffer> {
    return this.buffer.subarray(0, this.length);
  }
}

/**
 * Serialize an OTLP logs payload to protobuf bytes.
 *
 * @param payload The tree {@link encodeLogsPayload} returns.
 * @returns An `ExportLogsServiceRequest`, ready to POST as
 *   `application/x-protobuf`.
 */
export function encodeLogsProtobuf(payload: OtlpLogsPayload): Uint8Array<ArrayBuffer> {
  const writer = new ProtoWriter();

  for (const resourceLogs of payload.resourceLogs) {
    writer.messageField(1, (resource) => {
      resource.messageField(1, (inner) => {
        for (const attribute of resourceLogs.resource.attributes) {
          writeKeyValue(inner, 1, attribute);
        }
      });

      for (const scopeLogs of resourceLogs.scopeLogs) {
        resource.messageField(2, (scope) => {
          scope.messageField(1, (instrumentation) => {
            instrumentation.stringField(1, scopeLogs.scope.name);
          });
          for (const record of scopeLogs.logRecords) {
            scope.messageField(2, (entry) => writeLogRecord(entry, record));
          }
        });
      }
    });
  }

  return writer.finish();
}

function writeLogRecord(writer: ProtoWriter, record: OtlpLogRecord): void {
  // proto3 omits default-valued scalars; a receiver reads an absent field as
  // its default, so skipping them is what every conformant encoder does. The
  // AnyValue members below are the exception — see writeAnyValue.
  const timeUnixNano = BigInt(record.timeUnixNano);
  if (timeUnixNano !== 0n) writer.fixed64Field(1, timeUnixNano);
  if (record.severityNumber !== 0) writer.uint32Field(2, record.severityNumber);
  if (record.severityText) writer.stringField(3, record.severityText);
  writer.messageField(5, (body) => writeAnyValue(body, record.body));
  for (const attribute of record.attributes) {
    writeKeyValue(writer, 6, attribute);
  }
  // observed_time_unix_nano is field 11, so it goes out after the attributes:
  // fields may legally appear in any order, but ascending is what canonical
  // encoders emit and what makes a hexdump readable.
  const observedTimeUnixNano = BigInt(record.observedTimeUnixNano);
  if (observedTimeUnixNano !== 0n) writer.fixed64Field(11, observedTimeUnixNano);
}

function writeKeyValue(writer: ProtoWriter, field: number, keyValue: OtlpKeyValue): void {
  writer.messageField(field, (entry) => {
    entry.stringField(1, keyValue.key);
    entry.messageField(2, (value) => writeAnyValue(value, keyValue.value));
  });
}

/**
 * Write an `AnyValue`'s single populated member.
 *
 * Every member is part of a `oneof`, and proto3 serializes an explicitly-set
 * oneof field even when it holds the type's default — so an empty string, a
 * `false`, or a `0` must still emit its tag. Dropping it would leave the
 * receiver with no member set at all, turning a logged `""` into a missing
 * value.
 */
function writeAnyValue(writer: ProtoWriter, value: OtlpAnyValue): void {
  if ('stringValue' in value) {
    writer.stringField(1, value.stringValue);
  } else if ('boolValue' in value) {
    writer.boolField(2, value.boolValue);
  } else if ('intValue' in value) {
    writer.int64Field(3, BigInt(value.intValue));
  } else if ('doubleValue' in value) {
    writer.doubleField(4, value.doubleValue);
  } else if ('arrayValue' in value) {
    writer.messageField(5, (array) => {
      for (const item of value.arrayValue.values) {
        array.messageField(1, (element) => writeAnyValue(element, item));
      }
    });
  } else {
    writer.messageField(6, (list) => {
      for (const item of value.kvlistValue.values) {
        writeKeyValue(list, 1, item);
      }
    });
  }
}

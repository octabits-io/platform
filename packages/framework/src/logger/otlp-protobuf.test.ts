import { describe, it, expect } from 'vitest';
import { encodeLogsPayload } from './otlp-exporter.ts';
import { encodeLogsProtobuf } from './otlp-protobuf.ts';
import { decodeLogsProtobuf } from './otlp-protobuf.testing.ts';
import type { LogRecord } from './types.ts';

function record(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    timestamp: '2026-08-08T10:00:00.000Z',
    severityNumber: 9,
    severityText: 'INFO',
    body: 'hello',
    attributes: {},
    resource: { 'service.name': 'api' },
    ...overrides,
  };
}

/** encode → decode, the identity a conformant receiver has to observe. */
function roundTrip(records: LogRecord[]) {
  return decodeLogsProtobuf(encodeLogsProtobuf(encodeLogsPayload(records)));
}

describe('encodeLogsProtobuf', () => {
  it('round-trips a record with its resource, scope, and attributes intact', () => {
    const records = [
      record({
        body: 'Server started',
        attributes: { port: 3000 },
        resource: { 'service.name': 'api', 'deployment.environment': 'staging' },
      }),
    ];

    expect(roundTrip(records)).toEqual(encodeLogsPayload(records));
  });

  it('preserves every AnyValue member type', () => {
    const records = [
      record({
        attributes: {
          text: 'value',
          flag: true,
          off: false,
          count: 42,
          ratio: 1.5,
          negative: -17,
          list: ['a', 1, false],
          nested: { inner: 'deep', level: 2 },
        },
      }),
    ];

    expect(roundTrip(records)).toEqual(encodeLogsPayload(records));
  });

  it('keeps int64 values that exceed Number.MAX_SAFE_INTEGER exact', () => {
    // The JSON shape carries int64 as a string precisely so large values
    // survive; the varint encoding has to honour that rather than round-trip
    // through a double.
    const payload = encodeLogsPayload([record()]);
    payload.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!.attributes = [
      { key: 'big', value: { intValue: '9223372036854775807' } },
      { key: 'small', value: { intValue: '-9223372036854775808' } },
    ];

    const decoded = decodeLogsProtobuf(encodeLogsProtobuf(payload));

    expect(decoded.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!.attributes).toEqual([
      { key: 'big', value: { intValue: '9223372036854775807' } },
      { key: 'small', value: { intValue: '-9223372036854775808' } },
    ]);
  });

  it('emits explicitly-set oneof members that hold their default value', () => {
    // proto3 omits default-valued scalars, but a oneof member is different: if
    // an empty string were skipped, the receiver would see no member set at
    // all and a logged "" would arrive as a missing value.
    const records = [record({ body: '', attributes: { empty: '', zero: 0, no: false } })];
    const decoded = roundTrip(records);
    const logRecord = decoded.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!;

    expect(logRecord.body).toEqual({ stringValue: '' });
    expect(logRecord.attributes).toEqual([
      { key: 'empty', value: { stringValue: '' } },
      { key: 'zero', value: { intValue: '0' } },
      { key: 'no', value: { boolValue: false } },
    ]);
  });

  it('groups records by resource, one resourceLogs entry each', () => {
    const records = [
      record({ resource: { 'service.name': 'api' } }),
      record({ resource: { 'service.name': 'worker' } }),
      record({ resource: { 'service.name': 'api' } }),
    ];

    const decoded = roundTrip(records);

    expect(decoded.resourceLogs).toHaveLength(2);
    expect(decoded.resourceLogs[0]!.scopeLogs[0]!.logRecords).toHaveLength(2);
    expect(decoded.resourceLogs[1]!.scopeLogs[0]!.logRecords).toHaveLength(1);
    expect(decoded.resourceLogs[1]!.resource.attributes).toEqual([
      { key: 'service.name', value: { stringValue: 'worker' } },
    ]);
  });

  it('encodes multi-byte UTF-8 by byte length, not character count', () => {
    // A length prefix counting characters would truncate the payload and
    // desynchronise every field after it.
    const records = [record({ body: 'héllo → 世界', attributes: { emoji: '🚀' } })];
    expect(roundTrip(records)).toEqual(encodeLogsPayload(records));
  });

  it('matches hand-computed bytes, so the decoder cannot mask an encoder bug', () => {
    // An empty envelope. Tags are (field << 3) | wireType, so field 1 with
    // wire type 2 (length-delimited) is 0x0a throughout:
    //
    //   0a 02        resourceLogs[0], length 2
    //     0a 00        resource, length 0 — no attributes, no scopeLogs
    expect([...encodeLogsProtobuf({ resourceLogs: [{ resource: { attributes: [] }, scopeLogs: [] }] })])
      .toEqual([0x0a, 0x02, 0x0a, 0x00]);

    // The same envelope carrying one resource attribute { "a": "b" }:
    //
    //   0a 0c        resourceLogs[0], length 12
    //     0a 0a        resource, length 10
    //       0a 08        attributes[0] (KeyValue), length 8
    //         0a 01 61     key = "a"
    //         12 03        value (AnyValue, field 2), length 3
    //           0a 01 62     stringValue = "b"
    expect([
      ...encodeLogsProtobuf({
        resourceLogs: [
          {
            resource: { attributes: [{ key: 'a', value: { stringValue: 'b' } }] },
            scopeLogs: [],
          },
        ],
      }),
    ]).toEqual([
      0x0a, 0x0c,
      0x0a, 0x0a,
      0x0a, 0x08,
      0x0a, 0x01, 0x61,
      0x12, 0x03,
      0x0a, 0x01, 0x62,
    ]);
  });

  it('matches hand-computed bytes for a full LogRecord', () => {
    // The round-trip tests above pair this encoder with a decoder written from
    // the same reading of the spec, so a shared misunderstanding — a wrong
    // field number, a varint where the proto says fixed64 — would pass both.
    // These bytes are computed from logs.proto by hand and pin the record's
    // field numbers (1, 2, 3, 5, 6) and wire types independently of it.
    const bytes = encodeLogsProtobuf({
      resourceLogs: [
        {
          resource: { attributes: [] },
          scopeLogs: [
            {
              scope: { name: 's' },
              logRecords: [
                {
                  // 0x0102030405060708 — distinct bytes, so the assertion
                  // fails if the fixed64 goes out big-endian.
                  timeUnixNano: '72623859790382856',
                  severityNumber: 9,
                  severityText: 'I',
                  body: { stringValue: 'b' },
                  attributes: [{ key: 'k', value: { stringValue: 'v' } }],
                },
              ],
            },
          ],
        },
      ],
    });

    expect([...bytes]).toEqual([
      0x0a, 0x28,             // resourceLogs[0], length 40
      0x0a, 0x00,             //   resource, length 0
      0x12, 0x24,             //   scopeLogs[0], length 36
      0x0a, 0x03,             //     scope, length 3
      0x0a, 0x01, 0x73,       //       name = "s"
      0x12, 0x1d,             //     logRecords[0], length 29
      // field 1, wire type 1 (fixed64) — little-endian
      0x09, 0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01,
      0x10, 0x09,             //       field 2 varint: severityNumber = 9
      0x1a, 0x01, 0x49,       //       field 3 string: severityText = "I"
      0x2a, 0x03,             //       field 5 message: body, length 3
      0x0a, 0x01, 0x62,       //         stringValue = "b"
      0x32, 0x08,             //       field 6 message: attributes[0], length 8
      0x0a, 0x01, 0x6b,       //         key = "k"
      0x12, 0x03,             //         value, length 3
      0x0a, 0x01, 0x76,       //           stringValue = "v"
    ]);
  });

  it('widens a nested message length prefix past one, two, and three bytes', () => {
    // Lengths are backpatched into a byte reserved before the body is written,
    // so every varint-width boundary is a point where the body has to shift
    // right by exactly the right amount. Off by one and every later field is
    // garbage.
    for (const size of [0, 1, 126, 127, 128, 129, 16382, 16383, 16384, 16385]) {
      const records = [record({ body: 'x'.repeat(size) })];
      expect(roundTrip(records), `body of ${size} bytes`).toEqual(encodeLogsPayload(records));
    }
  });

  it('encodes every finite number an attribute can hold without throwing', () => {
    // A throw here is not one bad attribute — the encoder runs once per batch,
    // so it would cost every record in the batch.
    const numbers = [
      0, -0, 1, -1, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER,
      2 ** 53, 1e19, 1e20, 1e21, Number.MAX_VALUE, Number.MIN_VALUE, 1.5, -1e-7,
    ];
    const records = numbers.map((n) => record({ attributes: { n } }));

    expect(() => encodeLogsProtobuf(encodeLogsPayload(records))).not.toThrow();
    expect(roundTrip(records)).toEqual(encodeLogsPayload(records));
  });

  it('encodes a 64-bit timestamp as little-endian fixed64', () => {
    const decoded = roundTrip([record({ timestamp: '2026-08-08T10:00:00.000Z' })]);
    expect(decoded.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!.timeUnixNano).toBe(
      `${Date.parse('2026-08-08T10:00:00.000Z')}000000`
    );
  });

  it('grows its buffer past the initial allocation', () => {
    // The writer starts at 1KiB; a realistic batch is far larger, and a
    // mis-sized growth would corrupt the stream rather than fail loudly.
    const records = Array.from({ length: 200 }, (_, i) =>
      record({ body: `record ${i} ${'x'.repeat(100)}`, attributes: { index: i } })
    );

    expect(roundTrip(records)).toEqual(encodeLogsPayload(records));
  });
});

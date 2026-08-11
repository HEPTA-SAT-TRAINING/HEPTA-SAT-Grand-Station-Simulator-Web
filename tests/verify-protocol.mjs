import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const { StreamReceiver, crc16, constants } = require("../public/hepta-image-receiver.js");

function le16(value) {
  return [value & 0xFF, (value >> 8) & 0xFF];
}

function packet(type, sequence, total, payload = new Uint8Array()) {
  const crcInput = new Uint8Array(7 + payload.length);
  crcInput.set([type, ...le16(sequence), ...le16(total), ...le16(payload.length)]);
  crcInput.set(payload, 7);
  return new Uint8Array([
    0x48, 0x50, type,
    ...le16(sequence), ...le16(total), ...le16(payload.length),
    ...le16(crc16(crcInput)),
    ...payload
  ]);
}

function concat(...chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

const image = new Uint8Array([
  0xFF, 0xD8, 1, 2, 3, 4, 5, 6,
  7, 8, 9, 10, 11, 12, 0xFF, 0xD9
]);
const payloadSize = 8;
const dataCount = Math.ceil(image.length / payloadSize);
const total = dataCount + 3;
const startPayload = new Uint8Array([
  constants.FORMAT_JPEG,
  ...le16(7),
  image.length, 0, 0, 0,
  ...le16(crc16(image)),
  ...le16(payloadSize)
]);
const data1 = image.slice(0, payloadSize);
const data2 = image.slice(payloadSize);
const parity = new Uint8Array(payloadSize);
for (let i = 0; i < data1.length; i++) parity[i] ^= data1[i];
for (let i = 0; i < data2.length; i++) parity[i] ^= data2[i];

const telemetryBefore = new Uint8Array([0x7E, 1, 0x10, 0, 1, 5, 0, 1, 2, 3, 4, 16]);
const telemetryAfter = new Uint8Array([0x7E, 1, 0x11, 0, 2, 5, 1, 4, 5, 6, 7, 31]);
const stream = concat(
  telemetryBefore,
  new TextEncoder().encode("IMG_BEGIN\n"),
  packet(constants.TYPE_START, 0, total, startPayload),
  packet(constants.TYPE_START, 0, total, startPayload),
  packet(constants.TYPE_DATA, 1, total, data1),
  // DATA 2 is intentionally missing and must be recovered by parity.
  packet(constants.TYPE_PARITY, dataCount + 1, total, parity),
  packet(constants.TYPE_END, total - 1, total),
  new TextEncoder().encode("\nIMG_END\n"),
  telemetryAfter
);

const telemetryChunks = [];
let completed = null;
const errors = [];
const receiver = new StreamReceiver({
  onTelemetryBytes: bytes => telemetryChunks.push(bytes),
  onComplete: result => { completed = result; },
  onError: message => errors.push(message)
});

// Deliberately split marker, header, and payload at arbitrary boundaries.
const splitSizes = [3, 5, 1, 7, 2, 13, 4, 19, 6, 11, 17, 23, 29];
let offset = 0;
let splitIndex = 0;
while (offset < stream.length) {
  const size = splitSizes[splitIndex++ % splitSizes.length];
  receiver.push(stream.slice(offset, Math.min(stream.length, offset + size)));
  offset += size;
}

assert.equal(errors.length, 0, errors.join("; "));
assert.ok(completed, "image should complete");
assert.deepEqual(completed.image, image);
assert.equal(completed.meta.imageId, 7);
assert.equal(completed.recoveredSequence, 2);

const telemetry = concat(...telemetryChunks);
assert.ok(telemetry.length >= telemetryBefore.length + telemetryAfter.length);
assert.deepEqual(telemetry.slice(0, telemetryBefore.length), telemetryBefore);
assert.deepEqual(telemetry.slice(-telemetryAfter.length), telemetryAfter);

// A DATA packet with a bad packet CRC is discarded and recovered by parity.
const corruptData1 = packet(constants.TYPE_DATA, 1, total, data1);
corruptData1[corruptData1.length - 1] ^= 0x01;
const corruptStream = concat(
  new TextEncoder().encode("IMG_BEGIN\n"),
  packet(constants.TYPE_START, 0, total, startPayload),
  corruptData1,
  packet(constants.TYPE_DATA, 2, total, data2),
  packet(constants.TYPE_PARITY, dataCount + 1, total, parity),
  packet(constants.TYPE_END, total - 1, total)
);
let corruptionRecovered = null;
const warnings = [];
const corruptReceiver = new StreamReceiver({
  onComplete: result => { corruptionRecovered = result; },
  onWarning: message => warnings.push(message),
  onError: message => { throw new Error(message); }
});
corruptReceiver.push(corruptStream);
assert.ok(warnings.some(message => message.includes("CRC")));
assert.ok(corruptionRecovered);
assert.deepEqual(corruptionRecovered.image, image);
assert.equal(corruptionRecovered.recoveredSequence, 1);

assert.equal(crc16(new TextEncoder().encode("123456789")), 0x29B1);

// Exercise the decoder that is actually embedded in ground-station.html.
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

const html = fs.readFileSync(new URL("../public/ground-station.html", import.meta.url), "utf8");
const decoderSource = ["byteToHex", "readInt16BE", "decodeMode", "decodePacketTypeMode", "decodeHkPayload"]
  .map(name => extractFunction(html, name))
  .join("\n");
const decoderContext = {
  TELEMETRY_PACKET: { typeHk: 0x10, basicPayloadLength: 5, missionPayloadLength: 23, extendedPayloadLength: 35 }
};
vm.createContext(decoderContext);
vm.runInContext(decoderSource, decoderContext);
const payload = new Uint8Array(35);
payload[0] = 1;
payload.set([0x0B, 0xB8, 0x00, 0xFA], 1); // bus raw=3000, temperature=25.0 C
payload.set([0x13, 0x88, 0x0C, 0xE4, 0x10, 0x68], 23); // 5.000, 3.300, 4.200 V
payload.set([0x00, 0x7B, 0x01, 0xC8, 0x00, 0x4E], 29); // 0.123, 0.456, 0.078 A
decoderContext.input = payload;
const decoded = vm.runInContext("decodeHkPayload(input, 0x11)", decoderContext);
assert.equal(decoded.temperatureC, 25);
assert.equal(decoded.voltage5V, 5);
assert.equal(decoded.voltage3v3, 3.3);
assert.equal(decoded.solarArrayVoltageV, 4.2);
assert.equal(decoded.solarCurrentA, 0.123);
assert.equal(decoded.busCurrentA, 0.456);
assert.equal(decoded.chargeCurrentA, 0.078);

console.log("HEPTA telemetry/image protocol tests passed");

import { ImageAssembler } from "./vendor/hepta-serial-monitor/docs/image_assembler.js";
import {
  ERROR_MESSAGES,
  PACKET_TYPE_END,
  PACKET_TYPE_ERROR,
  PacketReceiver,
} from "./vendor/hepta-serial-monitor/docs/packet.js";

const BEGIN_MARKER = new TextEncoder().encode("IMG_BEGIN\n");
const END_MARKER = new TextEncoder().encode("\nIMG_END\n");
// The Library sends 64-byte DATA packets and uses uint16_t for TOTAL.
// START, PARITY and END consume three sequence numbers.
const IMAGE_SIZE_MAX = (0xffff - 3) * 64;
const PACKET_TIMEOUT_MS = 10_000;
const IMAGE_TIMEOUT_MS = 60_000;

function concatBytes(a, b) {
  const result = new Uint8Array(a.length + b.length);
  result.set(a);
  result.set(b, a.length);
  return result;
}

function indexOfBytes(haystack, needle) {
  outer: for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function trailingPrefixLength(bytes, marker) {
  const maximum = Math.min(bytes.length, marker.length - 1);
  for (let length = maximum; length > 0; length -= 1) {
    let matches = true;
    for (let i = 0; i < length; i += 1) {
      if (bytes[bytes.length - length + i] !== marker[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return length;
  }
  return 0;
}

function validateJpeg(image) {
  if (image.length < 4 || image[0] !== 0xff || image[1] !== 0xd8) {
    throw new Error("Invalid JPEG SOI marker");
  }
  for (let i = 3; i < image.length; i += 1) {
    if (image[i - 1] === 0xff && image[i] === 0xd9) return;
  }
  throw new Error("Invalid JPEG EOI marker");
}

/**
 * Demultiplex telemetry and image bytes around the Library's IMG markers.
 * Packet parsing, CRC checking and parity reconstruction are delegated to the
 * pinned HEPTA-SAT-Serial_Monitor submodule.
 */
export class StreamReceiver {
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    this.mode = "telemetry";
    this.markerBuffer = new Uint8Array(0);
    this.packetReceiver = new PacketReceiver();
    this.assembler = new ImageAssembler();
    this.packetTimer = null;
    this.imageTimer = null;
  }

  push(chunk) {
    if (!(chunk instanceof Uint8Array) || chunk.length === 0) return;
    if (this.mode === "image") this.pushImageBytes(chunk);
    else this.pushTelemetryBytes(chunk);
  }

  pushTelemetryBytes(chunk) {
    const bytes = concatBytes(this.markerBuffer, chunk);
    const markerIndex = indexOfBytes(bytes, BEGIN_MARKER);
    if (markerIndex >= 0) {
      this.emitTelemetry(bytes.slice(0, markerIndex));
      this.markerBuffer = new Uint8Array(0);
      this.beginImage();
      const remainder = bytes.slice(markerIndex + BEGIN_MARKER.length);
      if (remainder.length) this.pushImageBytes(remainder);
      return;
    }

    const keep = trailingPrefixLength(bytes, BEGIN_MARKER);
    this.emitTelemetry(bytes.slice(0, bytes.length - keep));
    this.markerBuffer = keep ? bytes.slice(bytes.length - keep) : new Uint8Array(0);
  }

  emitTelemetry(bytes) {
    if (bytes.length) this.callbacks.onTelemetryBytes?.(bytes);
  }

  beginImage() {
    this.mode = "image";
    this.packetReceiver.reset();
    this.assembler.reset();
    this.callbacks.onBegin?.();
    this.startImageTimeout();
    this.resetPacketTimeout();
  }

  pushImageBytes(chunk) {
    const packets = this.packetReceiver.push(chunk);
    for (const warning of this.packetReceiver.drainErrors()) {
      this.callbacks.onWarning?.(warning);
      this.resetPacketTimeout();
    }

    for (const packet of packets) {
      if (this.mode !== "image") break;
      try {
        this.resetPacketTimeout();
        if (packet.type === PACKET_TYPE_ERROR) {
          const code = packet.payload[0] || 0;
          throw new Error(ERROR_MESSAGES[code] || `image sender error: 0x${code.toString(16)}`);
        }

        this.assembler.accept(packet);
        if (this.assembler.meta?.imageSize > IMAGE_SIZE_MAX) {
          throw new Error(`Image size exceeds the limit: ${this.assembler.meta.imageSize} bytes`);
        }
        this.callbacks.onProgress?.(this.assembler.getReceptionSummary());

        if (packet.type === PACKET_TYPE_END) {
          const strictResult = this.assembler.finalize();
          validateJpeg(strictResult.image);
          this.callbacks.onComplete?.({
            ...strictResult,
            // Keep the existing Grand Station UI field name stable.
            recoveredSequence: strictResult.recoveredSeq,
          });
          this.finishImage();
        }
      } catch (error) {
        this.failImage(error instanceof Error ? error.message : String(error));
      }
    }
  }

  finishImage() {
    this.clearTimers();
    this.mode = "telemetry";
    const remainder = this.packetReceiver.buffer.slice();
    this.packetReceiver.reset();
    this.assembler.reset();
    if (!remainder.length) return;

    const footerIndex = indexOfBytes(remainder, END_MARKER);
    const afterFooter = footerIndex >= 0
      ? remainder.slice(footerIndex + END_MARKER.length)
      : remainder;
    if (afterFooter.length) this.pushTelemetryBytes(afterFooter);
  }

  failImage(message) {
    this.callbacks.onError?.(message);
    this.clearTimers();
    this.mode = "telemetry";
    this.markerBuffer = new Uint8Array(0);
    this.packetReceiver.reset();
    this.assembler.reset();
  }

  resetPacketTimeout() {
    clearTimeout(this.packetTimer);
    this.packetTimer = setTimeout(
      () => this.failImage("Image packet timeout (10 s)"),
      PACKET_TIMEOUT_MS,
    );
  }

  startImageTimeout() {
    clearTimeout(this.imageTimer);
    this.imageTimer = setTimeout(
      () => this.failImage("Image reception timeout (60 s)"),
      IMAGE_TIMEOUT_MS,
    );
  }

  clearTimers() {
    clearTimeout(this.packetTimer);
    clearTimeout(this.imageTimer);
    this.packetTimer = null;
    this.imageTimer = null;
  }

  reset() {
    this.clearTimers();
    this.mode = "telemetry";
    this.markerBuffer = new Uint8Array(0);
    this.packetReceiver.reset();
    this.assembler.reset();
  }
}

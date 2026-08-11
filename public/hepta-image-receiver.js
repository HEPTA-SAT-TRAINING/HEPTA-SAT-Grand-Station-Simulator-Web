(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.HeptaImage = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MAGIC = new Uint8Array([0x48, 0x50]); // HP
  const BEGIN_MARKER = new TextEncoder().encode("IMG_BEGIN\n");
  const END_MARKER = new TextEncoder().encode("\nIMG_END\n");
  const HEADER_SIZE = 11;
  const PAYLOAD_MAX = 512;
  // Library uses 64-byte DATA payloads and a uint16 TOTAL field. Reserve
  // START, PARITY, and END sequence numbers.
  const IMAGE_SIZE_MAX = (0xFFFF - 3) * 64;
  const PACKET_TIMEOUT_MS = 10000;
  const IMAGE_TIMEOUT_MS = 60000;

  const TYPE_START = 0x01;
  const TYPE_DATA = 0x02;
  const TYPE_END = 0x03;
  const TYPE_ERROR = 0x04;
  const TYPE_PARITY = 0x05;
  const FORMAT_JPEG = 0x01;

  const ERROR_MESSAGES = {
    0x01: "画像ファイルがありません",
    0x02: "カメラ撮影に失敗しました",
    0x03: "画像サイズが上限を超えています",
    0x04: "画像送信バッファでエラーが発生しました"
  };

  function concatBytes(a, b) {
    const result = new Uint8Array(a.length + b.length);
    result.set(a);
    result.set(b, a.length);
    return result;
  }

  function indexOfBytes(haystack, needle) {
    outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  function trailingPrefixLength(bytes, marker) {
    const max = Math.min(bytes.length, marker.length - 1);
    for (let length = max; length > 0; length--) {
      let matches = true;
      for (let i = 0; i < length; i++) {
        if (bytes[bytes.length - length + i] !== marker[i]) {
          matches = false;
          break;
        }
      }
      if (matches) return length;
    }
    return 0;
  }

  function crc16(bytes) {
    let crc = 0xFFFF;
    for (const byte of bytes) {
      crc ^= byte << 8;
      for (let bit = 0; bit < 8; bit++) {
        crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
      }
    }
    return crc;
  }

  function readLe16(view, offset) {
    return view.getUint16(offset, true);
  }

  function readLe32(view, offset) {
    return view.getUint32(offset, true);
  }

  function parsePacket(raw) {
    if (raw.length < HEADER_SIZE || raw[0] !== MAGIC[0] || raw[1] !== MAGIC[1]) {
      throw new Error("画像packetのMAGICが不正です");
    }
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const type = raw[2];
    const sequence = readLe16(view, 3);
    const total = readLe16(view, 5);
    const length = readLe16(view, 7);
    const receivedCrc = readLe16(view, 9);
    if (length > PAYLOAD_MAX || raw.length < HEADER_SIZE + length) {
      throw new Error(`画像packet lengthが不正です: ${length}`);
    }
    const payload = raw.slice(HEADER_SIZE, HEADER_SIZE + length);
    const crcInput = new Uint8Array(7 + length);
    const crcView = new DataView(crcInput.buffer);
    crcInput[0] = type;
    crcView.setUint16(1, sequence, true);
    crcView.setUint16(3, total, true);
    crcView.setUint16(5, length, true);
    crcInput.set(payload, 7);
    const expectedCrc = crc16(crcInput);
    if (receivedCrc !== expectedCrc) {
      throw new Error(`画像packet CRC不一致 (seq=${sequence})`);
    }
    return { type, sequence, total, payload };
  }

  class ImageAssembler {
    constructor() {
      this.reset();
    }

    reset() {
      this.meta = null;
      this.total = 0;
      this.dataPacketCount = 0;
      this.dataPackets = new Map();
      this.parity = null;
    }

    accept(packet) {
      if (packet.type === TYPE_START) {
        this.acceptStart(packet);
        return;
      }
      if (!this.meta) throw new Error("STARTより前に画像dataを受信しました");
      if (packet.total !== this.total) throw new Error("画像packet TOTALが一致しません");
      if (packet.type === TYPE_DATA) this.acceptData(packet);
      else if (packet.type === TYPE_PARITY) this.acceptParity(packet);
      else if (packet.type !== TYPE_END) throw new Error(`未対応の画像packet type: ${packet.type}`);
    }

    acceptStart(packet) {
      if (packet.sequence !== 0 || packet.payload.length < 11) {
        throw new Error("画像START packetが不正です");
      }
      const view = new DataView(packet.payload.buffer, packet.payload.byteOffset, packet.payload.byteLength);
      const meta = {
        format: packet.payload[0],
        imageId: readLe16(view, 1),
        imageSize: readLe32(view, 3),
        imageCrc: readLe16(view, 7),
        dataPayloadSize: readLe16(view, 9)
      };
      if (meta.format !== FORMAT_JPEG) throw new Error("JPEG以外の画像形式です");
      if (meta.imageSize === 0 || meta.imageSize > IMAGE_SIZE_MAX) {
        throw new Error(`画像サイズが不正です: ${meta.imageSize} bytes`);
      }
      if (meta.dataPayloadSize === 0 || meta.dataPayloadSize > PAYLOAD_MAX) {
        throw new Error(`画像data payload sizeが不正です: ${meta.dataPayloadSize}`);
      }
      const dataPacketCount = Math.ceil(meta.imageSize / meta.dataPayloadSize);
      if (packet.total !== dataPacketCount + 3) throw new Error("画像packet数が一致しません");
      if (this.meta) {
        if (JSON.stringify(meta) !== JSON.stringify(this.meta)) {
          throw new Error("重複START packetの内容が一致しません");
        }
        return;
      }
      this.meta = meta;
      this.total = packet.total;
      this.dataPacketCount = dataPacketCount;
    }

    expectedLength(sequence) {
      if (sequence < this.dataPacketCount) return this.meta.dataPayloadSize;
      return this.meta.imageSize - (this.dataPacketCount - 1) * this.meta.dataPayloadSize;
    }

    acceptData(packet) {
      if (packet.sequence < 1 || packet.sequence > this.dataPacketCount) {
        throw new Error(`画像DATA sequenceが範囲外です: ${packet.sequence}`);
      }
      if (packet.payload.length !== this.expectedLength(packet.sequence)) {
        throw new Error(`画像DATA lengthが不正です: seq=${packet.sequence}`);
      }
      const existing = this.dataPackets.get(packet.sequence);
      if (existing && !equalBytes(existing, packet.payload)) {
        throw new Error(`重複画像DATAが一致しません: seq=${packet.sequence}`);
      }
      if (!existing) this.dataPackets.set(packet.sequence, packet.payload.slice());
    }

    acceptParity(packet) {
      if (packet.sequence !== this.dataPacketCount + 1
          || packet.payload.length !== this.meta.dataPayloadSize) {
        throw new Error("画像PARITY packetが不正です");
      }
      this.parity = packet.payload.slice();
    }

    summary() {
      if (!this.meta) return { receivedBytes: 0, imageSize: 0, receivedCount: 0, dataPacketCount: 0 };
      let receivedBytes = 0;
      for (const payload of this.dataPackets.values()) receivedBytes += payload.length;
      return {
        receivedBytes,
        imageSize: this.meta.imageSize,
        receivedCount: this.dataPackets.size,
        dataPacketCount: this.dataPacketCount
      };
    }

    finalize() {
      if (!this.meta) throw new Error("画像START packetを受信していません");
      const packets = new Map(this.dataPackets);
      const missing = [];
      for (let seq = 1; seq <= this.dataPacketCount; seq++) {
        if (!packets.has(seq)) missing.push(seq);
      }
      let recoveredSequence = null;
      if (missing.length === 1 && this.parity) {
        recoveredSequence = missing[0];
        const recovered = this.parity.slice();
        for (const payload of packets.values()) {
          for (let i = 0; i < payload.length; i++) recovered[i] ^= payload[i];
        }
        packets.set(recoveredSequence, recovered.slice(0, this.expectedLength(recoveredSequence)));
      }
      const remainingMissing = missing.filter(seq => !packets.has(seq));
      if (remainingMissing.length) {
        throw new Error(`画像DATA packetが${remainingMissing.length}個欠損しています`);
      }
      const image = new Uint8Array(this.meta.imageSize);
      let offset = 0;
      for (let seq = 1; seq <= this.dataPacketCount; seq++) {
        const payload = packets.get(seq);
        image.set(payload, offset);
        offset += payload.length;
      }
      const computedCrc = crc16(image);
      if (computedCrc !== this.meta.imageCrc) throw new Error("画像全体CRCが一致しません");
      let hasEoi = false;
      for (let i = 1; i < image.length; i++) {
        if (image[i - 1] === 0xFF && image[i] === 0xD9) {
          hasEoi = true;
          break;
        }
      }
      // Arducam FIFO data can contain padding after EOI, matching the Library
      // camera_snapshot() validation. CRC still covers every transmitted byte.
      if (image[0] !== 0xFF || image[1] !== 0xD8 || !hasEoi) {
        throw new Error("JPEGのSOI/EOI markerが不正です");
      }
      return { image, meta: this.meta, computedCrc, recoveredSequence };
    }
  }

  function equalBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  class StreamReceiver {
    constructor(callbacks = {}) {
      this.callbacks = callbacks;
      this.mode = "telemetry";
      this.markerBuffer = new Uint8Array(0);
      this.packetBuffer = new Uint8Array(0);
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
      if (bytes.length && this.callbacks.onTelemetryBytes) this.callbacks.onTelemetryBytes(bytes);
    }

    beginImage() {
      this.mode = "image";
      this.packetBuffer = new Uint8Array(0);
      this.assembler.reset();
      this.callbacks.onBegin?.();
      this.startImageTimeout();
      this.resetPacketTimeout();
    }

    pushImageBytes(chunk) {
      this.packetBuffer = concatBytes(this.packetBuffer, chunk);
      while (this.mode === "image") {
        const magicIndex = indexOfBytes(this.packetBuffer, MAGIC);
        if (magicIndex < 0) {
          const keep = trailingPrefixLength(this.packetBuffer, MAGIC);
          this.packetBuffer = keep ? this.packetBuffer.slice(-keep) : new Uint8Array(0);
          return;
        }
        if (magicIndex > 0) this.packetBuffer = this.packetBuffer.slice(magicIndex);
        if (this.packetBuffer.length < HEADER_SIZE) return;
        const view = new DataView(this.packetBuffer.buffer, this.packetBuffer.byteOffset, this.packetBuffer.byteLength);
        const length = readLe16(view, 7);
        if (length > PAYLOAD_MAX) {
          this.packetBuffer = this.packetBuffer.slice(1);
          this.callbacks.onWarning?.(`画像packet lengthを破棄しました: ${length}`);
          continue;
        }
        const packetLength = HEADER_SIZE + length;
        if (this.packetBuffer.length < packetLength) return;
        const raw = this.packetBuffer.slice(0, packetLength);
        this.packetBuffer = this.packetBuffer.slice(packetLength);
        let packet;
        try {
          packet = parsePacket(raw);
          this.resetPacketTimeout();
          if (packet.type === TYPE_ERROR) {
            const code = packet.payload[0] || 0;
            throw new Error(ERROR_MESSAGES[code] || `画像送信error: 0x${code.toString(16)}`);
          }
          this.assembler.accept(packet);
          this.callbacks.onProgress?.(this.assembler.summary());
          if (packet.type === TYPE_END) {
            const result = this.assembler.finalize();
            this.callbacks.onComplete?.(result);
            this.finishImage();
          }
        } catch (error) {
          // Treat a corrupt DATA packet as missing so the reference XOR parity
          // packet can recover one loss. Control-packet corruption is fatal.
          if ((packet && packet.type === TYPE_DATA) || raw[2] === TYPE_DATA) {
            this.callbacks.onWarning?.(error.message || String(error));
            continue;
          }
          this.failImage(error.message || String(error));
        }
      }
    }

    finishImage() {
      this.clearTimers();
      this.mode = "telemetry";
      const remainder = this.packetBuffer;
      this.packetBuffer = new Uint8Array(0);
      this.assembler.reset();
      if (remainder.length) {
        const footerIndex = indexOfBytes(remainder, END_MARKER);
        const afterFooter = footerIndex >= 0
          ? remainder.slice(footerIndex + END_MARKER.length)
          : remainder;
        if (afterFooter.length) this.pushTelemetryBytes(afterFooter);
      }
    }

    failImage(message) {
      this.callbacks.onError?.(message);
      this.clearTimers();
      this.mode = "telemetry";
      this.packetBuffer = new Uint8Array(0);
      this.markerBuffer = new Uint8Array(0);
      this.assembler.reset();
    }

    resetPacketTimeout() {
      clearTimeout(this.packetTimer);
      this.packetTimer = setTimeout(() => this.failImage("画像packet timeout (10秒)"), PACKET_TIMEOUT_MS);
    }

    startImageTimeout() {
      clearTimeout(this.imageTimer);
      this.imageTimer = setTimeout(() => this.failImage("画像受信timeout (60秒)"), IMAGE_TIMEOUT_MS);
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
      this.packetBuffer = new Uint8Array(0);
      this.assembler.reset();
    }
  }

  return {
    StreamReceiver,
    ImageAssembler,
    crc16,
    parsePacket,
    constants: {
      TYPE_START, TYPE_DATA, TYPE_END, TYPE_ERROR, TYPE_PARITY,
      FORMAT_JPEG, HEADER_SIZE, PAYLOAD_MAX, IMAGE_SIZE_MAX
    }
  };
});

/*
 * YogAI phone-mount controller integration.
 * Uses the existing YogAI MediaPipe landmarks; it does not open a second camera
 * or create a second PoseLandmarker.
 * USB transports mirror the working YogAI Phone Tracker WebUSB CDC path.
 */

const CDC_COMM_CLASS = 0x02;
const CDC_DATA_CLASS = 0x0a;
const SET_LINE_CODING = 0x20;
const SET_CONTROL_LINE_STATE = 0x22;
const DTR_RTS_ON = 0x03;
const ARDUINO_USB_FILTERS = Object.freeze([
  { vendorId: 0x2341 },
  { vendorId: 0x2a03 },
  { classCode: CDC_COMM_CLASS },
]);

export const MOUNT_FIRMWARE_LIMITS = Object.freeze({
  baudRate: 115200,
  yawMin: 45,
  yawMax: 135,
  yawNeutral: 90,
  tiltMin: 60,
  tiltMax: 120,
  tiltNeutral: 90,
});

export const MOUNT_DEFAULTS = Object.freeze({
  deadZoneX: 0.08,
  deadZoneY: 0.08,
  emaAlpha: 0.40,
  gainYaw: 24,
  gainTilt: 24,
  maxSpeedDegPerS: 45,
  controlHz: 20,
  yawDirection: 1,
  tiltDirection: 1,
  minVisibility: 0.5,
  minVisibleLandmarks: 8,
  minBboxFraction: 0.05,
  reacquireResetMs: 700,
  bootWaitMs: 2500,
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function formatMountCommand(yaw, tilt) {
  const y = Number(yaw);
  const t = Number(tilt);
  if (!Number.isInteger(y) || !Number.isInteger(t)) {
    throw new TypeError('Yaw and tilt must be integer degrees.');
  }
  if (y < 0 || y > 180 || t < 0 || t > 180) {
    throw new RangeError('Yaw and tilt must be between 0 and 180 degrees.');
  }
  return `${y},${t}\n`;
}

function buildLineCoding(baudRate) {
  const bytes = new Uint8Array(7);
  new DataView(bytes.buffer).setUint32(0, baudRate, true);
  bytes[4] = 0; // one stop bit
  bytes[5] = 0; // no parity
  bytes[6] = 8; // eight data bits
  return bytes;
}

function findCdcInterfaces(configuration) {
  const interfaces = configuration?.interfaces ?? [];
  let control = null;
  let data = null;
  for (const iface of interfaces) {
    const alt = iface.alternates?.[0];
    if (!alt) continue;
    if (alt.interfaceClass === CDC_COMM_CLASS && !control) {
      control = { number: iface.interfaceNumber, alternate: alt.alternateSetting ?? 0 };
    }
    if (alt.interfaceClass === CDC_DATA_CLASS && !data) {
      const bulkIn = alt.endpoints?.find((e) => e.direction === 'in' && e.type === 'bulk');
      const bulkOut = alt.endpoints?.find((e) => e.direction === 'out' && e.type === 'bulk');
      if (bulkIn && bulkOut) {
        data = {
          number: iface.interfaceNumber,
          alternate: alt.alternateSetting ?? 0,
          inEndpoint: bulkIn.endpointNumber,
          outEndpoint: bulkOut.endpointNumber,
          inPacketSize: bulkIn.packetSize || 64,
        };
      }
    }
  }
  return control && data ? { control, data } : null;
}

export class WebUsbCdcTransport {
  constructor({ baudRate, bootWaitMs, onStatus, onLine, onDisconnect, assertDtr = true }) {
    this.assertDtr = assertDtr;
    this.usbApi = globalThis.navigator?.usb;
    this.baudRate = baudRate;
    this.bootWaitMs = bootWaitMs;
    this.onStatus = onStatus;
    this.onLine = onLine;
    this.onDisconnect = onDisconnect;
    this.device = null;
    this.layout = null;
    this.connected = false;
    this.closing = false;
    this.readTask = null;
    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder();
    this.claimed = [];
    this.disconnectHandler = null;
  }

  async connect() {
    if (!this.usbApi?.requestDevice) throw new Error('WebUSB is unavailable in this browser.');
    if (this.connected) return true;
    if (this.device) throw new Error('A USB connection is already opening.');
    this.onStatus('Choose your Arduino Uno in the Android USB chooser…', 'info');
    // Must remain the first awaited operation so requestDevice is tied to the click.
    const device = await this.usbApi.requestDevice({ filters: [...ARDUINO_USB_FILTERS] });
    this.device = device;
    this.closing = false;

    try {
      await device.open();
      if (!device.configuration) await device.selectConfiguration(1);
      this.layout = findCdcInterfaces(device.configuration);
      if (!this.layout) {
        throw new Error('This USB device is not a standard CDC-ACM serial bridge. An Uno R3 with ATmega16U2 is supported; CH340/CP210x/FTDI require another transport.');
      }
      const { control, data } = this.layout;
      await device.claimInterface(control.number);
      this.claimed.push(control.number);
      if (data.number !== control.number) {
        await device.claimInterface(data.number);
        this.claimed.push(data.number);
      }
      if (data.alternate) await device.selectAlternateInterface(data.number, data.alternate);

      this.disconnectHandler = (event) => {
        if (event.device === this.device && !this.closing) {
          this.connected = false;
          this.closing = true;
          this.onStatus('Arduino USB disconnected. Reconnect the cable and connect again.', 'error');
          this.onDisconnect(new Error('USB device disconnected.'));
        }
      };
      this.usbApi.addEventListener?.('disconnect', this.disconnectHandler);

      await device.controlTransferOut(
        { requestType: 'class', recipient: 'interface', request: SET_LINE_CODING, value: 0, index: control.number },
        buildLineCoding(this.baudRate),
      );
      // DTR resets the Uno, matching the Web Serial connection sequence.
      // assertDtr=false leaves the line state at 0 so the Uno is not reset (experimental, used by the
      // continuous-rotation mount to keep its state across a reconnect).
      await device.controlTransferOut({
        requestType: 'class', recipient: 'interface', request: SET_CONTROL_LINE_STATE,
        value: this.assertDtr ? DTR_RTS_ON : 0x00, index: control.number,
      });

      this.readTask = this.readLoop();
      this.onStatus('USB opened. Waiting for the Uno to restart…', 'info');
      await sleep(this.bootWaitMs);
      if (!this.device || this.closing) throw new Error('The Arduino disconnected while starting.');
      this.connected = true;
      this.onStatus('Arduino connected through WebUSB.', 'success');
      return true;
    } catch (error) {
      await this.disconnect().catch(() => {});
      throw this.friendlyError(error);
    }
  }

  friendlyError(error) {
    if (['SecurityError', 'NetworkError', 'InvalidStateError'].includes(error?.name)) {
      return new Error(`${error.message || error.name}. Close ArduinoDroid or any other app using the Uno, unplug and reconnect it, then retry.`);
    }
    return error;
  }

  async readLoop() {
    let buffer = '';
    const { inEndpoint, inPacketSize } = this.layout.data;
    try {
      while (this.device && !this.closing) {
        const result = await this.device.transferIn(inEndpoint, inPacketSize);
        if (result.status === 'stall') {
          await this.device.clearHalt('in', inEndpoint);
          continue;
        }
        if (result.status === 'babble' || !result.data || !result.data.byteLength) continue;
        buffer += this.decoder.decode(result.data, { stream: true });
        if (buffer.length > 2048) buffer = buffer.slice(-512);
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const raw of lines) {
          const line = raw.trim();
          if (line) this.onLine(line);
        }
      }
    } catch (error) {
      if (!this.closing) {
        this.connected = false;
        this.onStatus(`USB read error: ${error?.message || error}`, 'error');
        this.onDisconnect(error);
      }
    }
  }

  async sendRaw(text) {
    if (!this.connected || !this.device || !this.layout) throw new Error('Arduino is not connected.');
    const result = await this.device.transferOut(this.layout.data.outEndpoint, this.encoder.encode(text));
    if (result.status && result.status !== 'ok') throw new Error(`USB write failed (${result.status}).`);
    return text;
  }

  async sendAngles(yaw, tilt) {
    if (!this.connected || !this.device || !this.layout) throw new Error('Arduino is not connected.');
    const command = formatMountCommand(yaw, tilt);
    const result = await this.device.transferOut(this.layout.data.outEndpoint, this.encoder.encode(command));
    if (result.status && result.status !== 'ok') throw new Error(`USB write failed (${result.status}).`);
    return command;
  }

  async disconnect() {
    this.closing = true;
    this.connected = false;
    const device = this.device;
    const layout = this.layout;
    this.device = null;
    this.layout = null;
    if (this.disconnectHandler) {
      this.usbApi?.removeEventListener?.('disconnect', this.disconnectHandler);
      this.disconnectHandler = null;
    }
    if (device) {
      if (layout) {
        try {
          await device.controlTransferOut({
            requestType: 'class', recipient: 'interface', request: SET_CONTROL_LINE_STATE,
            value: 0, index: layout.control.number,
          });
        } catch { /* device may already be gone */ }
      }
      for (const number of this.claimed.splice(0)) {
        try { await device.releaseInterface(number); } catch { /* already released */ }
      }
      try { await device.close(); } catch { /* already closed */ }
    }
    if (this.readTask) {
      try { await this.readTask; } catch { /* read loop handles transport errors */ }
      this.readTask = null;
    }
    this.onStatus('Arduino disconnected.', 'info');
  }
}

export class WebSerialTransport {
  constructor({ baudRate, bootWaitMs, onStatus, onLine, onDisconnect }) {
    this.serialApi = globalThis.navigator?.serial;
    this.baudRate = baudRate;
    this.bootWaitMs = bootWaitMs;
    this.onStatus = onStatus;
    this.onLine = onLine;
    this.onDisconnect = onDisconnect;
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.readTask = null;
    this.connected = false;
    this.closing = false;
    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder();
  }

  async connect() {
    if (!this.serialApi?.requestPort) throw new Error('Web Serial is unavailable in this browser.');
    this.onStatus('Choose the Arduino USB serial port…', 'info');
    const port = await this.serialApi.requestPort();
    this.port = port;
    this.closing = false;
    try {
      await port.open({ baudRate: this.baudRate, bufferSize: 256 });
      if (!port.readable || !port.writable) throw new Error('The selected device did not expose serial streams.');
      this.reader = port.readable.getReader();
      this.writer = port.writable.getWriter();
      this.readTask = this.readLoop();
      this.onStatus('USB serial opened. Waiting for the Uno to restart…', 'info');
      await sleep(this.bootWaitMs);
      if (!this.port || this.closing) throw new Error('The Arduino serial connection ended while starting.');
      this.connected = true;
      this.onStatus('Arduino connected through Web Serial.', 'success');
      return true;
    } catch (error) {
      await this.disconnect().catch(() => {});
      throw error;
    }
  }

  async readLoop() {
    let buffer = '';
    try {
      while (this.reader && !this.closing) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (!value) continue;
        buffer += this.decoder.decode(value, { stream: true });
        if (buffer.length > 2048) buffer = buffer.slice(-512);
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const raw of lines) {
          const line = raw.trim();
          if (line) this.onLine(line);
        }
      }
    } catch (error) {
      if (!this.closing) {
        this.connected = false;
        this.onStatus(`Serial read error: ${error?.message || error}`, 'error');
        this.onDisconnect(error);
      }
    } finally {
      try { this.reader?.releaseLock(); } catch { /* already released */ }
      this.reader = null;
      if (!this.closing && this.port) {
        this.connected = false;
        this.onStatus('Arduino serial connection ended.', 'error');
        this.onDisconnect(new Error('Serial stream ended.'));
      }
    }
  }

  async sendRaw(text) {
    if (!this.connected || !this.writer) throw new Error('Arduino is not connected.');
    await this.writer.write(this.encoder.encode(text));
    return text;
  }

  async sendAngles(yaw, tilt) {
    if (!this.connected || !this.writer) throw new Error('Arduino is not connected.');
    const command = formatMountCommand(yaw, tilt);
    await this.writer.write(this.encoder.encode(command));
    return command;
  }

  async disconnect() {
    this.closing = true;
    this.connected = false;
    if (this.reader) {
      try { await this.reader.cancel(); } catch { /* device may be unplugged */ }
    }
    if (this.readTask) {
      try { await this.readTask; } catch { /* already handled */ }
    }
    if (this.writer) {
      try { await this.writer.close(); } catch { /* already closed */ }
      try { this.writer.releaseLock(); } catch { /* already released */ }
      this.writer = null;
    }
    const port = this.port;
    this.port = null;
    this.reader = null;
    this.readTask = null;
    if (port) {
      try { await port.close(); } catch { /* already closed */ }
    }
    this.onStatus('Arduino disconnected.', 'info');
  }
}

export function findPersonCentre(landmarks, settings) {
  if (!Array.isArray(landmarks)) return null;
  const points = landmarks.filter((lm) =>
    Number.isFinite(lm?.x) && Number.isFinite(lm?.y) &&
    lm.x >= 0 && lm.x <= 1 && lm.y >= 0 && lm.y <= 1 &&
    (lm.visibility ?? 1) >= settings.minVisibility,
  );
  if (points.length < settings.minVisibleLandmarks) return null;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  if (Math.max(maxX - minX, maxY - minY) < settings.minBboxFraction) return null;
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

/**
 * Creates one USB connection and a bounded closed-loop controller.
 * The host camera must physically move with the phone mount for auto tracking.
 */
export function createYogaiArduinoMount({ onStatus = () => {}, onAngles = () => {}, onTrackingState = () => {} } = {}) {
  let transport = null;
  let transportKind = null;
  let tracking = false;
  let yaw = MOUNT_FIRMWARE_LIMITS.yawNeutral;
  let tilt = MOUNT_FIRMWARE_LIMITS.tiltNeutral;
  let settings = { ...MOUNT_DEFAULTS };
  let filteredX = null;
  let filteredY = null;
  let lastSeenMs = null;
  let lastSentMs = 0;
  let lastSentKey = '';
  let sendChain = Promise.resolve();

  const isConnected = () => !!transport?.connected;
  const getAngles = () => ({ yaw: Math.round(yaw), tilt: Math.round(tilt) });
  const reportAngles = () => onAngles(getAngles());
  const setState = (text, kind = 'info') => onTrackingState(text, kind);

  function chooseTransport(kind = 'auto') {
    if (kind === 'web-usb') return 'web-usb';
    if (kind === 'web-serial') return 'web-serial';
    const isAndroid = /Android/i.test(globalThis.navigator?.userAgent || '');
    if (isAndroid && globalThis.navigator?.usb?.requestDevice) return 'web-usb';
    if (globalThis.navigator?.serial?.requestPort) return 'web-serial';
    if (globalThis.navigator?.usb?.requestDevice) return 'web-usb';
    return 'none';
  }

  async function connect(kind = 'auto') {
    if (isConnected()) return true;
    if (transport) {
      await transport.disconnect().catch(() => {});
      transport = null;
    }
    const selected = chooseTransport(kind);
    if (selected === 'none') throw new Error('This browser exposes neither WebUSB nor Web Serial.');
    transportKind = selected;
    const callbacks = {
      baudRate: MOUNT_FIRMWARE_LIMITS.baudRate,
      bootWaitMs: settings.bootWaitMs,
      onStatus,
      onLine: (line) => {
        if (line === 'READY') onStatus('Arduino replied READY. Firmware is running.', 'success');
        else if (line === 'ERR') onStatus('Arduino replied ERR. Check that firmware limits match this panel.', 'error');
        else onStatus(`Arduino: ${line}`, 'info');
      },
      onDisconnect: (error) => {
        if (tracking) stopTracking('USB connection lost. Automatic tracking stopped.');
        onStatus(`Arduino disconnected${error?.message ? `: ${error.message}` : '.'}`, 'error');
      },
    };
    transport = selected === 'web-usb' ? new WebUsbCdcTransport(callbacks) : new WebSerialTransport(callbacks);
    try {
      await transport.connect();
      reportAngles();
      onStatus(`Connected via ${selected === 'web-usb' ? 'WebUSB' : 'Web Serial'}.`, 'success');
      return true;
    } catch (error) {
      transport = null;
      transportKind = null;
      throw error;
    }
  }

  async function sendAngles(nextYaw, nextTilt, { force = false } = {}) {
    if (!isConnected()) throw new Error('Connect the Arduino first.');
    yaw = clamp(Math.round(nextYaw), MOUNT_FIRMWARE_LIMITS.yawMin, MOUNT_FIRMWARE_LIMITS.yawMax);
    tilt = clamp(Math.round(nextTilt), MOUNT_FIRMWARE_LIMITS.tiltMin, MOUNT_FIRMWARE_LIMITS.tiltMax);
    reportAngles();
    const commandKey = `${yaw},${tilt}`;
    const now = performance.now();
    if (!force && commandKey === lastSentKey) return false;
    if (!force && now - lastSentMs < 35) return false;
    lastSentKey = commandKey;
    lastSentMs = now;
    const targetTransport = transport;
    const sendYaw = yaw;
    const sendTilt = tilt;
    sendChain = sendChain.catch(() => {}).then(() => {
      if (!targetTransport?.connected) throw new Error('Arduino connection ended before the command was sent.');
      return targetTransport.sendAngles(sendYaw, sendTilt);
    });
    await sendChain;
    return true;
  }

  async function disconnect() {
    stopTracking('Arduino disconnected. Automatic tracking is off.');
    const old = transport;
    transport = null;
    transportKind = null;
    if (old) await old.disconnect();
    onStatus('Arduino disconnected.', 'info');
  }

  async function centre() {
    if (tracking) throw new Error('Stop automatic tracking before using manual controls.');
    await sendAngles(MOUNT_FIRMWARE_LIMITS.yawNeutral, MOUNT_FIRMWARE_LIMITS.tiltNeutral, { force: true });
  }

  async function nudge(axis, direction, step = 5) {
    if (tracking) throw new Error('Stop automatic tracking before using manual controls.');
    const current = getAngles();
    const amount = clamp(Number(step) || 5, 1, 15) * (direction < 0 ? -1 : 1);
    if (axis === 'yaw') current.yaw += amount;
    else if (axis === 'tilt') current.tilt += amount;
    else throw new TypeError('Unknown servo axis.');
    await sendAngles(current.yaw, current.tilt, { force: true });
  }

  function setSettings(next = {}) {
    settings = {
      ...settings,
      ...next,
      deadZoneX: clamp(Number(next.deadZoneX ?? settings.deadZoneX), 0.02, 0.25),
      deadZoneY: clamp(Number(next.deadZoneY ?? settings.deadZoneY), 0.02, 0.25),
      emaAlpha: clamp(Number(next.emaAlpha ?? settings.emaAlpha), 0.15, 0.8),
      gainYaw: clamp(Number(next.gainYaw ?? settings.gainYaw), 5, 45),
      gainTilt: clamp(Number(next.gainTilt ?? settings.gainTilt), 5, 45),
      maxSpeedDegPerS: clamp(Number(next.maxSpeedDegPerS ?? settings.maxSpeedDegPerS), 10, 90),
      yawDirection: Number(next.yawDirection ?? settings.yawDirection) === -1 ? -1 : 1,
      tiltDirection: Number(next.tiltDirection ?? settings.tiltDirection) === -1 ? -1 : 1,
    };
  }

  function startTracking() {
    if (!isConnected()) throw new Error('Connect the Arduino before starting servo tracking.');
    if (tracking) return;
    filteredX = null;
    filteredY = null;
    lastSeenMs = null;
    tracking = true;
    setState('SERVO TRACKING ACTIVE', 'success');
  }

  function stopTracking(message = 'Servo tracking stopped. The Arduino holds its last target.') {
    if (!tracking) return;
    tracking = false;
    filteredX = null;
    filteredY = null;
    lastSeenMs = null;
    setState('SERVO TRACKING OFF', 'info');
    onStatus(message, 'info');
  }

  async function updateFromLandmarks(landmarks, timestampMs = performance.now()) {
    if (!tracking || !isConnected()) return null;
    const centre = findPersonCentre(landmarks, settings);
    if (!centre) {
      setState('NO PERSON · SERVOS HOLDING', 'info');
      return null;
    }
    const gapMs = lastSeenMs === null ? 0 : timestampMs - lastSeenMs;
    const reacquired = lastSeenMs !== null && gapMs > settings.reacquireResetMs;
    if (reacquired) {
      filteredX = null;
      filteredY = null;
    }
    const dt = lastSeenMs === null || reacquired ? 1 / settings.controlHz : clamp(gapMs / 1000, 0, 0.15);
    lastSeenMs = timestampMs;
    if (filteredX === null || filteredY === null) {
      filteredX = centre.x;
      filteredY = centre.y;
    } else {
      filteredX += settings.emaAlpha * (centre.x - filteredX);
      filteredY += settings.emaAlpha * (centre.y - filteredY);
    }
    const errorX = filteredX - 0.5;
    const errorY = filteredY - 0.5;
    const excessX = Math.max(0, Math.abs(errorX) - settings.deadZoneX);
    const excessY = Math.max(0, Math.abs(errorY) - settings.deadZoneY);
    const speedX = Math.min(settings.maxSpeedDegPerS, settings.gainYaw * settings.controlHz * excessX);
    const speedY = Math.min(settings.maxSpeedDegPerS, settings.gainTilt * settings.controlHz * excessY);
    if (excessX > 0 && dt > 0) {
      yaw = clamp(yaw + Math.sign(errorX) * settings.yawDirection * speedX * dt, MOUNT_FIRMWARE_LIMITS.yawMin, MOUNT_FIRMWARE_LIMITS.yawMax);
    }
    if (excessY > 0 && dt > 0) {
      tilt = clamp(tilt + Math.sign(errorY) * settings.tiltDirection * speedY * dt, MOUNT_FIRMWARE_LIMITS.tiltMin, MOUNT_FIRMWARE_LIMITS.tiltMax);
    }
    const outside = excessX > 0 || excessY > 0;
    setState(outside ? 'TRACKING · ARDUINO' : 'CENTRED · ARDUINO', outside ? 'tracking' : 'centred');
    await sendAngles(yaw, tilt);
    return { ...getAngles(), centre, outsideDeadZone: outside };
  }

  return Object.freeze({
    connect,
    disconnect,
    sendAngles,
    centre,
    nudge,
    setSettings,
    startTracking,
    stopTracking,
    updateFromLandmarks,
    isConnected,
    isTracking: () => tracking,
    getAngles,
    getTransportKind: () => transportKind,
  });
}

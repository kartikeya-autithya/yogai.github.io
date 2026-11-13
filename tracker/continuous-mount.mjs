/*
 * YogAI continuous-rotation phone mount (velocity mode, YOGAI-CR v1 firmware).
 * Same role as arduino-mount.mjs for positional servos; reuses its USB transports.
 *
 * Safety rules implemented here (the firmware enforces its own as well):
 *  - nothing moves until the user arms the servos after a firmware handshake
 *  - speed commands are sent at a fixed rate and double as the heartbeat
 *  - person lost / tracking off / practice ended / USB lost / emergency stop => zero speed
 *  - ramp limiting and forced pass through neutral on direction reversal
 *  - soft travel limits from an APPROXIMATE estimate (no position feedback exists)
 */
import { WebUsbCdcTransport, WebSerialTransport, findPersonCentre } from './arduino-mount.mjs';
import { commands, parseReply, nextSeq, PROTOCOL } from './continuous-protocol.mjs';
import {
  CR_SETTINGS_DEFAULTS, sanitizeCrSettings, createVelocityController, createSpeedShaper, applySoftLimits,
} from './continuous-controller.mjs';
import { createTravelEstimator } from './travel-estimate.mjs';

export const CR_CALIBRATION_DEFAULTS = Object.freeze({
  neutralUs: [1500, 1500],
  minOff: [[40, 40], [40, 40]],      // [axis][+side, -side] microseconds from neutral
  maxOff: [[250, 250], [250, 250]],
  dpsAtFull: [60, 60],               // rough degrees per second at full speed (estimate only)
  tables: [null, null],              // optional measured [{permille, dps}] per axis
  watchdogMs: 400,
  maxRunMs: 4000,
  reversalDwellMs: 150,
  rampPerSec: 4000,
  stopMode: 0,
});

const SETTINGS_KEY = 'yogai.cr.settings.v1';
const CALIBRATION_KEY = 'yogai.cr.calibration.v1';
const ESTIMATE_KEY = 'yogai.cr.estimate.v1';
const TICK_MS = 50;
// Measured on an Android phone running the camera + pose model: the page can stall for 400+ ms, longer than the
// firmware's 400 ms default. The watchdog is kept (never disabled) but given a realistic floor.
const WATCHDOG_FLOOR_MS = 1000;
const MANUAL_HOLD_MS = 500;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function sanitizeCalibration(input = {}) {
  const d = CR_CALIBRATION_DEFAULTS;
  const num = (v, lo, hi, fallback) => (Number.isFinite(v) ? clamp(Math.round(v), lo, hi) : fallback);
  const pair = (src, i, lo, hi, fb) => [num(src?.[i]?.[0], lo, hi, fb[i][0]), num(src?.[i]?.[1], lo, hi, fb[i][1])];
  const out = {
    neutralUs: [num(input.neutralUs?.[0], 1300, 1700, d.neutralUs[0]), num(input.neutralUs?.[1], 1300, 1700, d.neutralUs[1])],
    minOff: [pair(input.minOff, 0, 0, 400, d.minOff), pair(input.minOff, 1, 0, 400, d.minOff)],
    maxOff: [pair(input.maxOff, 0, 1, 500, d.maxOff), pair(input.maxOff, 1, 1, 500, d.maxOff)],
    dpsAtFull: [clamp(Number(input.dpsAtFull?.[0]) || d.dpsAtFull[0], 1, 720), clamp(Number(input.dpsAtFull?.[1]) || d.dpsAtFull[1], 1, 720)],
    tables: [Array.isArray(input.tables?.[0]) ? input.tables[0] : null, Array.isArray(input.tables?.[1]) ? input.tables[1] : null],
    watchdogMs: num(input.watchdogMs, 100, 3000, d.watchdogMs),
    maxRunMs: num(input.maxRunMs, 500, 20000, d.maxRunMs),
    reversalDwellMs: num(input.reversalDwellMs, 0, 1000, d.reversalDwellMs),
    rampPerSec: num(input.rampPerSec, 200, 20000, d.rampPerSec),
    stopMode: input.stopMode === 1 ? 1 : 0,
  };
  for (let a = 0; a < 2; a += 1) for (let s = 0; s < 2; s += 1) {
    if (out.maxOff[a][s] <= out.minOff[a][s]) out.maxOff[a][s] = Math.min(500, out.minOff[a][s] + 1);
  }
  return out;
}

function readJson(storage, key) {
  try { const raw = storage?.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function writeJson(storage, key, value) {
  try { storage?.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

export function createContinuousMount({
  onStatus = () => {},
  onState = () => {},
  onEvent = () => {},
  storage = globalThis.localStorage,
  now = () => performance.now(),
  transportFactory = null,
  autoLoop = true,
  handshakeTimeoutMs = 700,
  requestTimeoutMs = 700,
  writeTimeoutMs = 800,   // a speed command that cannot be written in this time is treated as a USB fault
  rxTimeoutMs = 1500,     // while armed the firmware sends ST lines 5x/s; silence this long means the link is dead (0 = off)
} = {}) {
  // Settings written by newer tuning revisions carry settingsRev. Drop their retuned keys once so this version starts from
  // its own defaults (the sliders you set yourself, such as dead zone and speed caps, are kept).
  const savedSettings = readJson(storage, SETTINGS_KEY) ?? {};
  if ('settingsRev' in savedSettings) {
    for (const k of ['gainYaw', 'gainTilt', 'lostMs', 'dwellMs', 'staleDecayMs', 'kd', 'ki', 'integralLimit', 'captureDelayMs', 'actuationDelayMs',
      'fovYawDeg', 'fovTiltDeg', 'smithScale', 'plantGainInit', 'speedSmoothMs', 'trackMode', 'pulseSpeedPct', 'pulseFraction', 'minPulseMs',
      'maxPulseMs', 'probePulseMs', 'settingsRev']) delete savedSettings[k];
  }
  let settings = sanitizeCrSettings(savedSettings);
  let calibration = sanitizeCalibration(readJson(storage, CALIBRATION_KEY) ?? {});
  const controller = createVelocityController(settings);
  const shaper = createSpeedShaper({ rampPerSec: settings.rampPerSec, dwellMs: settings.dwellMs });
  const estimator = createTravelEstimator({ dpsAtFull: calibration.dpsAtFull, tables: calibration.tables });

  let transport = null;
  let transportKind = null;
  let connected = false;
  let armed = false;
  let latched = false;
  let tracking = false;
  let trackStatus = 'OFF';
  let handshakeOk = false;
  let sawPositional = false;
  let bootInfo = null;
  let seq = 0;
  let loopTimer = null;
  let lastTickMs = null;
  let manual = [0, 0];
  let manualUntil = 0;
  let speeds = [0, 0];
  let pulses = { yawUs: null, tiltUs: null };
  let estimateUnverified = false;
  let lastPersistMs = 0;
  let sendChain = Promise.resolve();
  const pending = new Map();
  let readyWaiter = null;
  let heartbeatPausedUntil = 0;
  let lastRxMs = 0;
  let lastInvalidReady = null;
  let tickFaultReported = false;
  const diag = [];
  function log(dir, text) {
    diag.push(`${Math.round(now())} ${dir} ${JSON.stringify(String(text).slice(0, 80))}`);
    if (diag.length > 120) diag.shift();
  }
  const hexOf = (text) => [...String(text)].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ');

  const emit = () => onState(getState());

  function getState() {
    return {
      connected, armed, latched, tracking, trackStatus, handshakeOk,
      transportKind, speeds: [...speeds], pulses: { ...pulses },
      estimate: estimator.get(), estimateUnverified,
      settings, calibration,
    };
  }

  // ------------------------------------------------------------ transport I/O
  function writeLine(text) {
    if (!transport?.connected) return Promise.reject(new Error('Arduino is not connected.'));
    const t = transport;
    log('TX', text.trim());
    sendChain = sendChain.catch(() => {}).then(() => t.sendRaw(text));
    return sendChain;
  }

  function request(buildLine, timeoutMs = requestTimeoutMs) {
    seq = nextSeq(seq);
    const id = seq;
    const line = buildLine(id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('The Arduino did not answer. Check the firmware and cable.')); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      writeLine(line).catch((error) => { clearTimeout(timer); pending.delete(id); reject(error); });
    });
  }

  function handleLine(rawLine) {
    lastRxMs = now();
    log('RX', rawLine);
    const r = parseReply(rawLine);
    switch (r.type) {
      case 'ready':
        bootInfo = r;
        // A READY line while armed means the Arduino restarted (power dip, reset): it is disarmed now.
        if (armed) stopEverything('The Arduino restarted while armed (power dip or reset?). Servos are disarmed. Check the supply, then arm again.', { latched: true });
        if (readyWaiter) { readyWaiter(r); readyWaiter = null; }
        break;
      case 'ready-invalid':
        lastInvalidReady = r.line;
        if (readyWaiter) { readyWaiter({ invalid: true, line: r.line }); readyWaiter = null; }
        break;
      case 'positional-ready':
        sawPositional = true;
        if (readyWaiter) { readyWaiter({ positional: true }); readyWaiter = null; }
        break;
      case 'positional-err':
        sawPositional = true;
        break;
      case 'ok': {
        const p = pending.get(r.seq);
        if (p) { clearTimeout(p.timer); pending.delete(r.seq); p.resolve(r); }
        break;
      }
      case 'err': {
        const p = pending.get(r.seq);
        if (p) { clearTimeout(p.timer); pending.delete(r.seq); p.reject(new Error(`Arduino: ${r.text}.`)); }
        else onStatus(`Arduino reported an error (code ${r.code}, command #${r.seq}): ${r.text}.`, 'error');
        break;
      }
      case 'status':
        pulses = { yawUs: r.yawUs, tiltUs: r.tiltUs };
        if (armed && !r.armed) stopEverything(r.latched ? 'The Arduino stopped the servos.' : 'The Arduino disarmed the servos.', { latched: r.latched });
        emit();
        break;
      case 'event':
        if (r.name === 'WATCHDOG') {
          stopEverything('Arduino watchdog: it stopped receiving commands and stopped the servos. Arm again to continue.', { latched: true });
          onEvent({ type: 'watchdog' });
        } else if (r.name === 'MAXRUN') {
          onStatus(`The Arduino stopped the ${r.axis === 0 ? 'yaw' : 'tilt'} axis after its maximum continuous run time.`, 'error');
          onEvent({ type: 'maxrun', axis: r.axis });
        }
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------ safety paths
  /** Local reaction to a stop (no USB traffic). */
  function stopEverything(message, { latched: l = false } = {}) {
    tracking = false;
    trackStatus = 'OFF';
    armed = false;
    if (l) latched = true;
    shaper.reset();
    controller.reset();
    manual = [0, 0];
    speeds = [0, 0];
    stopLoop();
    persistEstimate(true);
    if (message) onStatus(message, 'error');
    emit();
  }

  function persistEstimate(force = false) {
    const t = now();
    if (!force && t - lastPersistMs < 2000) return;
    lastPersistMs = t;
    writeJson(storage, ESTIMATE_KEY, estimator.serialize());
  }

  async function emergencyStop(reason = 'Emergency stop.') {
    const wasConnected = connected;
    stopEverything(`${reason} Servos stopped. Arm again to continue.`, { latched: true });
    onEvent({ type: 'estop' });
    if (!wasConnected || !transport) return;
    const line = commands.emergencyStop();
    // Bypass the normal write queue and repeat once: a lost stop line is the worst case.
    for (let i = 0; i < 2; i += 1) {
      try { await transport.sendRaw(line); } catch { /* firmware watchdog still stops the servos */ }
    }
  }

  function handleTransportLoss(error) {
    const wasConnected = connected;
    connected = false;
    handshakeOk = false;
    stopEverything(wasConnected ? `USB connection lost${error?.message ? `: ${error.message}` : ''}. Servo tracking stopped; the Arduino watchdog stops the servos.` : null, { latched: false });
    for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new Error('USB connection lost.')); pending.delete(id); }
    onEvent({ type: 'usb-lost' });
  }

  // ------------------------------------------------------------ control loop
  function startLoop() {
    if (!autoLoop || loopTimer !== null) return;
    lastTickMs = null;
    loopTimer = setInterval(() => { void tick(); }, TICK_MS);
  }
  function stopLoop() {
    if (loopTimer !== null) { clearInterval(loopTimer); loopTimer = null; }
  }

  let ticking = false;
  async function tick() {
    if (!armed || !connected || ticking) return;
    ticking = true;
    try { await tickInner(); } finally { ticking = false; }
  }

  async function tickInner() {
    const t = now();
    if (lastTickMs !== null && t - lastTickMs > 200) log('STALL', `${Math.round(t - lastTickMs)} ms since previous tick`);
    const dt = lastTickMs === null ? TICK_MS : clamp(t - lastTickMs, 1, 200);
    lastTickMs = t;

    if (rxTimeoutMs > 0 && lastRxMs > 0 && t - lastRxMs > rxTimeoutMs) {
      stopEverything(`No data from the Arduino for ${Math.round((t - lastRxMs) / 100) / 10} s. Servo control stopped. Check the USB cable, then arm again.`, { latched: true });
      void emergencyStopBestEffort();
      return;
    }

    // The heartbeat must survive a failure in the control maths: on any error fall back to zero speed and still send.
    try {
      let targets = [0, 0];
      if (tracking) {
        const r = controller.compute(t, { estimate: estimator.get() });
        targets = [r.yaw, r.tilt];
        trackStatus = r.status;
      } else if (manualUntil > t) {
        targets = applySoftLimits(manual, estimator.get(), settings).speeds;
      }
      speeds = shaper.step(targets, t, dt);
      estimator.step(0, speeds[0], dt);
      estimator.step(1, speeds[1], dt);
      persistEstimate();
    } catch (error) {
      speeds = [0, 0];
      shaper.reset();
      if (!tickFaultReported) { tickFaultReported = true; onStatus(`Control calculation failed (${error?.message || error}); sending zero speed.`, 'error'); }
    }

    if (t < heartbeatPausedUntil) return; // bench test only: lets the firmware watchdog prove itself
    try {
      const write = writeLine(commands.velocity(nextSeqValue(), speeds[0], speeds[1]));
      let timer;
      const stalled = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`USB write stalled for more than ${writeTimeoutMs} ms`)), writeTimeoutMs); });
      try { await Promise.race([write, stalled]); } finally { clearTimeout(timer); }
    } catch (error) {
      stopEverything(`Could not send a speed command (${error?.message || error}). Servos stopped.`, { latched: true });
      void emergencyStopBestEffort();
      return;
    }
    emit();
  }

  function nextSeqValue() { seq = nextSeq(seq); return seq; }

  async function emergencyStopBestEffort() {
    try { await transport?.sendRaw(commands.emergencyStop()); } catch { /* nothing more to do */ }
  }

  // ------------------------------------------------------------ connection
  function chooseTransport(kind = 'auto') {
    if (kind === 'web-usb' || kind === 'web-serial') return kind;
    const isAndroid = /Android/i.test(globalThis.navigator?.userAgent || '');
    if (isAndroid && globalThis.navigator?.usb?.requestDevice) return 'web-usb';
    if (globalThis.navigator?.serial?.requestPort) return 'web-serial';
    if (globalThis.navigator?.usb?.requestDevice) return 'web-usb';
    return 'none';
  }

  async function handshake() {
    // A boot banner that arrived while the port was opening is NOT trusted: it may be partial or stale.
    // Always ask explicitly (I,seq) and validate the fresh answer.
    bootInfo = null;
    lastInvalidReady = null;
    const positionalMsg = 'This Arduino is running the positional servo firmware. Upload servo_tracker_continuous.ino (YOGAI-CR) before using continuous-rotation servos.';
    if (sawPositional) throw new Error(positionalMsg);
    for (let attempt = 0; attempt < 3 && !bootInfo; attempt += 1) {
      const wait = new Promise((resolve) => { readyWaiter = resolve; setTimeout(() => { if (readyWaiter === resolve) readyWaiter = null; resolve(null); }, handshakeTimeoutMs); });
      await writeLine(commands.identify(nextSeqValue()));
      const reply = await wait;
      if (reply?.positional) sawPositional = true;
      if (sawPositional) throw new Error(positionalMsg);
      if (reply && reply.name) { bootInfo = reply; break; }
    }
    if (!bootInfo) {
      if (lastInvalidReady !== null) {
        throw new Error(`The Arduino answered the identify command with something unreadable. Expected "READY,${PROTOCOL.name},${PROTOCOL.version}" but received ${JSON.stringify(lastInvalidReady)} (hex ${hexOf(lastInvalidReady)}). Unplug and reconnect the Arduino, then retry.`);
      }
      throw new Error('No YOGAI-CR firmware answered. Upload servo_tracker_continuous.ino and reconnect.');
    }
    if (bootInfo.name !== PROTOCOL.name || bootInfo.version !== PROTOCOL.version) {
      throw new Error(`Firmware ${bootInfo.name} v${bootInfo.version} does not match this app (${PROTOCOL.name} v${PROTOCOL.version}).`);
    }
    handshakeOk = true;
  }

  async function uploadCalibration() {
    const c = calibration;
    await request((id) => commands.neutral(id, c.neutralUs[0], c.neutralUs[1]));
    for (let axis = 0; axis < 2; axis += 1) {
      for (const dir of [1, -1]) {
        const si = dir > 0 ? 0 : 1;
        await request((id) => commands.range(id, axis, dir, c.minOff[axis][si], c.maxOff[axis][si]));
      }
    }
    await request((id) => commands.param(id, 'watchdogMs', Math.max(c.watchdogMs, WATCHDOG_FLOOR_MS)));
    await request((id) => commands.param(id, 'reversalDwellMs', c.reversalDwellMs));
    await request((id) => commands.param(id, 'rampPerSec', c.rampPerSec));
    await request((id) => commands.param(id, 'maxRunMs', c.maxRunMs));
    await request((id) => commands.param(id, 'stopMode', c.stopMode));
  }

  async function connect(kind = 'auto', { resetOnConnect = true } = {}) {
    if (connected) return true;
    const selected = chooseTransport(kind);
    if (selected === 'none') throw new Error('This browser exposes neither WebUSB nor Web Serial.');
    transportKind = selected;
    sawPositional = false;
    bootInfo = null;
    lastInvalidReady = null;
    diag.length = 0;
    const callbacks = {
      baudRate: 115200,
      bootWaitMs: resetOnConnect ? 2500 : 300,
      assertDtr: resetOnConnect,
      onStatus,
      onLine: handleLine,
      onDisconnect: (error) => handleTransportLoss(error),
    };
    transport = transportFactory
      ? transportFactory(selected, callbacks)
      : (selected === 'web-usb' ? new WebUsbCdcTransport(callbacks) : new WebSerialTransport(callbacks));
    try {
      await transport.connect();
      connected = true;
      lastRxMs = now();
      await handshake();
      await uploadCalibration();
      const saved = readJson(storage, ESTIMATE_KEY);
      if (saved && estimator.restore(saved)) estimateUnverified = true;
      onStatus(`Connected via ${selected === 'web-usb' ? 'WebUSB' : 'Web Serial'}. Firmware ${bootInfo.name} v${bootInfo.version}. Servos are disarmed.`, 'success');
      emit();
      return true;
    } catch (error) {
      connected = false;
      handshakeOk = false;
      try { await transport?.disconnect(); } catch { /* ignore */ }
      transport = null;
      transportKind = null;
      emit();
      throw error;
    }
  }

  async function disconnect() {
    if (connected && transport) {
      stopEverything(null);
      try { await transport.sendRaw(commands.emergencyStop()); } catch { /* ignore */ }
    }
    const old = transport;
    connected = false;
    handshakeOk = false;
    transport = null;
    transportKind = null;
    stopEverything(null);
    if (old) { try { await old.disconnect(); } catch { /* ignore */ } }
    emit();
  }

  // ------------------------------------------------------------ arming, manual, tracking
  async function arm() {
    if (!connected || !handshakeOk) throw new Error('Connect the Arduino first.');
    if (armed) return;
    shaper.reset();
    controller.reset();
    const armAck = request((id) => commands.arm(id));
    // Queue a zero-speed command directly behind Arm so the watchdog is fed at once, without waiting for the OK round trip.
    writeLine(commands.velocity(nextSeqValue(), 0, 0)).catch(() => {});
    await armAck;
    armed = true;
    latched = false;
    lastRxMs = now();
    tickFaultReported = false;
    startLoop();
    onStatus('Servos armed at neutral. Manual jogs and tracking are available.', 'success');
    emit();
  }

  async function disarm(reason = 'Servos disarmed.') {
    const wasArmed = armed;
    tracking = false;
    trackStatus = 'OFF';
    armed = false;
    shaper.reset();
    controller.reset();
    manual = [0, 0];
    speeds = [0, 0];
    stopLoop();
    persistEstimate(true);
    emit();
    if (wasArmed && connected && transport) {
      try { await transport.sendRaw(commands.disarm(nextSeqValue())); } catch { /* watchdog covers it */ }
    }
    if (wasArmed) onStatus(reason, 'info');
    emit();
  }

  /** Hold-to-move: call repeatedly while a jog button is pressed, then setManual(0, 0) on release. */
  function setManual(yaw, tilt) {
    if (!armed || tracking) return false;
    manual = [clamp(Math.round(yaw), -1000, 1000), clamp(Math.round(tilt), -1000, 1000)];
    manualUntil = now() + MANUAL_HOLD_MS;
    return true;
  }

  function jog(axis, direction) {
    const speed = Math.round((settings.manualSpeedPct / 100) * 1000) * (direction < 0 ? -1 : 1);
    return axis === 'yaw' ? setManual(speed, 0) : setManual(0, speed);
  }
  function jogStop() { manual = [0, 0]; manualUntil = 0; }

  function startTracking() {
    if (!connected || !handshakeOk) throw new Error('Connect the Arduino before starting servo tracking.');
    if (!armed) throw new Error('Arm the servos before starting servo tracking.');
    if (tracking) return;
    controller.reset();
    shaper.reset();
    manual = [0, 0];
    tracking = true;
    trackStatus = 'LOOKING FOR PERSON';
    emit();
  }

  /** Stops tracking and sends zero speed immediately; servos stay armed. */
  function stopTracking(message = 'Servo tracking stopped. Servos are stopped.') {
    if (!tracking) return;
    tracking = false;
    trackStatus = 'OFF';
    controller.reset();
    shaper.reset();
    speeds = [0, 0];
    if (connected && armed) { void writeLine(commands.velocity(nextSeqValue(), 0, 0)).catch(() => {}); }
    onStatus(message, 'info');
    emit();
  }

  function updateFromLandmarks(landmarks, timestampMs = now()) {
    if (!tracking || !connected) return null;
    const centre = findPersonCentre(landmarks, settings);
    if (!centre) return null;
    controller.observe({ x: centre.x, y: centre.y, t: timestampMs });
    return centre;
  }

  // ------------------------------------------------------------ settings and calibration
  function setSettings(next = {}) {
    settings = sanitizeCrSettings({ ...settings, ...next });
    controller.setSettings(settings);
    shaper.setParams({ rampPerSec: settings.rampPerSec, dwellMs: settings.dwellMs });
    writeJson(storage, SETTINGS_KEY, settings);
    emit();
  }

  async function setCalibration(next = {}, { upload = true } = {}) {
    calibration = sanitizeCalibration({ ...calibration, ...next });
    estimator.setCalibration({ dpsAtFull: calibration.dpsAtFull, tables: calibration.tables });
    writeJson(storage, CALIBRATION_KEY, calibration);
    if (upload && connected && handshakeOk) await uploadCalibration();
    emit();
  }

  /** Live neutral trim while stopped; the firmware outputs the new neutral immediately. */
  async function trimNeutral(axis, deltaUs) {
    const n = [...calibration.neutralUs];
    n[axis] = clamp(n[axis] + deltaUs, 1300, 1700);
    await setCalibration({ neutralUs: n });
  }

  async function saveToArduino() {
    if (armed) throw new Error('Disarm the servos before saving settings to the Arduino.');
    await request((id) => commands.save(id));
    onStatus('Calibration saved on the Arduino (EEPROM).', 'success');
  }

  /** Bench test only: stops sending speed commands for ms milliseconds so the firmware watchdog can be seen working. */
  function pauseHeartbeat(ms) { heartbeatPausedUntil = now() + clamp(Number(ms) || 0, 0, 5000); }

  function setCentreHere() { estimator.reset(); estimateUnverified = false; persistEstimate(true); emit(); }
  function confirmEstimate() { estimateUnverified = false; emit(); }

  return Object.freeze({
    connect, disconnect, arm, disarm, emergencyStop,
    jog, jogStop, setManual, startTracking, stopTracking, updateFromLandmarks,
    setSettings, setCalibration, trimNeutral, saveToArduino, setCentreHere, confirmEstimate, pauseHeartbeat,
    tick, getState,
    getDiagnostics: () => diag.join('\n'),
    isConnected: () => connected,
    isArmed: () => armed,
    isTracking: () => tracking,
    getTransportKind: () => transportKind,
    getSettings: () => settings,
    getCalibration: () => calibration,
  });
}

export { CR_SETTINGS_DEFAULTS };

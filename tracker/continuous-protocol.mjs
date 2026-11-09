// YOGAI-CR v1 line protocol (JavaScript side). Mirrors servo_tracker_continuous.ino.
// Every line is ASCII, newline terminated, and ends with *HH where HH is the XOR of all
// characters before the '*', written as two uppercase hex digits.

export const PROTOCOL = Object.freeze({ name: 'YOGAI-CR', version: 1 });

export const ERROR_TEXT = Object.freeze({
  1: 'checksum error',
  2: 'could not parse the command',
  3: 'value out of range',
  4: 'servos are not armed',
  5: 'stopped (watchdog or emergency stop): arm again first',
  6: 'unknown command',
  7: 'line too long',
});

export const PARAM_KEYS = Object.freeze({
  watchdogMs: 1,
  reversalDwellMs: 2,
  rampPerSec: 3,
  maxRunMs: 4,
  stopMode: 5,
});

export function checksum(body) {
  let x = 0;
  for (let i = 0; i < body.length; i += 1) x ^= body.charCodeAt(i) & 0xff;
  return x.toString(16).toUpperCase().padStart(2, '0');
}

export function encode(body) {
  if (typeof body !== 'string' || !/^[ -)+-~]+$/.test(body)) throw new TypeError('Invalid protocol body.');
  const line = `${body}*${checksum(body)}\n`;
  if (line.length > 52) throw new RangeError('Protocol line too long.');
  return line;
}

function intIn(name, v, lo, hi) {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new RangeError(`${name} must be an integer from ${lo} to ${hi}.`);
  return v;
}

export function nextSeq(seq) {
  return seq >= 65535 ? 1 : seq + 1;
}

export const commands = Object.freeze({
  identify: (seq) => encode(`I,${intIn('seq', seq, 0, 65535)}`),
  query: (seq) => encode(`Q,${intIn('seq', seq, 0, 65535)}`),
  arm: (seq) => encode(`A,${intIn('seq', seq, 0, 65535)}`),
  disarm: (seq) => encode(`D,${intIn('seq', seq, 0, 65535)}`),
  save: (seq) => encode(`W,${intIn('seq', seq, 0, 65535)}`),
  /** Emergency stop. The firmware stops on any line that starts with X, so this is deliberately short. */
  emergencyStop: () => encode('X,0'),
  velocity: (seq, yaw, tilt) =>
    encode(`V,${intIn('seq', seq, 0, 65535)},${intIn('yaw', yaw, -1000, 1000)},${intIn('tilt', tilt, -1000, 1000)}`),
  neutral: (seq, yawUs, tiltUs) =>
    encode(`N,${intIn('seq', seq, 0, 65535)},${intIn('yawUs', yawUs, 1300, 1700)},${intIn('tiltUs', tiltUs, 1300, 1700)}`),
  range: (seq, axis, dir, minOff, maxOff) => {
    intIn('axis', axis, 0, 1);
    if (dir !== 1 && dir !== -1) throw new RangeError('dir must be 1 or -1.');
    intIn('minOff', minOff, 0, 400);
    intIn('maxOff', maxOff, 1, 500);
    if (maxOff <= minOff) throw new RangeError('maxOff must be greater than minOff.');
    return encode(`M,${intIn('seq', seq, 0, 65535)},${axis},${dir},${minOff},${maxOff}`);
  },
  param: (seq, key, value) => {
    const id = PARAM_KEYS[key];
    if (!id) throw new RangeError(`Unknown parameter ${key}.`);
    return encode(`P,${intIn('seq', seq, 0, 65535)},${id},${intIn(key, value, 0, 20000)}`);
  },
});

/** Parses one line received from the Arduino. */
export function parseReply(rawLine) {
  const line = String(rawLine ?? '').trim();
  if (line === 'READY') return { type: 'positional-ready' };
  if (line === 'ERR') return { type: 'positional-err' };
  const p = line.split(',');
  const num = (s) => (/^-?\d+$/.test(s ?? '') ? Number(s) : NaN);
  switch (p[0]) {
    case 'READY':
      return p.length === 3 ? { type: 'ready', name: p[1], version: num(p[2]) } : { type: 'unknown', line };
    case 'OK':
      return Number.isFinite(num(p[1])) ? { type: 'ok', seq: num(p[1]) } : { type: 'unknown', line };
    case 'ERR':
      return Number.isFinite(num(p[1])) && Number.isFinite(num(p[2]))
        ? { type: 'err', seq: num(p[1]), code: num(p[2]), text: ERROR_TEXT[num(p[2])] ?? 'unknown error' }
        : { type: 'unknown', line };
    case 'ST':
      return p.length === 6 && p.slice(1).every((s) => Number.isFinite(num(s)))
        ? { type: 'status', armed: num(p[1]) === 1, latched: num(p[2]) === 1, yawUs: num(p[3]), tiltUs: num(p[4]), ageMs: num(p[5]) }
        : { type: 'unknown', line };
    case 'EV':
      return p[1] === 'WATCHDOG' ? { type: 'event', name: 'WATCHDOG' }
        : p[1] === 'MAXRUN' ? { type: 'event', name: 'MAXRUN', axis: num(p[2]) }
          : { type: 'unknown', line };
    default:
      return { type: 'unknown', line };
  }
}

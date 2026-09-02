/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Package state declarations, writer values, and Stage service liveness.
 * [OUTPUT]: registerState/setState/getState/listStates/unregisterPackageStates for the state bus,
 *           plus a change observer for Core-owned lifecycle reconciliation.
 * [POS]: src/state/registry.mjs — the third Core mechanism beside Action and Feed. A Capability
 *        answers "who can provide this ability"; a state answers "what is the fact right now", so a
 *        state has exactly one writer and no binding. Values live in memory only.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

const SCHEMA = 'termux-os-framework.states.v1';
const NAME = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*){1,3}$/;
const TYPES = new Set(['bool', 'enum', 'number', 'string']);

/**
 * A value larger than this is refused.
 *
 * Reads are unauthenticated, so nothing secret may enter; and the cap is what makes it structurally
 * impossible to use the bus as a data channel or a message queue. Anything high-rate or lossless
 * belongs in a feed, which already carries a cursor.
 */
const MAX_VALUE_BYTES = 1024;

const states = new Map();
let sequence = 0;
let changeObserver = null;

/**
 * Core may subscribe to actual fact changes without making the state bus own any lifecycle policy.
 * The observer is deliberately one-way and best-effort: a broken observer must never reject a
 * valid state write. Consumers that need durable/high-rate history still belong on a Feed.
 */
export function setStateChangeHandler(fn) {
  changeObserver = typeof fn === 'function' ? fn : null;
}

function notifyChange(event) {
  if (!changeObserver) return;
  try {
    const result = changeObserver(event);
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch { /* Observability must not become a second writer failure mode. */ }
}

const fail = (code, detail) => {
  const error = new Error(detail);
  error.code = code;
  return error;
};

const validate = (declaration, value) => {
  if (declaration.type === 'bool') {
    if (typeof value !== 'boolean') throw fail('invalid_value', `${declaration.name} expects a boolean`);
    return value;
  }
  if (declaration.type === 'enum') {
    if (!declaration.values.includes(value)) {
      throw fail('invalid_value', `${declaration.name} expects one of ${declaration.values.join('|')}`);
    }
    return value;
  }
  if (declaration.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw fail('invalid_value', `${declaration.name} expects a finite number`);
    }
    return value;
  }
  if (typeof value !== 'string') throw fail('invalid_value', `${declaration.name} expects a string`);
  if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
    throw fail('value_too_large', `${declaration.name} exceeds ${MAX_VALUE_BYTES} bytes`);
  }
  return value;
};

/**
 * One name, one writer. This is the deliberate difference from a Capability: several packages may
 * offer the same ability and a binding decides between them, but a fact has exactly one party that
 * knows it. A second registration is a bug in one of them, not a choice for the operator.
 */
export function registerState(declaration) {
  const name = String(declaration?.name ?? '');
  if (!NAME.test(name)) throw fail('invalid_name', `invalid state name: ${name || '(empty)'}`);
  const type = String(declaration?.type ?? 'bool');
  if (!TYPES.has(type)) throw fail('invalid_type', `state ${name} has unsupported type ${type}`);
  const values = type === 'enum'
    ? [...new Set((declaration.values ?? []).map((item) => String(item)))]
    : null;
  if (type === 'enum' && values.length < 2) {
    throw fail('invalid_values', `enum state ${name} needs at least two values`);
  }
  const existing = states.get(name);
  if (existing && existing.package !== declaration.package) {
    throw fail('duplicate_state', `state "${name}" is already written by ${existing.package}`);
  }
  const entry = {
    name,
    type,
    values,
    package: declaration.package ?? null,
    service: declaration.service ?? null,
    // The writer's own promise about how long one of its claims can legitimately last. It is not a
    // heartbeat: declared once, checked on read. Without it a writer that hangs while holding
    // `speech.tts = true` would mute every consumer forever, and `live` cannot see that — a hung
    // process is still a running process.
    max_age_ms: Number.isFinite(Number(declaration.max_age_ms)) && Number(declaration.max_age_ms) > 0
      ? Math.round(Number(declaration.max_age_ms))
      : null,
    description: declaration.description ? String(declaration.description).slice(0, 200) : null,
    value: existing?.value,
    seq: existing?.seq ?? 0,
    updated_at_ms: existing?.updated_at_ms ?? null,
  };
  if (entry.value !== undefined) {
    try { validate(entry, entry.value); } catch { entry.value = undefined; entry.updated_at_ms = null; }
  }
  states.set(name, entry);
  return { ...entry };
}

export function setState(name, value, { package: writer = null } = {}) {
  const entry = states.get(String(name));
  if (!entry) throw fail('unknown_state', `unknown state: ${name}`);
  if (writer && entry.package && writer !== entry.package) {
    throw fail('not_owner', `state "${name}" is written by ${entry.package}, not ${writer}`);
  }
  const previous = entry.value;
  entry.value = validate(entry, value);
  entry.seq = ++sequence;
  entry.updated_at_ms = Date.now();
  if (!Object.is(previous, entry.value)) {
    notifyChange({
      kind: 'state_changed', name: entry.name, package: entry.package,
      previous, value: entry.value, sequence: entry.seq,
    });
  }
  return { ...entry };
}

const serviceRunning = async (serviceId) => {
  if (!serviceId) return true;
  try {
    const stage = await import('../stage/manager.mjs');
    const status = await stage.getServiceStatus(serviceId);
    return status?.process?.state === 'running';
  } catch { return false; }
};

/**
 * Three answers, not two: a name nobody registered, a registered name whose writer is gone, and a
 * usable value. A reader must be able to tell "unknown" from "false" — collapsing them is how a
 * stale claim silently becomes policy.
 */
const project = async (entry, nowMs) => {
  const ageMs = entry.updated_at_ms === null ? null : Math.max(0, nowMs - entry.updated_at_ms);
  const running = await serviceRunning(entry.service);
  const expired = entry.max_age_ms !== null && ageMs !== null && ageMs > entry.max_age_ms;
  const live = entry.value !== undefined && running && !expired;
  return {
    known: true,
    name: entry.name,
    type: entry.type,
    ...(entry.values ? { values: [...entry.values] } : {}),
    value: entry.value === undefined ? null : entry.value,
    live,
    ...(live ? {} : {
      stale_reason: entry.value === undefined ? 'never_written'
        : !running ? 'writer_not_running' : 'max_age_exceeded',
    }),
    owner: { package: entry.package, service: entry.service },
    seq: entry.seq,
    updated_at_ms: entry.updated_at_ms,
    age_ms: ageMs,
    max_age_ms: entry.max_age_ms,
    description: entry.description,
  };
};

export async function getState(name) {
  const entry = states.get(String(name));
  if (!entry) return { known: false, name: String(name) };
  return project(entry, Date.now());
}

export async function listStates() {
  const nowMs = Date.now();
  const names = [...states.keys()].sort();
  return {
    schema: SCHEMA,
    states: await Promise.all(names.map((name) => project(states.get(name), nowMs))),
  };
}

/** A package that unloads takes its facts with it; nothing outlives its only knower. */
export function unregisterPackageStates(packageId) {
  const removed = [];
  for (const [name, entry] of states) {
    if (entry.package === packageId) { states.delete(name); removed.push(name); }
  }
  if (removed.length) notifyChange({ kind: 'package_states_removed', package: packageId, names: removed });
  return removed;
}

export const stateNames = () => [...states.keys()];

// ============================================================
// 自檢：node src/state/registry.mjs --state-self-test
// ============================================================
const { fileURLToPath } = await import('node:url');
const path = await import('node:path');
if (process.argv.includes('--state-self-test') && process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let fails = 0;
  const t = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) fails++; };
  const threw = (fn, code) => { try { fn(); return false; } catch (e) { return e.code === code; } };

  registerState({ name: 'speech.stage', type: 'enum', values: ['rms', 'kws', 'vad', 'asr'], package: 'p1' });
  t('an unwritten state is known but not live', (await getState('speech.stage')).live === false
    && (await getState('speech.stage')).known === true
    && (await getState('speech.stage')).stale_reason === 'never_written');
  t('an unregistered state is not known', (await getState('speech.nope')).known === false);
  setState('speech.stage', 'kws', { package: 'p1' });
  t('a written state is live and carries a sequence', (await getState('speech.stage')).live === true
    && (await getState('speech.stage')).value === 'kws'
    && (await getState('speech.stage')).seq > 0);
  const changes = [];
  setStateChangeHandler((event) => changes.push(event));
  setState('speech.stage', 'vad', { package: 'p1' });
  t('a changed fact emits one lifecycle observation', changes.length === 1
    && changes[0].name === 'speech.stage' && changes[0].previous === 'kws' && changes[0].value === 'vad');
  t('an out-of-domain enum value is refused',
    threw(() => setState('speech.stage', 'listening', { package: 'p1' }), 'invalid_value'));
  t('a foreign writer is refused',
    threw(() => setState('speech.stage', 'vad', { package: 'p2' }), 'not_owner'));
  t('a second package cannot claim the same name',
    threw(() => registerState({ name: 'speech.stage', type: 'bool', package: 'p2' }), 'duplicate_state'));
  registerState({ name: 'speech.tts', type: 'bool', package: 'p1', max_age_ms: 1 });
  setState('speech.tts', true, { package: 'p1' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const aged = await getState('speech.tts');
  t('a claim past its declared max age stops being live',
    aged.live === false && aged.value === true && aged.stale_reason === 'max_age_exceeded');
  registerState({ name: 'audio.output.route', type: 'string', package: 'p1' });
  t('an oversized value is refused',
    threw(() => setState('audio.output.route', 'x'.repeat(2000), { package: 'p1' }), 'value_too_large'));
  t('bad names are refused', threw(() => registerState({ name: 'Speech.Stage', package: 'p1' }), 'invalid_name'));
  t('unloading a package removes its facts',
    unregisterPackageStates('p1').length === 3 && stateNames().length === 0);
  setStateChangeHandler(null);
  process.exit(fails ? 1 : 0);
}

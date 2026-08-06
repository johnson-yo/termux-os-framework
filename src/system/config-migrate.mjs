/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: The running version's default configuration and whatever configuration the device already has.
 * [OUTPUT]: A complete configuration for this version, plus a report of what was transplanted, defaulted or kept.
 * [POS]: src/system/config-migrate.mjs in termux-os-framework. Runs before the server reads any setting.
 *
 *        A Framework update used to fail whenever the installed configuration predated a key the new
 *        version reads: the server threw on the first bare access and the installer rolled back, so the
 *        further behind a device was, the less able it was to catch up. Configuration is therefore never
 *        read as-is again. The new defaults are the skeleton; every value the user set is carried across
 *        by its own key path.
 *
 *        Key paths are the identity. No version-to-version mapping table exists, because such a table has
 *        to be correct for every pair of versions anyone might upgrade between, and is silently wrong the
 *        moment someone skips a release. A key that means the same thing keeps the same path; a key that
 *        changes meaning gets a new path and is treated as new.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

export const CONFIG_MIGRATION_SCHEMA = 'termux-os.config-migration.v1';

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Every leaf path in an object, as dotted strings. Arrays are leaves: their contents are one setting. */
export function leafPaths(value, prefix = '') {
  if (!isPlainObject(value)) return prefix ? [prefix] : [];
  const out = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(child) && Object.keys(child).length > 0) out.push(...leafPaths(child, path));
    else out.push(path);
  }
  return out;
}

export function getPath(target, path) {
  let node = target;
  for (const key of path.split('.')) {
    if (!isPlainObject(node) || !(key in node)) return { found: false, value: undefined };
    node = node[key];
  }
  return { found: true, value: node };
}

export function setPath(target, path, value) {
  const keys = path.split('.');
  let node = target;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(node[key])) node[key] = {};
    node = node[key];
  }
  node[keys.at(-1)] = value;
  return target;
}

/**
 * Two values are compatible when carrying one across cannot change how the new version reads it.
 * null in the defaults means "no opinion about type", which is how optional settings are declared.
 */
function compatible(defaultValue, candidate) {
  if (defaultValue === null || defaultValue === undefined) return true;
  if (Array.isArray(defaultValue)) return Array.isArray(candidate);
  if (isPlainObject(defaultValue)) return isPlainObject(candidate);
  return typeof defaultValue === typeof candidate;
}

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/**
 * Build this version's configuration from its defaults and the configuration already on the device.
 *
 * `transplanted` values the user set and this version still reads. `defaulted` keys this version added.
 * `coerced` keys whose stored value could not be read as this version expects. `kept` keys this version
 * no longer declares — preserved rather than dropped, because a downgrade or a later release may want
 * them back and deleting a user's data to tidy up a file is not ours to do.
 */
export function migrateConfig(defaults, existing, { defaultsVersion = null } = {}) {
  const source = isPlainObject(existing) ? existing : {};
  const result = {};
  const report = {
    schema: CONFIG_MIGRATION_SCHEMA,
    defaults_version: defaultsVersion,
    from_schema: typeof source.schema === 'string' ? source.schema : null,
    transplanted: [],
    defaulted: [],
    coerced: [],
    kept: [],
  };

  for (const path of leafPaths(defaults)) {
    const fallback = getPath(defaults, path).value;
    const found = getPath(source, path);
    if (!found.found) {
      setPath(result, path, clone(fallback));
      report.defaulted.push(path);
    } else if (compatible(fallback, found.value)) {
      setPath(result, path, clone(found.value));
      report.transplanted.push(path);
    } else {
      setPath(result, path, clone(fallback));
      report.coerced.push({ path, expected: Array.isArray(fallback) ? 'array' : typeof fallback,
        found: Array.isArray(found.value) ? 'array' : typeof found.value });
    }
  }

  // The schema marker belongs to the running version even when everything else was transplanted.
  if (typeof defaults.schema === 'string') {
    result.schema = defaults.schema;
    const idx = report.transplanted.indexOf('schema');
    if (idx >= 0) report.transplanted.splice(idx, 1);
  }

  const declared = new Set(leafPaths(defaults));
  for (const path of leafPaths(source)) {
    if (declared.has(path) || path === 'schema') continue;
    setPath(result, path, clone(getPath(source, path).value));
    report.kept.push(path);
  }

  return { config: result, report };
}

/**
 * The fingerprint the update boundary check compares. It covers what the user chose, not the file's
 * bytes, and not the settings left at whatever this version ships as the default.
 *
 * Hashing bytes made "this version added a key" indistinguishable from "someone edited a setting",
 * which is why migration and the boundary check could not coexist. Listing every key instead would
 * have the same flaw, since a migration adds keys by design. So a key is in the fingerprint only
 * when its value differs from this version's default, or when this version does not declare it at
 * all. A key added with its default value is therefore invisible, while any value the user actually
 * chose is compared exactly. Defaults are read from the running version on both sides of an update,
 * so a release that changes a default the user never touched is not reported as tampering either.
 *
 * Credentials are excluded outright: they have their own private file and are rotatable by design.
 */
export function configFingerprint(config, defaults = null) {
  const entries = leafPaths(config)
    .filter((path) => path !== 'schema' && path !== 'auth' && !path.startsWith('auth.'))
    .filter((path) => {
      if (!defaults) return true;
      const declared = getPath(defaults, path);
      if (!declared.found) return true; // undeclared: the user's own data, always compared
      return JSON.stringify(declared.value) !== JSON.stringify(getPath(config, path).value);
    })
    .sort()
    .map((path) => `${path}=${JSON.stringify(getPath(config, path).value)}`);
  return entries.join('\n');
}

/**
 * The form the configuration is stored in: only what differs from this version's defaults, plus keys
 * this version does not declare.
 *
 * Materialising every default into the file looked harmless until a later release wanted to change
 * one. The old value was sitting in the file and would be transplanted back, so the new default
 * never took effect, and the boundary check saw a setting that "differed from the default" and
 * called the update tampering. Storing overrides only keeps the file to what the user actually
 * decided, which is also the only thing worth carrying between versions.
 */
export function configOverrides(config, defaults) {
  const out = {};
  for (const path of leafPaths(config)) {
    if (path === 'schema') continue;
    const declared = getPath(defaults, path);
    if (declared.found && JSON.stringify(declared.value) === JSON.stringify(getPath(config, path).value)) continue;
    setPath(out, path, clone(getPath(config, path).value));
  }
  if (typeof defaults.schema === 'string') out.schema = defaults.schema;
  return out;
}

/** True when the migration changed the file's meaning, i.e. it is worth rewriting and reporting. */
export const migrationChangedConfig = (report) => report.defaulted.length > 0 || report.coerced.length > 0;

const { fileURLToPath: selfTestUrl } = await import('node:url');
const { resolve: selfTestPath } = await import('node:path');
// ⚠ 只在**本檔被直接執行**時跑。少了 argv[1] 這半，任何 transitively import 本檔的
// 自檢都會被這一塊劫持並提前 process.exit——那個自檢的斷言一條也不會執行，
// 而輸出看起來完全正常，只是印的是別人的 PASS。
if (process.argv.includes('--self-test')
  && process.argv[1] && selfTestPath(process.argv[1]) === selfTestUrl(import.meta.url)) {
  let fails = 0;
  const test = (name, condition) => { console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`); if (!condition) fails++; };

  const defaults = {
    schema: 'termux-os-framework.conf.v1',
    device_name: 'android-device',
    developer_mode: false,
    server: { host: '127.0.0.1', port: 8980 },
    integrations: { package_registry: { base_url: 'https://package.termux-os.com', framework_repository: 'owner/repo' } },
  };

  // The exact failure this module exists to prevent: a conf predating server.* made the server throw
  // on `CFG.server.host`, the installer rolled back, and the device could never move forward again.
  {
    const { config, report } = migrateConfig(defaults, { schema: 'termux-os-framework.conf.v1', device_name: 'old-device' });
    test('a conf with no server section still yields a usable one',
      config.server.host === '127.0.0.1' && config.server.port === 8980);
    test('values the user set survive', config.device_name === 'old-device');
    test('added keys are reported as defaulted', report.defaulted.includes('server.host'));
    test('carried values are reported as transplanted', report.transplanted.includes('device_name'));
  }

  // Nesting depth is irrelevant: the path is the identity, so a value three levels down comes across
  // without anyone declaring a rule for it.
  {
    const existing = { server: { host: '0.0.0.0', port: 8980 },
      integrations: { package_registry: { base_url: 'https://mirror.example' } } };
    const { config, report } = migrateConfig(defaults, existing);
    test('a deep value is transplanted by path alone',
      config.integrations.package_registry.base_url === 'https://mirror.example');
    test('its sibling still gets this version default',
      config.integrations.package_registry.framework_repository === 'owner/repo'
      && report.defaulted.includes('integrations.package_registry.framework_repository'));
    test('LAN binding chosen by the user is not reset', config.server.host === '0.0.0.0');
  }

  // A stored value the new version cannot read must not reach the server, but must be reported:
  // silently replacing it is how a user's setting disappears without anyone noticing.
  {
    const { config, report } = migrateConfig(defaults, { server: { host: '127.0.0.1', port: '8980' } });
    test('an unreadable value falls back to the default', config.server.port === 8980);
    test('the coercion is reported with both types',
      report.coerced.some((item) => item.path === 'server.port' && item.expected === 'number' && item.found === 'string'));
  }

  // Keys this version no longer declares are the user's data, not litter.
  {
    const { config, report } = migrateConfig(defaults, { retired: { setting: 'value' } });
    test('undeclared keys are kept', config.retired.setting === 'value' && report.kept.includes('retired.setting'));
  }

  // The schema marker names the running version's format, whatever the old file claimed.
  {
    const { config, report } = migrateConfig(defaults, { schema: 'termux-os-framework.conf.v0', device_name: 'x' });
    test('schema is taken from this version', config.schema === 'termux-os-framework.conf.v1');
    test('the old schema is recorded', report.from_schema === 'termux-os-framework.conf.v0');
  }

  // Migration is a function of its inputs: running it twice must not keep changing the file, or the
  // update boundary check would report a violation on every restart.
  {
    const first = migrateConfig(defaults, { device_name: 'phone' });
    const second = migrateConfig(defaults, first.config);
    test('migration is idempotent', JSON.stringify(first.config) === JSON.stringify(second.config));
    test('a migrated conf reports nothing left to add', !migrationChangedConfig(second.report));
  }

  // What the boundary check compares. This is the property that lets an update migrate the
  // configuration at all: the check must tolerate keys the new version added and nothing else.
  {
    const base = migrateConfig(defaults, { device_name: 'phone', server: { host: '0.0.0.0', port: 8980 } }).config;
    const widened = { ...defaults, server: { ...defaults.server, tls: false }, telemetry: { enabled: false } };
    const upgraded = migrateConfig(widened, base).config;
    test('a new version adding its own keys leaves the fingerprint alone',
      configFingerprint(base, defaults) === configFingerprint(upgraded, widened));
    test('the setting the user actually changed is still in the fingerprint',
      configFingerprint(base, defaults).includes('server.host="0.0.0.0"'));
    test('a setting left at the default is not in the fingerprint',
      !configFingerprint(base, defaults).includes('server.port'));

    const edited = migrateConfig(defaults, { device_name: 'phone', server: { host: '127.0.0.1', port: 8980 } }).config;
    test('changing a value the user chose does change the fingerprint',
      configFingerprint(base, defaults) !== configFingerprint(edited, defaults));

    // A release may change a default the user never touched. Because the file stores overrides
    // only, the old default is not sitting in it waiting to be transplanted back over the new one.
    const stored = configOverrides(base, defaults);
    test('the stored file holds only what the user decided',
      JSON.stringify(stored) === JSON.stringify({ device_name: 'phone', server: { host: '0.0.0.0' }, schema: defaults.schema }));
    const rebased = { ...defaults, developer_mode: true };
    const carried = migrateConfig(rebased, stored).config;
    test('a changed default reaches a device that never set it', carried.developer_mode === true);
    test('changing a default the user never set is not reported',
      configFingerprint(stored, defaults) === configFingerprint(configOverrides(carried, rebased), rebased));

    test('credentials are outside the fingerprint',
      configFingerprint(base, defaults) === configFingerprint({ ...base, auth: { admin_token: 'secret' } }, defaults));

    // Keys this version does not declare have no default to compare against, so they are always in.
    const withKept = migrateConfig(defaults, { device_name: 'phone', server: { host: '0.0.0.0', port: 8980 }, retired: { x: 1 } }).config;
    test('undeclared keys are always compared', configFingerprint(withKept, defaults).includes('retired.x=1'));

    // Devices installed before this scheme have every default written out. Migration finds nothing
    // to do on such a file, so unless normalisation is driven by the file's shape it keeps that
    // form forever — and that form is exactly what stops a later release changing a default.
    const materialised = { ...defaults };
    const { report: noop } = migrateConfig(defaults, materialised);
    test('a fully materialised file gives migration nothing to report', !migrationChangedConfig(noop));
    test('but it is not yet in stored form',
      JSON.stringify(materialised) !== JSON.stringify(configOverrides(materialised, defaults)));
    test('normalising it leaves only the schema',
      JSON.stringify(configOverrides(materialised, defaults)) === JSON.stringify({ schema: defaults.schema }));
  }

  // A missing or corrupt file must still produce something the server can start on.
  {
    for (const [label, input] of [['null', null], ['a string', 'not-json'], ['an array', [1, 2]]]) {
      const { config } = migrateConfig(defaults, input);
      test(`${label} yields this version defaults`, config.server.host === '127.0.0.1' && config.device_name === 'android-device');
    }
  }

  console.log(fails === 0 ? 'PASS config migration' : `FAIL ${fails}`);
  process.exit(fails === 0 ? 0 : 1);
}

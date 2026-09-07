/* global __dirname */

/**
 * Tests for the webpack bundle configuration.
 *
 * Run with `npm run test:webpack`.
 *
 * These assert the shape of the configuration, not the output of a build: a
 * real build of this project takes minutes and eight gigabytes of heap, which
 * is the very thing the preview profile exists to avoid. The loaders and
 * plugins the config file pulls in are stubbed for the same reason — what is
 * under test is which bundles are asked for and how, and that is decided
 * before webpack is ever handed the answer.
 *
 * The default profile is pinned to a golden list. Dropping a bundle from a
 * release build by accident is exactly the failure this file is here to catch,
 * so the list is written out rather than derived.
 */

const assert = require('assert');
const Module = require('module');
const { describe, it } = require('node:test');
const path = require('path');
const process = require('process');

const CONFIG = path.join(__dirname, 'webpack.config.js');

/**
 * The entries a full build produces, in build order, with what each is built
 * from. Changing this list means changing what a release ships.
 */
const DEFAULT_ENTRIES = [
    { 'app.bundle': './app.js' },
    { 'alwaysontop': './react/features/always-on-top/index.tsx' },
    { 'documentpip': './react/features/always-on-top/document-pip-index.tsx' },
    { 'close3': './static/close3.js' },
    { 'external_api': './modules/API/external/index.js' },
    { 'face-landmarks-worker': './react/features/face-landmarks/faceLandmarksWorker.ts' },
    { 'vb-inference-worker':
        './react/features/stream-effects/virtual-background/workers/VBInferenceWorker.ts' },
    { 'noise-suppressor-worklet':
        './react/features/stream-effects/noise-suppression/NoiseSuppressorWorklet.ts' },
    { 'screenshot-capture-worker': './react/features/screenshot-capture/worker.ts' }
];

/**
 * The entry names a preview build produces, in build order.
 */
const PREVIEW_ENTRY_NAMES = [
    'app.bundle',
    'external_api',
    'face-landmarks-worker',
    'vb-inference-worker',
    'noise-suppressor-worklet',
    'screenshot-capture-worker'
];

/**
 * The entry names a preview build leaves out.
 */
const DROPPED_ENTRY_NAMES = [ 'alwaysontop', 'documentpip', 'close3' ];

/**
 * A stand-in for a webpack plugin. The config only ever constructs these and
 * puts them in a list, so a plugin that records nothing is enough.
 */
class StubPlugin {}

/**
 * What the config file gets instead of the real build toolchain.
 */
const STUBS = {
    '@babel/preset-env': {},
    '@babel/preset-react': {},
    'circular-dependency-plugin': StubPlugin,
    'webpack': {
        DefinePlugin: StubPlugin,
        IgnorePlugin: StubPlugin,
        ProvidePlugin: StubPlugin
    },
    'webpack-bundle-analyzer': { BundleAnalyzerPlugin: StubPlugin }
};

/**
 * Loads the config factory with the build toolchain stubbed out.
 *
 * The interception is torn down again before the test body runs, so nothing
 * else in this process sees a stubbed module.
 *
 * @returns {Function} The config factory exported by webpack.config.js.
 */
function loadFactory() {
    const load = Module._load;
    const resolveFilename = Module._resolveFilename;

    Module._load = function(request, ...rest) {
        return request in STUBS ? STUBS[request] : load.call(this, request, ...rest);
    };
    Module._resolveFilename = function(request, ...rest) {
        return request in STUBS ? request : resolveFilename.call(this, request, ...rest);
    };

    try {
        delete require.cache[CONFIG];

        return require(CONFIG);
    } finally {
        Module._load = load;
        Module._resolveFilename = resolveFilename;
    }
}

const factory = loadFactory();

/**
 * Runs the config factory with a given environment, restoring the environment
 * afterwards, and collects anything the factory logs.
 *
 * @param {Object} env - Variables to set for the call. A value of `undefined`
 * removes the variable.
 * @param {Object} [argv] - The webpack argv, defaulting to a production build.
 * @returns {Object} The `configs` produced and the `logged` lines.
 */
function build(env, argv = { mode: 'production' }) {
    const saved = {};
    const logged = [];
    const log = console.log;

    for (const [ name, value ] of Object.entries(env)) {
        saved[name] = process.env[name];

        if (typeof value === 'undefined') {
            delete process.env[name];
        } else {
            process.env[name] = value;
        }
    }

    console.log = (...args) => logged.push(args.join(' '));

    try {
        return { configs: factory({}, argv),
            logged };
    } finally {
        console.log = log;

        for (const [ name, value ] of Object.entries(saved)) {
            if (typeof value === 'undefined') {
                delete process.env[name];
            } else {
                process.env[name] = value;
            }
        }
    }
}

/**
 * The entry names of a list of bundle configurations, in order.
 *
 * @param {Array} configs - The bundle configurations.
 * @returns {string[]} The entry names.
 */
function entryNames(configs) {
    return configs.map(config => Object.keys(config.entry)[0]);
}

/**
 * Builds with the preview profile off.
 *
 * @param {Object} [argv] - The webpack argv.
 * @returns {Object} As `build`.
 */
function buildDefault(argv) {
    return build({ MEETSPACE_PREVIEW: undefined }, argv);
}

/**
 * Builds with the preview profile on.
 *
 * @param {Object} [argv] - The webpack argv.
 * @returns {Object} As `build`.
 */
function buildPreview(argv) {
    return build({ MEETSPACE_PREVIEW: '1' }, argv);
}

describe('the default profile', () => {
    it('produces exactly the entries a release ships, in order', () => {
        const { configs } = buildDefault();

        assert.deepStrictEqual(configs.map(config => config.entry), DEFAULT_ENTRIES);
    });

    it('keeps source maps on', () => {
        assert.deepStrictEqual(
            [ ...new Set(buildDefault().configs.map(config => config.devtool)) ],
            [ 'source-map' ]);
        assert.deepStrictEqual(
            [ ...new Set(buildDefault({ mode: 'development' }).configs.map(config => config.devtool)) ],
            [ 'eval-source-map' ]);
    });

    it('keeps the asset size budget as a build error', () => {
        const { configs } = buildDefault();

        for (const config of configs) {
            assert.strictEqual(config.performance.hints, 'error', `${entryNames([ config ])} lost its size budget`);
            assert.ok(config.performance.maxAssetSize > 0);
        }
    });

    it('says nothing about a preview profile', () => {
        assert.deepStrictEqual(buildDefault().logged, []);
    });
});

describe('the preview profile', () => {
    it('builds only what the served application loads', () => {
        assert.deepStrictEqual(entryNames(buildPreview().configs), PREVIEW_ENTRY_NAMES);
    });

    it('leaves the entries it does build pointing at the same sources', () => {
        const previewed = buildPreview().configs.map(config => config.entry);
        const expected = DEFAULT_ENTRIES.filter(
            entry => PREVIEW_ENTRY_NAMES.includes(Object.keys(entry)[0]));

        assert.deepStrictEqual(previewed, expected);
    });

    it('turns source maps off', () => {
        for (const config of buildPreview().configs) {
            assert.strictEqual(config.devtool, false, `${entryNames([ config ])} still emits a source map`);
        }
    });

    it('turns source maps off for a development build too', () => {
        for (const config of buildPreview({ mode: 'development' }).configs) {
            assert.strictEqual(config.devtool, false);
        }
    });

    it('turns the asset size budget off', () => {
        for (const config of buildPreview().configs) {
            assert.strictEqual(config.performance, false, `${entryNames([ config ])} still has a size budget`);
        }
    });

    it('changes nothing else about the bundles it keeps', () => {
        const byName = new Map(buildDefault().configs.map(config => [ Object.keys(config.entry)[0], config ]));

        for (const config of buildPreview().configs) {
            const name = Object.keys(config.entry)[0];
            const original = byName.get(name);

            assert.deepStrictEqual(Object.keys(config).sort(), Object.keys(original).sort(),
                `${name} gained or lost a configuration key`);

            for (const key of [ 'entry', 'mode', 'optimization', 'output' ]) {
                assert.deepStrictEqual(config[key], original[key], `${name} had its ${key} changed`);
            }
        }
    });

    it('keeps the external API a UMD library and the worklet its own global', () => {
        const byName = new Map(buildPreview().configs.map(config => [ Object.keys(config.entry)[0], config ]));

        assert.strictEqual(byName.get('external_api').output.libraryTarget, 'umd');
        assert.strictEqual(byName.get('noise-suppressor-worklet').output.globalObject, 'AudioWorkletGlobalScope');
    });

    it('reports what it left out, once', () => {
        const { logged } = buildPreview();

        assert.strictEqual(logged.length, 1);

        const [ line ] = logged;

        assert.match(line, /^\[webpack] stage build: preview profile, 6 of 9 bundles, no source maps \(dropped: /);

        for (const name of DROPPED_ENTRY_NAMES) {
            assert.ok(line.includes(name), `the report does not name ${name}`);
        }
    });

    it('does not write anything that reads as the preview runner verdict', () => {
        for (const line of buildPreview().logged) {
            assert.ok(!line.includes('[preview] STAGE='), `${line} would be mistaken for the runner's marker`);
        }
    });
});

describe('the preview switch', () => {
    for (const value of [ '1', 'true', 'yes', 'YES', ' 1 ' ]) {
        it(`treats ${JSON.stringify(value)} as on`, () => {
            assert.deepStrictEqual(entryNames(build({ MEETSPACE_PREVIEW: value }).configs), PREVIEW_ENTRY_NAMES);
        });
    }

    for (const value of [ '0', '', 'false', 'no', 'off', undefined ]) {
        it(`treats ${JSON.stringify(value)} as off`, () => {
            assert.deepStrictEqual(
                build({ MEETSPACE_PREVIEW: value }).configs.map(config => config.entry),
                DEFAULT_ENTRIES);
        });
    }
});

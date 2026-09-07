/**
 * Tests for the staged preview runner.
 *
 * Run with `npm run test:preview`.
 *
 * The end-to-end cases put a fake `npm` on PATH and make it fail at a chosen
 * stage, because the property under test — that a failing preview names the
 * stage that failed, exactly once — is a property of the whole run, and the
 * real stages take minutes.
 */

const assert = require('assert');
const { execFile } = require('child_process');
const fs = require('fs');
const { describe, it } = require('node:test');
const os = require('os');
const path = require('path');

const { SKIP_MOBILE } = require('./postinstall');
const {
    MARKER,
    STAGES,
    createTail,
    exitCodeFor,
    formatExit,
    formatFailure,
    parseStages
} = require('./preview');

const ROOT = path.resolve(__dirname, '..');
const RUNNER = path.join(__dirname, 'preview.js');
const POSIX = process.platform !== 'win32';

/**
 * Writes a fake `npm` that reports the stage it was asked for and fails at the
 * stage named by `FAIL_AT`, in the way named by `FAIL_MODE`.
 *
 * The arguments each stage is run with are read from `STAGES` rather than
 * written out here, so renaming the script a stage runs cannot quietly turn
 * these cases into a fake npm that never fails.
 *
 * @returns {string} The directory to put in front of PATH.
 */
function createFakeNpm() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meetspace-preview-'));
    const npm = path.join(dir, 'npm');
    const arms = Object.entries(STAGES).map(([ stage, { args } ]) => `  '${args.join(' ')}') stage=${stage} ;;`);

    fs.writeFileSync(npm, [
        '#!/bin/sh',
        'case "$*" in',
        ...arms,
        '  *) stage=unknown ;;',
        'esac',
        'echo "fake npm: $stage running"',
        'echo "fake npm: $stage skip-mobile=[$MEETSPACE_SKIP_MOBILE]"',
        'if [ "$stage" = "$FAIL_AT" ]; then',
        '  echo "noise before the cause" >&2',
        '  echo "the cause: $stage exploded" >&2',
        '  if [ "$FAIL_MODE" = "signal" ]; then kill -9 $$; fi',
        '  exit 7',
        'fi',
        'exit 0',
        ''
    ].join('\n'));
    fs.chmodSync(npm, 0o755);

    return dir;
}

/**
 * Runs the preview runner with a fake npm in front of PATH.
 *
 * @param {string[]} stages - The stages to ask for.
 * @param {Object} env - Extra environment, `FAIL_AT` and `FAIL_MODE`.
 * @returns {Promise<Object>} The exit code and the combined output.
 */
function runRunner(stages, env = {}) {
    const bin = createFakeNpm();

    return new Promise(resolve => {
        execFile(process.execPath, [ RUNNER, ...stages ], {
            env: { ...process.env,
                ...env,
                PATH: `${bin}${path.delimiter}${process.env.PATH}` }
        }, (error, stdout, stderr) => {
            fs.rmSync(bin, { force: true,
                recursive: true });
            resolve({ code: error ? error.code : 0,
                output: `${stdout}${stderr}` });
        });
    });
}

/**
 * Counts the marker lines in a run's output.
 *
 * @param {string} output - The combined output.
 * @returns {string[]} The marker lines.
 */
function markerLines(output) {
    return output.split('\n').filter(line => line.includes(MARKER));
}

describe('createTail', () => {
    it('keeps only the last lines', () => {
        const tail = createTail(2);

        tail.write('one\ntwo\nthree\n');

        assert.deepStrictEqual(tail.lines(), [ 'two', 'three' ]);
    });

    it('joins chunks that split a line and reports an unterminated one', () => {
        const tail = createTail(5);

        tail.write('half');
        tail.write(' a line\nand a bare one');

        assert.deepStrictEqual(tail.lines(), [ 'half a line', 'and a bare one' ]);
    });

    it('treats a carriage return as a line break and drops blank lines', () => {
        const tail = createTail(5);

        tail.write('99%\r100%\r\n\n done\n');

        assert.deepStrictEqual(tail.lines(), [ '99%', '100%', ' done' ]);
    });
});

describe('formatExit', () => {
    it('reports the exit code', () => {
        assert.strictEqual(formatExit({ code: 7,
            signal: null }), 'exit=7');
    });

    it('reports a kill as the shell would, and names the signal', () => {
        assert.strictEqual(formatExit({ code: null,
            signal: 'SIGKILL' }), 'exit=137 signal=SIGKILL');
    });

    it('reports a stage that never ran as having no status', () => {
        assert.strictEqual(formatExit({ code: null,
            error: 'spawn npm ENOENT',
            signal: null }), 'exit=none');
    });
});

describe('formatFailure', () => {
    it('names the stage once, with the exit code and the tail', () => {
        const lines = formatFailure({
            code: 7,
            commandLine: 'npm run build',
            signal: null,
            stage: 'build',
            tail: [ 'first', 'second' ]
        }, 20);

        assert.deepStrictEqual(
            lines.filter(line => line.includes(MARKER)),
            [ '[preview] STAGE=build STATUS=failed' ]);
        assert.strictEqual(lines[0], '[preview] STAGE=build STATUS=failed');
        assert.ok(lines.some(line => line === '[preview] command=npm run build'));
        assert.ok(lines.some(line => line === '[preview] exit=7'));
        assert.ok(lines.some(line => line === '[preview] > first'));
        assert.ok(lines.some(line => line === '[preview] > second'));
    });

    it('never repeats a marker the failing stage printed itself', () => {
        const lines = formatFailure({
            code: 1,
            commandLine: 'npm start',
            signal: null,
            stage: 'start',
            tail: [ '[preview] STAGE=install STATUS=failed', 'real cause' ]
        }, 20);

        assert.deepStrictEqual(
            lines.filter(line => line.includes(MARKER)),
            [ '[preview] STAGE=start STATUS=failed' ]);
        assert.ok(lines.some(line => line === '[preview] > real cause'));
    });

    it('says so when the failing stage printed nothing', () => {
        const lines = formatFailure({
            code: 1,
            commandLine: 'npm install',
            signal: null,
            stage: 'install',
            tail: []
        }, 20);

        assert.ok(lines.some(line => line.includes('produced no output')));
    });

    it('says so when the stage could not be started at all', () => {
        const lines = formatFailure({
            code: null,
            commandLine: 'npm install',
            error: 'spawn npm ENOENT',
            signal: null,
            stage: 'install',
            tail: []
        }, 20);

        assert.strictEqual(lines[0], '[preview] STAGE=install STATUS=failed');
        assert.ok(lines.some(line => line.includes('could not be started: spawn npm ENOENT')));
    });
});

describe('parseStages', () => {
    it('reads the stages in the order given', () => {
        assert.deepStrictEqual(parseStages([ 'install', 'build' ]), [ 'install', 'build' ]);
    });

    it('ignores flags', () => {
        assert.deepStrictEqual(parseStages([ '--quiet', 'start' ]), [ 'start' ]);
    });

    it('refuses a stage it does not know', () => {
        assert.throws(() => parseStages([ 'deploy' ]), /unknown stage/);
    });

    it('refuses to guess when no stage is given', () => {
        assert.throws(() => parseStages([]), /no stage given/);
    });
});

describe('exitCodeFor', () => {
    it('passes the failing stage exit code on', () => {
        assert.strictEqual(exitCodeFor({ code: 7,
            ok: false }), 7);
    });

    it('fails with 1 when the stage was killed and has no code', () => {
        assert.strictEqual(exitCodeFor({ code: null,
            ok: false,
            signal: 'SIGKILL' }), 1);
    });

    it('succeeds on a successful or deliberately stopped stage', () => {
        assert.strictEqual(exitCodeFor({ code: 0,
            ok: true }), 0);
        assert.strictEqual(exitCodeFor({ code: null,
            ok: false,
            stopped: true }), 0);
        assert.strictEqual(exitCodeFor(null), 0);
    });
});

describe('a preview run', { skip: POSIX ? false : 'needs a POSIX shell' }, () => {
    for (const [ stages, failing ] of [
        [ [ 'install', 'build' ], 'install' ],
        [ [ 'install', 'build' ], 'build' ],
        [ [ 'start' ], 'start' ]
    ]) {
        it(`names ${failing} exactly once when ${failing} fails`, async () => {
            const { code, output } = await runRunner(stages, { FAIL_AT: failing });

            assert.deepStrictEqual(markerLines(output), [ `[preview] STAGE=${failing} STATUS=failed` ]);
            assert.notStrictEqual(code, 0);
            assert.ok(output.includes('[preview] exit=7'));
            assert.ok(output.includes(`[preview] > the cause: ${failing} exploded`));
        });
    }

    it('classifies a stage killed by the machine as that stage failing', async () => {
        const { code, output } = await runRunner([ 'install', 'build' ], { FAIL_AT: 'build',
            FAIL_MODE: 'signal' });

        assert.deepStrictEqual(markerLines(output), [ '[preview] STAGE=build STATUS=failed' ]);
        assert.ok(output.includes('signal=SIGKILL'));
        assert.notStrictEqual(code, 0);
    });

    it('does not run later stages once one has failed', async () => {
        const { output } = await runRunner([ 'install', 'build' ], { FAIL_AT: 'install' });

        assert.ok(output.includes('fake npm: install running'));
        assert.ok(!output.includes('fake npm: build running'));
    });

    it('marks nothing and succeeds when every stage succeeds', async () => {
        const { code, output } = await runRunner([ 'install', 'build', 'start' ]);

        assert.deepStrictEqual(markerLines(output), []);
        assert.strictEqual(code, 0);
        assert.ok(output.includes('[preview] stage build: ok'));
        assert.ok(output.includes('fake npm: start running'));
    });

    it('opts the install stage out of the mobile install work', async () => {
        const { output } = await runRunner([ 'install', 'build' ]);

        assert.ok(output.includes(`fake npm: install skip-mobile=[${SKIP_MOBILE.value}]`));
        assert.ok(output.includes('[preview] stage install: mobile install steps opted out '
            + `(${SKIP_MOBILE.name}=${SKIP_MOBILE.value})`));
    });

    it('says the build stage is a preview build, not a release one', async () => {
        const { output } = await runRunner([ 'build' ]);

        assert.ok(output.includes(
            '[preview] stage build: preview build profile, heap sized to this machine (make preview)'));
    });

    it('leaves the other stages\' environment alone', async () => {
        const { output } = await runRunner([ 'build', 'start' ]);

        assert.ok(output.includes('fake npm: build skip-mobile=[]'));
        assert.ok(output.includes('fake npm: start skip-mobile=[]'));
        assert.ok(!output.includes('[preview] stage build: mobile install steps opted out'));
    });

    it('streams the stage output through as the stage writes it', async () => {
        const { output } = await runRunner([ 'build' ]);

        assert.ok(output.includes('fake npm: build running'));
    });
});

/**
 * The recipe lines of a Makefile target, without the leading tabs and with
 * line continuations joined.
 *
 * @param {string} makefile - The Makefile source.
 * @param {string} target - The target name.
 * @returns {string} The recipe, one command per line.
 */
function recipeOf(makefile, target) {
    const lines = makefile.split('\n');
    const start = lines.findIndex(line => line.startsWith(`${target}:`));

    assert.notStrictEqual(start, -1, `the Makefile has no ${target} target`);

    const recipe = [];

    for (const line of lines.slice(start + 1)) {
        if (!line.startsWith('\t')) {
            break;
        }
        recipe.push(line.slice(1));
    }

    return recipe.join('\n').replace(/\\\n\s*/g, ' ');
}

/**
 * The prerequisites of a Makefile target.
 *
 * @param {string} makefile - The Makefile source.
 * @param {string} target - The target name.
 * @returns {string[]} The prerequisite names, in order.
 */
function prerequisitesOf(makefile, target) {
    const line = makefile.split('\n').find(candidate => candidate.startsWith(`${target}:`));

    assert.ok(line, `the Makefile has no ${target} target`);

    return line.slice(target.length + 1).trim()
        .split(/\s+/)
        .filter(Boolean);
}

/**
 * The entries the webpack preview profile builds, read out of its own source.
 *
 * Requiring `webpack.config.js` here would pull in the whole build toolchain
 * for one array; the list is what matters and it is written literally.
 *
 * @returns {string[]} The entry names.
 */
function previewEntries() {
    const source = fs.readFileSync(path.join(ROOT, 'webpack.config.js'), 'utf8');
    const block = source.match(/const PREVIEW_ENTRIES = \[([^\]]+)\]/);

    assert.ok(block, 'webpack.config.js no longer declares PREVIEW_ENTRIES');

    return block[1].match(/'([^']+)'/g).map(quoted => quoted.slice(1, -1));
}

describe('the preview build', () => {
    const makefile = fs.readFileSync(path.join(ROOT, 'Makefile'), 'utf8');
    const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;

    it('is what the build stage runs', () => {
        assert.deepStrictEqual(STAGES.build.args, [ 'run', 'build:preview' ]);
        assert.strictEqual(scripts['build:preview'], 'make preview');
    });

    it('leaves the release build alone', () => {
        assert.strictEqual(scripts.build, 'make all');
        assert.deepStrictEqual(prerequisitesOf(makefile, 'all'), [ 'compile', 'deploy' ]);
        assert.ok(recipeOf(makefile, 'compile').includes('--max-old-space-size=8192'));
    });

    it('turns the preview profile on and sizes the heap to the machine', () => {
        const recipe = recipeOf(makefile, 'compile-preview');

        assert.ok(recipe.includes('MEETSPACE_PREVIEW=1'), recipe);
        assert.ok(recipe.includes('--max-old-space-size=$(PREVIEW_HEAP_MB)'), recipe);
        assert.ok(makefile.includes('PREVIEW_HEAP_MB = $(shell node scripts/heap-size.js'), makefile);
    });

    it('deploys the preview app bundle rather than the full one', () => {
        assert.deepStrictEqual(
            prerequisitesOf(makefile, 'preview'),
            [ 'compile-preview', 'deploy-preview' ]);

        const deploy = prerequisitesOf(makefile, 'deploy-preview');

        assert.ok(deploy.includes('deploy-appbundle-preview'));
        assert.ok(!deploy.includes('deploy-appbundle'));
    });

    it('copies every bundle the preview profile emits, and nothing else', () => {
        const recipe = recipeOf(makefile, 'deploy-appbundle-preview');
        const copied = (recipe.match(/\$\(BUILD_DIR\)\/[\w.-]+\.js/g) || [])
            .map(file => file.replace('$(BUILD_DIR)/', '').replace('.min.js', ''));

        assert.deepStrictEqual([ ...copied ].sort(), [ ...previewEntries() ].sort());
    });

    it('copies no source map, because the preview profile builds none', () => {
        assert.ok(!recipeOf(makefile, 'deploy-appbundle-preview').includes('.map'));
        assert.ok(recipeOf(makefile, 'deploy-appbundle').includes('.map'));
    });

    it('deploys every asset the full build deploys', () => {
        const full = prerequisitesOf(makefile, 'deploy')
            .filter(target => target !== 'deploy-appbundle');

        for (const target of full) {
            assert.ok(
                prerequisitesOf(makefile, 'deploy-preview').includes(target),
                `the preview deploy is missing ${target}`);
        }
    });
});

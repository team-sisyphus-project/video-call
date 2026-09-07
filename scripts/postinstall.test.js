/**
 * Tests for the install-time postinstall steps.
 *
 * Run with `npm run test:postinstall`.
 *
 * The property under test is which commands an install runs, so the steps are
 * driven through an injected spawner and their invocations recorded. The real
 * steps take minutes and rewrite node_modules; the end-to-end cases use a fake
 * `patch-package` and a fake `npm` on PATH instead.
 */

const assert = require('assert');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const { describe, it } = require('node:test');
const os = require('os');
const path = require('path');

const {
    MARKER,
    SKIP_MOBILE,
    STEP_NAMES,
    formatExit,
    formatFailure,
    formatSummary,
    planSteps,
    resolveCommand,
    runSteps,
    skipsMobile
} = require('./postinstall');

const SCRIPT = path.join(__dirname, 'postinstall.js');
const POSIX = process.platform !== 'win32';

/**
 * The steps that exist for the React Native side of the project, in install
 * order. These are the ones a web preview has no use for.
 */
const MOBILE_STEPS = [ 'jetify', 'android-clean-cmake-cache', 'android-autolinking' ];

/**
 * The environment that opts out of the mobile install work.
 */
const OPTED_OUT = { [SKIP_MOBILE.name]: SKIP_MOBILE.value };

/**
 * A spawner that runs nothing and records what it was asked to run.
 *
 * @param {Object} [outcomes] - Exit code by step command, defaulting to 0.
 * @returns {Function} The spawner, with the `calls` it recorded.
 */
function createSpawner(outcomes = {}) {
    const calls = [];

    /**
     * Stands in for `child_process.spawn`.
     *
     * @param {string} command - The command.
     * @param {string[]} args - The arguments.
     * @returns {Object} A child that closes on the next tick.
     */
    function spawnFn(command, args) {
        const child = new EventEmitter();
        const name = path.basename(command);

        calls.push([ name, ...args ].join(' '));
        setImmediate(() => child.emit('close', outcomes[name] ?? 0, null));

        return child;
    }

    spawnFn.calls = calls;

    return spawnFn;
}

/**
 * Runs a plan with a recording spawner.
 *
 * @param {Object} env - The environment to plan from.
 * @param {Object} [outcomes] - Exit code by step command.
 * @returns {Promise<Object>} The outcome, the commands run and the lines
 * logged.
 */
async function run(env, outcomes = {}) {
    const spawnFn = createSpawner(outcomes);
    const lines = [];
    const outcome = await runSteps(planSteps(env), { env,
        log: line => lines.push(line),
        spawnFn });

    return { commands: spawnFn.calls,
        lines,
        outcome,
        output: lines.join('\n') };
}

/**
 * Writes a fake `patch-package` and a fake `npm` that announce themselves and
 * fail when told to by `FAIL_AT`.
 *
 * @returns {string} The directory to put in front of PATH.
 */
function createFakeBins() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meetspace-postinstall-'));

    for (const [ name, stage ] of [ [ 'patch-package', 'patch-package' ], [ 'jetify', 'jetify' ] ]) {
        fs.writeFileSync(path.join(dir, name), [
            '#!/bin/sh',
            `stage=${stage}`,
            'echo "fake $stage running"',
            'if [ "$stage" = "$FAIL_AT" ]; then echo "the cause: $stage exploded" >&2; exit 7; fi',
            'exit 0',
            ''
        ].join('\n'));
        fs.chmodSync(path.join(dir, name), 0o755);
    }

    fs.writeFileSync(path.join(dir, 'npm'), [
        '#!/bin/sh',
        'stage="$2"',
        'echo "fake npm: $stage running"',
        'if [ "$stage" = "$FAIL_AT" ]; then echo "the cause: $stage exploded" >&2; exit 7; fi',
        'exit 0',
        ''
    ].join('\n'));
    fs.chmodSync(path.join(dir, 'npm'), 0o755);

    return dir;
}

/**
 * Runs the real script with the fake executables in front of PATH.
 *
 * @param {Object} [env] - Extra environment, `FAIL_AT` included.
 * @returns {Promise<Object>} The exit code and the combined output.
 */
function runScript(env = {}) {
    const bin = createFakeBins();

    return new Promise(resolve => {
        execFile(process.execPath, [ SCRIPT ], {
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

describe('skipsMobile', () => {
    it('opts out only when the variable says so', () => {
        assert.strictEqual(skipsMobile({ [SKIP_MOBILE.name]: '1' }), true);
        assert.strictEqual(skipsMobile({ [SKIP_MOBILE.name]: 'true' }), true);
        assert.strictEqual(skipsMobile({ [SKIP_MOBILE.name]: 'TRUE' }), true);
    });

    it('runs the mobile steps for any other value, and when unset', () => {
        assert.strictEqual(skipsMobile({}), false);
        assert.strictEqual(skipsMobile({ [SKIP_MOBILE.name]: '' }), false);
        assert.strictEqual(skipsMobile({ [SKIP_MOBILE.name]: '0' }), false);
        assert.strictEqual(skipsMobile({ [SKIP_MOBILE.name]: 'false' }), false);
        assert.strictEqual(skipsMobile({ [SKIP_MOBILE.name]: 'no' }), false);
    });
});

describe('planSteps', () => {
    it('keeps every step, in install order, whatever the environment', () => {
        for (const env of [ {}, OPTED_OUT ]) {
            assert.deepStrictEqual(planSteps(env).map(entry => entry.step.name), STEP_NAMES);
        }
    });

    it('runs patch-package whether or not the mobile work is opted out', () => {
        for (const env of [ {}, OPTED_OUT ]) {
            const patching = planSteps(env).find(entry => entry.step.name === 'patch-package');

            assert.strictEqual(patching.skipped, false);
        }
    });

    it('skips the mobile steps, and only those, when opted out', () => {
        const skipped = planSteps(OPTED_OUT)
            .filter(entry => entry.skipped)
            .map(entry => entry.step.name);

        assert.deepStrictEqual(skipped, MOBILE_STEPS);
    });

    it('names the variable that skipped a step', () => {
        const jetify = planSteps(OPTED_OUT).find(entry => entry.step.name === 'jetify');

        assert.strictEqual(jetify.reason, `${SKIP_MOBILE.name}=1`);
    });

    it('skips nothing by default', () => {
        assert.deepStrictEqual(planSteps({}).filter(entry => entry.skipped), []);
    });
});

describe('an install', () => {
    it('runs the same four commands, in the same order, by default', async () => {
        const { commands, outcome } = await run({});

        assert.deepStrictEqual(commands, [
            'patch-package --error-on-fail',
            'jetify',
            'npm run android-clean-cmake-cache',
            'npm run android-autolinking'
        ]);
        assert.strictEqual(outcome.ok, true);
    });

    it('runs patch-package and nothing else when the mobile work is opted out', async () => {
        const { commands, outcome } = await run(OPTED_OUT);

        assert.deepStrictEqual(commands, [ 'patch-package --error-on-fail' ]);
        assert.strictEqual(outcome.ok, true);
    });

    it('spawns no jetify, cmake or autolinking process when opted out', async () => {
        const { commands } = await run(OPTED_OUT);

        for (const step of MOBILE_STEPS) {
            assert.ok(!commands.some(command => command.includes(step)), `${step} should not have run`);
        }
    });

    it('says on one line which steps ran and which were skipped', async () => {
        const { output } = await run(OPTED_OUT);

        assert.deepStrictEqual(markerLines(output), [
            '[postinstall] STAGE=install STATUS=ok '
                + 'ran=patch-package skipped=jetify,android-clean-cmake-cache,android-autolinking'
        ]);
    });

    it('reports every step as run when nothing is opted out', async () => {
        const { output } = await run({});

        assert.deepStrictEqual(markerLines(output), [
            `[postinstall] STAGE=install STATUS=ok ran=${STEP_NAMES.join(',')} skipped=none`
        ]);
    });

    it('names each skipped step and the variable that skipped it', async () => {
        const { lines } = await run(OPTED_OUT);

        for (const step of MOBILE_STEPS) {
            assert.ok(lines.includes(`[postinstall] step ${step}: skipped (${SKIP_MOBILE.name}=1)`));
        }
    });

    it('stops at the first failing step and names it once', async () => {
        const { commands, outcome, output } = await run({}, { jetify: 3 });

        assert.deepStrictEqual(markerLines(output), [ '[postinstall] STAGE=install STATUS=failed STEP=jetify' ]);
        assert.strictEqual(outcome.ok, false);
        assert.deepStrictEqual(commands, [ 'patch-package --error-on-fail', 'jetify' ]);
    });

    it('reports no summary when a step failed', async () => {
        const { output } = await run({}, { 'patch-package': 1 });

        assert.ok(!output.includes('STATUS=ok'));
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

    it('reports a step that never ran as having no status', () => {
        assert.strictEqual(formatExit({ code: null,
            error: 'spawn jetify ENOENT',
            signal: null }), 'exit=none');
    });
});

describe('formatFailure', () => {
    it('names the step once, with the command, the exit code and the hint', () => {
        const lines = formatFailure({
            code: 1,
            commandLine: 'patch-package --error-on-fail',
            hint: 'the patches did not apply.',
            name: 'patch-package',
            signal: null
        });

        assert.deepStrictEqual(
            lines.filter(line => line.includes(MARKER)),
            [ '[postinstall] STAGE=install STATUS=failed STEP=patch-package' ]);
        assert.strictEqual(lines[0], '[postinstall] STAGE=install STATUS=failed STEP=patch-package');
        assert.ok(lines.includes('[postinstall] command=patch-package --error-on-fail'));
        assert.ok(lines.includes('[postinstall] exit=1'));
        assert.ok(lines.includes('[postinstall] the patches did not apply.'));
    });

    it('says so when the step could not be started at all', () => {
        const lines = formatFailure({
            code: null,
            commandLine: 'jetify',
            error: 'spawn jetify ENOENT',
            hint: 'only needed for an Android build.',
            name: 'jetify',
            signal: null
        });

        assert.ok(lines.some(line => line.includes('could not be started: spawn jetify ENOENT')));
    });
});

describe('formatSummary', () => {
    it('reports both lists as none when there is nothing to report', () => {
        assert.strictEqual(formatSummary([]), `${MARKER}ok ran=none skipped=none`);
    });
});

describe('resolveCommand', () => {
    it('prefers the copy the install placed in node_modules/.bin', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meetspace-bin-'));
        const bin = path.join(root, 'node_modules', '.bin');
        const suffix = process.platform === 'win32' ? '.cmd' : '';

        fs.mkdirSync(bin, { recursive: true });
        fs.writeFileSync(path.join(bin, `patch-package${suffix}`), '');

        const step = { bin: true,
            command: 'patch-package' };

        assert.strictEqual(resolveCommand(step, root), path.join(bin, `patch-package${suffix}`));

        fs.rmSync(root, { force: true,
            recursive: true });
    });

    it('falls back to the name on PATH when there is no local copy', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meetspace-bin-'));

        assert.strictEqual(resolveCommand({ bin: true,
            command: 'patch-package' }, root), 'patch-package');
        assert.strictEqual(resolveCommand({ bin: false,
            command: 'npm' }, root), 'npm');

        fs.rmSync(root, { force: true,
            recursive: true });
    });
});

describe('the script itself', { skip: POSIX ? false : 'needs a POSIX shell' }, () => {
    it('runs only patch-package when the mobile work is opted out', async () => {
        const { code, output } = await runScript(OPTED_OUT);

        assert.strictEqual(code, 0);
        assert.ok(output.includes('fake patch-package running'));
        assert.ok(!output.includes('fake jetify running'));
        assert.ok(!output.includes('fake npm: android-clean-cmake-cache running'));
        assert.ok(!output.includes('fake npm: android-autolinking running'));
        assert.deepStrictEqual(markerLines(output).length, 1);
    });

    it('runs every step by default', async () => {
        const { code, output } = await runScript();

        assert.strictEqual(code, 0);
        assert.ok(output.includes('fake patch-package running'));
        assert.ok(output.includes('fake jetify running'));
        assert.ok(output.includes('fake npm: android-clean-cmake-cache running'));
        assert.ok(output.includes('fake npm: android-autolinking running'));
    });

    it('exits with the failing step code and names the step', async () => {
        const { code, output } = await runScript({ ...OPTED_OUT,
            FAIL_AT: 'patch-package' });

        assert.strictEqual(code, 7);
        assert.deepStrictEqual(markerLines(output), [
            '[postinstall] STAGE=install STATUS=failed STEP=patch-package'
        ]);
        assert.ok(output.includes('[postinstall] exit=7'));
    });
});

/* eslint-disable no-console */

/**
 * The `postinstall` step of `npm install`.
 *
 * Installing this project used to end in a fixed chain of four commands:
 *
 *     patch-package --error-on-fail && jetify
 *         && npm run android-clean-cmake-cache && npm run android-autolinking
 *
 * Three of those four exist for the React Native side of the project. They walk
 * `node_modules` looking for Android sources, delete CMake caches and shell out
 * to `react-native config`, which loads every native package in the tree. A web
 * preview never builds an Android target, so that work buys nothing there — it
 * only spends the preview's install window and its memory.
 *
 * This script keeps the chain, and lets the mobile part of it be opted out of:
 * with `MEETSPACE_SKIP_MOBILE=1` in the environment only `patch-package` runs.
 * `patch-package` is never optional — it applies the source patches the web
 * bundle itself is built from, so skipping it would change what gets built.
 *
 * Which steps ran is reported on one machine-greppable line:
 *
 *     [postinstall] STAGE=install STATUS=ok ran=patch-package skipped=jetify,...
 *
 * and a failure names the step that failed on a line of the same shape. Exactly
 * one such line is printed per run.
 *
 * Usage: node scripts/postinstall.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/**
 * Prefix every line of this script's own output carries. The prefix is owned by
 * the process that writes it: the preview runner's `[preview]` verdict is the
 * runner's, and this one is this script's.
 */
const PREFIX = '[postinstall]';

/**
 * The report marker, without the status. One line with this shape is printed
 * per run — `STATUS=ok` or `STATUS=failed` — and nothing else in this script's
 * output may look like it.
 */
const MARKER = `${PREFIX} STAGE=install STATUS=`;

/**
 * The environment variable that opts out of the mobile install work, and the
 * value the preview runner sets it to.
 */
const SKIP_MOBILE = {
    name: 'MEETSPACE_SKIP_MOBILE',
    value: '1'
};

/**
 * The values of `MEETSPACE_SKIP_MOBILE` that mean "opted out". Anything else,
 * including `0`, `false`, an empty value and an unset variable, means the
 * mobile steps run — an install only skips work when it says so.
 */
const OPT_OUT_VALUES = [ '1', 'true' ];

/**
 * npm, under the name the platform knows it by.
 */
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * The install steps, in the order the original `postinstall` chain ran them.
 *
 * `mobile` marks a step as existing for the React Native side of the project
 * and so as opt-out-able. `bin` marks a step that is a dependency's executable
 * rather than one of this project's npm scripts. `hint` is what a reader most
 * likely needs to know about a failure in that step, and is printed only when
 * the step fails.
 */
const STEPS = [
    {
        args: [ '--error-on-fail' ],
        bin: true,
        command: 'patch-package',
        hint: 'the source patches in patches/ did not apply. The build reads the patched '
            + 'sources, so this step runs on every install, preview included.',
        mobile: false,
        name: 'patch-package'
    },
    {
        args: [],
        bin: true,
        command: 'jetify',
        hint: 'rewriting the Android support-library references in node_modules failed. '
            + 'This step is only needed for an Android build.',
        mobile: true,
        name: 'jetify'
    },
    {
        args: [ 'run', 'android-clean-cmake-cache' ],
        bin: false,
        command: NPM,
        hint: 'clearing the native CMake caches under android/ and node_modules failed. '
            + 'This step is only needed for an Android build.',
        mobile: true,
        name: 'android-clean-cmake-cache'
    },
    {
        args: [ 'run', 'android-autolinking' ],
        bin: false,
        command: NPM,
        hint: 'generating the React Native autolinking manifest failed. `react-native '
            + 'config` loads every native package; this step is only needed for an '
            + 'Android build.',
        mobile: true,
        name: 'android-autolinking'
    }
];

/**
 * The step names, in install order.
 */
const STEP_NAMES = STEPS.map(step => step.name);

/**
 * Reads whether the mobile install work has been opted out of.
 *
 * @param {Object} [env] - The environment to read from.
 * @returns {boolean} Whether the mobile steps are to be skipped.
 */
function skipsMobile(env = process.env) {
    const raw = env[SKIP_MOBILE.name];

    return typeof raw === 'string' && OPT_OUT_VALUES.includes(raw.trim().toLowerCase());
}

/**
 * Decides which steps run and which are skipped.
 *
 * Every step appears in the plan, skipped or not, so the plan is the whole
 * story of an install rather than the part of it that happened to run.
 *
 * @param {Object} [env] - The environment to read from.
 * @returns {Object[]} One entry per step, in install order, each with `step`,
 * `skipped` and the `reason` it was skipped.
 */
function planSteps(env = process.env) {
    const skip = skipsMobile(env);

    return STEPS.map(step => {
        const skipped = Boolean(step.mobile) && skip;

        return {
            reason: skipped ? `${SKIP_MOBILE.name}=${env[SKIP_MOBILE.name]}` : null,
            skipped,
            step
        };
    });
}

/**
 * Finds the executable for a step.
 *
 * A dependency's executable is taken from this project's `node_modules/.bin`
 * when it is there, because that is the copy the install just placed and the
 * one npm would have put on PATH. Falling back to the bare name keeps the step
 * runnable when the script is invoked outside an npm run.
 *
 * @param {Object} step - The step.
 * @param {string} [root] - The project root.
 * @returns {string} The command to spawn.
 */
function resolveCommand(step, root = ROOT) {
    if (!step.bin) {
        return step.command;
    }

    const suffix = process.platform === 'win32' ? '.cmd' : '';
    const local = path.join(root, 'node_modules', '.bin', `${step.command}${suffix}`);

    return fs.existsSync(local) ? local : step.command;
}

/**
 * Renders the exit status of a step.
 *
 * A step killed by a signal never had an exit code of its own; the shell
 * convention of 128 plus the signal number is used so the status always reads
 * as a number, with the signal named next to it. A step that could not be
 * spawned never ran, and says so rather than inventing a status.
 *
 * @param {Object} result - The step result.
 * @returns {string} The status, as `exit=N`, `exit=N signal=SIGNAME` or
 * `exit=none`.
 */
function formatExit({ code, error, signal }) {
    if (error) {
        return 'exit=none';
    }

    if (signal) {
        const number = os.constants.signals[signal];
        const status = typeof number === 'number' ? 128 + number : 1;

        return `exit=${status} signal=${signal}`;
    }

    return `exit=${code}`;
}

/**
 * Renders the failure report for a step.
 *
 * @param {Object} result - The failed step result.
 * @returns {string[]} The lines to print.
 */
function formatFailure(result) {
    const lines = [
        `${MARKER}failed STEP=${result.name}`,
        `${PREFIX} command=${result.commandLine}`,
        `${PREFIX} ${formatExit(result)}`,
        `${PREFIX} ${result.hint}`
    ];

    if (result.error) {
        lines.push(`${PREFIX} the ${result.name} step could not be started: ${result.error}`);
    }

    return lines;
}

/**
 * Renders the one line that says what an install actually did.
 *
 * Both lists are always present, `none` included, so the line reads the same
 * whether or not anything was opted out of and can be compared across installs
 * without parsing an absence.
 *
 * @param {Object[]} plan - The plan, as from `planSteps`.
 * @returns {string} The line to print.
 */
function formatSummary(plan) {
    const names = skipped => plan.filter(entry => entry.skipped === skipped)
        .map(entry => entry.step.name)
        .join(',') || 'none';

    return `${MARKER}ok ran=${names(false)} skipped=${names(true)}`;
}

/**
 * Runs one step to completion.
 *
 * The step's output is passed straight through: this script reports on steps,
 * it does not quote them.
 *
 * @param {Object} step - The step to run.
 * @param {Object} [options] - The options.
 * @param {string} [options.cwd] - Where to run the step.
 * @param {Object} [options.env] - The environment for the step.
 * @param {Function} [options.spawnFn] - The spawner, for tests.
 * @returns {Promise<Object>} The step result.
 */
function runStep(step, { cwd = ROOT, env = process.env, spawnFn = spawn } = {}) {
    const command = resolveCommand(step, cwd);
    const commandLine = [ step.command, ...step.args ].join(' ');
    const startedAt = Date.now();

    return new Promise(resolve => {
        const child = spawnFn(command, step.args, {
            cwd,
            env,
            stdio: 'inherit'
        });

        /**
         * Reports the step as finished. A step that could not be spawned at all
         * fails like any other, at a step that is just as knowable.
         *
         * @param {Object} outcome - What became of the step.
         * @param {number|null} [outcome.code] - The exit code.
         * @param {string|null} [outcome.error] - Why it could not be spawned.
         * @param {string|null} [outcome.signal] - The signal that killed it.
         * @returns {void}
         */
        function finish({ code = null, error = null, signal = null }) {
            resolve({
                code,
                commandLine,
                durationMs: Date.now() - startedAt,
                error,
                hint: step.hint,
                name: step.name,
                ok: code === 0 && !error,
                signal
            });
        }

        child.on('error', error => finish({ error: error.message }));
        child.on('close', (code, signal) => finish({ code,
            signal }));
    });
}

/**
 * Runs a plan in order, stopping at the first step that fails.
 *
 * @param {Object[]} plan - The plan, as from `planSteps`.
 * @param {Object} [options] - The options, as for `runStep`, plus `log`.
 * @returns {Promise<Object>} The outcome, with `ok` and the `failure` if any.
 */
async function runSteps(plan, options = {}) {
    const { log = console.error } = options;

    for (const { reason, skipped, step } of plan) {
        if (skipped) {
            log(`${PREFIX} step ${step.name}: skipped (${reason})`);
            continue;
        }

        log(`${PREFIX} step ${step.name}: running`);

        // Steps are a sequence by definition: patching the sources before
        // anything reads them is the whole point of the order.
        // eslint-disable-next-line no-await-in-loop
        const result = await runStep(step, options);

        if (!result.ok) {
            // One write, so the report cannot end up interleaved with anything
            // the step was still writing when it died.
            log(formatFailure(result).join('\n'));

            return { failure: result,
                ok: false };
        }

        log(`${PREFIX} step ${step.name}: ok in ${Math.round(result.durationMs / 1000)}s`);
    }

    log(formatSummary(plan));

    return { failure: null,
        ok: true };
}

/**
 * Runs the install steps this environment asks for.
 *
 * @returns {Promise<void>} Resolved once the process exit code is set.
 */
async function main() {
    const outcome = await runSteps(planSteps(process.env));

    if (outcome.ok) {
        return;
    }

    const { code } = outcome.failure;

    process.exitCode = typeof code === 'number' && code !== 0 ? code : 1;
}

if (require.main === module) {
    main();
}

module.exports = {
    MARKER,
    PREFIX,
    SKIP_MOBILE,
    STEPS,
    STEP_NAMES,
    formatExit,
    formatFailure,
    formatSummary,
    planSteps,
    resolveCommand,
    runStep,
    runSteps,
    skipsMobile
};

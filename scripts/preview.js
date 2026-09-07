/* eslint-disable no-console */

/**
 * Staged preview runner.
 *
 * The preview platform runs two commands — a build command and a serve command
 * — and reports one thing when either does not work out: the preview never
 * became ready. Three very different failures look identical from there:
 * dependency installation dying in `postinstall`, webpack being killed while
 * compiling, and the server refusing to start because the build produced no
 * assets.
 *
 * This runner puts a name on the stage that stopped. It runs each stage in
 * order, streams the stage's output through untouched, and when a stage exits
 * non-zero it prints one machine-greppable line naming that stage:
 *
 *     [preview] STAGE=build STATUS=failed
 *
 * followed by the command, the exit status, and the tail of that stage's own
 * output. Exactly one such line is ever printed per run: the first stage to
 * fail ends the run, and stages that succeed are reported without the marker.
 *
 * The `start` stage is the one that is meant to keep running, so for it a
 * termination request is not automatically a clean teardown: a preview harness
 * that gives up waiting for readiness stops the runner exactly the way a human
 * ending a session does. The two are told apart by the only evidence there is —
 * whether the server wrote its own ready line before the stop.
 *
 * Usage: node scripts/preview.js <stage> [stage...]
 * Stages: install, build, start.
 */

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const { SKIP_MOBILE } = require('./postinstall');

const ROOT = path.resolve(__dirname, '..');

/**
 * Prefix every line of this runner's own output carries, so the runner's
 * reporting is distinguishable from the output of the stage it runs.
 */
const PREFIX = '[preview]';

/**
 * The failure marker, without the stage. One line with this shape is printed
 * per failed run, and nothing else in this runner's output may look like it.
 */
const MARKER = `${PREFIX} STAGE=`;

/**
 * How many lines of the failing stage's output to repeat under the marker.
 * The tail is what identifies the proximate cause; the stream above it is the
 * whole story. `PREVIEW_TAIL_LINES` overrides.
 */
const DEFAULT_TAIL_LINES = 20;

/**
 * A stage that produces no newline for this long (webpack's progress bar, for
 * one) still gets its buffer recorded rather than growing without bound.
 */
const MAX_PENDING_CHARS = 4096;

/**
 * npm, under the name the platform knows it by.
 */
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * The line the `start` stage's server writes once it has served the application
 * over its port, and the runner's only evidence that the stage got that far.
 *
 * It is the server's own marker, not this runner's — a different prefix, on
 * purpose, so quoting it can never be mistaken for a verdict. The string is
 * written in two places, here and in `server/index.js`; `preview.test.js` holds
 * the two together against the server's `formatReady()`.
 */
const READY_LINE = /^\[meetspace] STAGE=start STATUS=ready\b/;

/**
 * The stages, in the order a preview goes through them. `hint` is what a
 * reader most likely needs to know about a failure at that stage, and is
 * printed only when the stage fails. `env` is what the stage is run with on
 * top of this process's environment, and `note` says what that changes — a
 * preview that quietly does less than a plain `npm install` would be a trap
 * for whoever reads the log next.
 *
 * A stage that is meant to keep running also declares `readyLine`, the line it
 * writes once it has done what it was started for, and `stoppedHint`, what a
 * stop arriving before that line means.
 */
const STAGES = {
    install: {
        args: [ 'install' ],
        command: NPM,
        env: { [SKIP_MOBILE.name]: SKIP_MOBILE.value },
        hint: 'dependency installation failed. `npm install` also runs postinstall; a failure '
            + 'there stops the install. The postinstall report names the step that failed.',
        note: `mobile install steps opted out (${SKIP_MOBILE.name}=${SKIP_MOBILE.value})`
    },
    build: {
        args: [ 'run', 'build:preview' ],
        command: NPM,
        hint: 'compilation failed. `npm run build:preview` is webpack plus the asset deploy; '
            + 'a kill by signal here is usually the machine running out of memory, and the '
            + 'heap the build asked for is on the [heap-size] line above.',
        note: 'preview build profile, heap sized to this machine (make preview)'
    },
    start: {
        args: [ 'start' ],
        command: NPM,
        hint: 'the application did not start. The server refuses to start when the build '
            + 'output is missing and names the files it wanted; check the lines above.',
        readyLine: READY_LINE,
        stoppedHint: 'the application was stopped before it was ready. It never wrote its '
            + '"STAGE=start STATUS=ready" line, so it was still starting when the stop '
            + 'arrived — a readiness timeout looks exactly like this. The server writes that '
            + 'line only once it has served its own request, so the last thing it did print '
            + 'above is where it got stuck; a run that is merely slow needs a longer readiness '
            + 'window, not a restart.'
    }
};

/**
 * The stage names, in preview order.
 */
const STAGE_NAMES = Object.keys(STAGES);

/**
 * Collects the last lines written by a stage.
 *
 * Output arrives as arbitrary chunks and carriage returns are line breaks here
 * too, because progress bars redraw with them and their last redraw is often
 * the most informative line there is.
 *
 * @param {number} limit - How many lines to keep.
 * @param {Function} [onLine] - Called with each completed line as it arrives,
 * for callers that need to see output the tail will later drop.
 * @returns {Object} A sink with `write` and `lines`.
 */
function createTail(limit, onLine = () => { /* nothing to watch for */ }) {
    const kept = [];
    let pending = '';

    /**
     * Keeps one line, discarding the oldest once the limit is reached.
     *
     * @param {string} line - The line to keep.
     * @returns {void}
     */
    function keep(line) {
        const text = line.trimEnd();

        if (text === '') {
            return;
        }

        onLine(text);
        kept.push(text);

        if (kept.length > limit) {
            kept.splice(0, kept.length - limit);
        }
    }

    return {
        write(chunk) {
            const parts = `${pending}${chunk}`.split(/\r\n|\n|\r/);

            pending = parts.pop();
            parts.forEach(keep);

            if (pending.length > MAX_PENDING_CHARS) {
                keep(pending);
                pending = '';
            }
        },

        lines() {
            const all = pending.trim() === '' ? kept : [ ...kept, pending.trimEnd() ];

            return all.slice(-limit);
        }
    };
}

/**
 * Reads how many tail lines to report.
 *
 * @param {Object} env - The environment to read from.
 * @returns {number} The number of lines.
 */
function tailLimit(env) {
    const raw = Number(env.PREVIEW_TAIL_LINES);

    return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_TAIL_LINES;
}

/**
 * Renders the exit status of a stage.
 *
 * A stage killed by a signal never had an exit code of its own; the shell
 * convention of 128 plus the signal number is used so the status always reads
 * as a number, with the signal named next to it. A stage that could not be
 * spawned never ran, and says so rather than inventing a status.
 *
 * @param {Object} result - The stage result.
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
 * Whether a stage was stopped on request before it ever reported itself ready.
 *
 * Only a stage that says what "ready" looks like can be judged this way; for
 * every other stage a stop on request is just a stop, because there is no
 * moment in it that "too early" could be measured against.
 *
 * @param {Object} result - The stage result.
 * @returns {boolean} True when the stop cut the stage short.
 */
function stoppedBeforeReady({ ready, stage, stopped }) {
    const { readyLine } = STAGES[stage] || {};

    return Boolean(stopped && readyLine && !ready);
}

/**
 * Renders the failure report for a stage.
 *
 * A stage stopped before it was ready failed at being ready, not at whatever
 * that stage usually fails at, so it gets the hint that says so.
 *
 * The marker comes first and appears once. Tail lines are quoted with a `>`
 * and any line of the stage's own output that looks like a marker is dropped,
 * so grepping for the marker can only ever find this runner's verdict.
 *
 * @param {Object} result - The failed stage result.
 * @param {number} limit - How many tail lines were kept.
 * @returns {string[]} The lines to print.
 */
function formatFailure(result, limit) {
    const { hint, stoppedHint } = STAGES[result.stage];
    const cutShort = stoppedBeforeReady(result);
    const lines = [
        `${MARKER}${result.stage} STATUS=failed`,
        `${PREFIX} command=${result.commandLine}`,
        `${PREFIX} ${formatExit(result)}`
    ];
    const tail = result.tail.filter(line => !line.includes(MARKER));

    if (cutShort) {
        // Said outright, because the exit status of a stage that shut down when
        // asked to says nothing about whether it should have been asked.
        const seconds = Number.isFinite(result.durationMs) ? ` after ${Math.round(result.durationMs / 1000)}s` : '';

        lines.push(`${PREFIX} stopped on request${seconds}, before the ${result.stage} stage was ready`);
    }

    lines.push(`${PREFIX} ${cutShort ? stoppedHint : hint}`);

    if (result.error) {
        lines.push(`${PREFIX} the ${result.stage} stage could not be started: ${result.error}`);

        return lines;
    }

    if (tail.length) {
        lines.push(`${PREFIX} last ${Math.min(tail.length, limit)} line(s) of ${result.stage} output:`);
        tail.forEach(line => lines.push(`${PREFIX} > ${line}`));
    } else {
        lines.push(`${PREFIX} the ${result.stage} stage produced no output.`);
    }

    return lines;
}

/**
 * Runs one stage to completion.
 *
 * The stage's output is streamed on as it arrives — this is the only copy of
 * it — while the tail is kept for the report.
 *
 * @param {string} stage - The stage name.
 * @param {Object} [options] - The options.
 * @param {Object} [options.env] - The environment for the stage.
 * @param {string} [options.cwd] - Where to run the stage.
 * @returns {Promise<Object>} The stage result.
 */
function runStage(stage, { cwd = ROOT, env = process.env } = {}) {
    const { args, command, env: overrides } = STAGES[stage];
    const stageEnv = overrides ? { ...env,
        ...overrides } : env;
    const { readyLine } = STAGES[stage];
    const commandLine = [ command, ...args ].join(' ');
    let ready = false;

    /**
     * Notes the stage's ready line going past. The tail keeps only the last
     * lines and a long-running stage writes past them, so readiness is decided
     * as the output arrives, not from what survived.
     *
     * @param {string} line - A line the stage wrote.
     * @returns {void}
     */
    function watch(line) {
        ready = ready || Boolean(readyLine && readyLine.test(line));
    }

    const tail = createTail(tailLimit(env), watch);
    const startedAt = Date.now();

    return new Promise(resolve => {
        const child = spawn(command, args, {
            cwd,
            env: stageEnv,
            stdio: [ 'inherit', 'pipe', 'pipe' ]
        });
        let stopped = false;

        /**
         * Passes a termination signal on to the stage, once, and remembers
         * that the stage was stopped rather than having failed. A preview
         * being torn down is not a stage failure and must not be reported as
         * one.
         *
         * @param {string} signal - The signal received.
         * @returns {void}
         */
        function forward(signal) {
            stopped = true;
            child.kill(signal);
        }

        const handlers = [ 'SIGINT', 'SIGTERM' ].map(signal => {
            const handler = () => forward(signal);

            process.on(signal, handler);

            return { handler,
                signal };
        });

        /**
         * Detaches the signal handlers installed for this stage.
         *
         * @returns {void}
         */
        function cleanup() {
            handlers.forEach(({ handler, signal }) => process.removeListener(signal, handler));
        }

        for (const [ stream, sink ] of [ [ child.stdout, process.stdout ], [ child.stderr, process.stderr ] ]) {
            stream.setEncoding('utf8');
            stream.on('data', chunk => {
                tail.write(chunk);
                sink.write(chunk);
            });
        }

        /**
         * Reports the stage as finished. A stage that could not be spawned at
         * all fails like any other, at a stage that is just as knowable.
         *
         * @param {Object} outcome - What became of the stage.
         * @param {number|null} [outcome.code] - The exit code.
         * @param {string|null} [outcome.error] - Why it could not be spawned.
         * @param {string|null} [outcome.signal] - The signal that killed it.
         * @returns {void}
         */
        function finish({ code = null, error = null, signal = null }) {
            const lines = tail.lines();

            // A last line the stage never terminated has not been watched yet;
            // a server killed mid-write could have its ready line in it.
            lines.forEach(watch);
            cleanup();
            resolve({
                code,
                commandLine,
                durationMs: Date.now() - startedAt,
                error,
                ok: code === 0 && !error,
                ready,
                signal,
                stage,
                stopped,
                tail: lines
            });
        }

        child.on('error', error => finish({ error: error.message }));
        child.on('close', (code, signal) => finish({ code,
            signal }));
    });
}

/**
 * Runs stages in order, stopping at the first one that fails.
 *
 * @param {string[]} stages - The stage names to run.
 * @param {Object} [options] - The options, as for `runStage`, plus `log`.
 * @returns {Promise<Object>} The result of the last stage that ran.
 */
async function runStages(stages, options = {}) {
    const { env = process.env, log = console.error } = options;
    let last = null;

    for (const stage of stages) {
        const { note } = STAGES[stage];

        log(`${PREFIX} stage ${stage}: running`);

        if (note) {
            log(`${PREFIX} stage ${stage}: ${note}`);
        }

        // Stages are a sequence by definition: nothing may start before the
        // stage before it has finished.
        // eslint-disable-next-line no-await-in-loop
        last = await runStage(stage, options);

        // Before the clean-teardown case, because a server that shuts down
        // politely on SIGTERM leaves with a zero exit code whether or not it
        // ever served anything, and that zero is not an answer to "was it
        // ready".
        if (stoppedBeforeReady(last)) {
            log(formatFailure(last, tailLimit(env)).join('\n'));

            return last;
        }

        if (last.stopped) {
            log(`${PREFIX} stage ${stage}: stopped on request after ${Math.round(last.durationMs / 1000)}s`);

            return last;
        }

        if (!last.ok) {
            // One write, so the report cannot end up interleaved with anything
            // the stage was still writing when it died.
            log(formatFailure(last, tailLimit(env)).join('\n'));

            return last;
        }

        log(`${PREFIX} stage ${stage}: ok in ${Math.round(last.durationMs / 1000)}s`);
    }

    return last;
}

/**
 * Turns a stage result into this process's exit code.
 *
 * A stage stopped before it was ready fails even though it may well have left
 * with a zero status of its own: it was asked to shut down and did so
 * correctly, but the thing it was started for never happened.
 *
 * @param {Object} result - The last stage result, or null when nothing ran.
 * @returns {number} The exit code.
 */
function exitCodeFor(result) {
    if (!result) {
        return 0;
    }

    if (!stoppedBeforeReady(result) && (result.ok || result.stopped)) {
        return 0;
    }

    return typeof result.code === 'number' && result.code !== 0 ? result.code : 1;
}

/**
 * Reads the stages to run out of argv.
 *
 * @param {string[]} argv - The arguments, without node and the script.
 * @returns {string[]} The stage names.
 */
function parseStages(argv) {
    const stages = argv.filter(argument => !argument.startsWith('-'));
    const unknown = stages.filter(stage => !STAGE_NAMES.includes(stage));

    if (unknown.length) {
        throw new Error(`unknown stage(s): ${unknown.join(', ')}. Known stages: ${STAGE_NAMES.join(', ')}`);
    }

    if (!stages.length) {
        throw new Error(`no stage given. Usage: node scripts/preview.js <${STAGE_NAMES.join('|')}> [stage...]`);
    }

    return stages;
}

/**
 * Runs the stages named on the command line.
 *
 * @returns {Promise<void>} Resolved once the process exit code is set.
 */
async function main() {
    let stages;

    try {
        stages = parseStages(process.argv.slice(2));
    } catch (error) {
        console.error(`${PREFIX} ${error.message}`);
        process.exitCode = 2;

        return;
    }

    process.exitCode = exitCodeFor(await runStages(stages));
}

if (require.main === module) {
    main();
}

module.exports = {
    MARKER,
    PREFIX,
    READY_LINE,
    STAGES,
    STAGE_NAMES,
    createTail,
    exitCodeFor,
    formatExit,
    formatFailure,
    parseStages,
    runStage,
    runStages,
    stoppedBeforeReady
};

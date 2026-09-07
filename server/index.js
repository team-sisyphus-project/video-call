/**
 * Production server for the built application.
 *
 * Serves one port, plain HTTP: the built bundles and assets, the two
 * configuration files generated from the environment, and the application shell
 * for every other path, because rooms are addressed by path (`/StandUp`).
 *
 * TLS, redirects and compression are the terminator's job, not this server's.
 *
 * Startup is the last stage of a preview run, and the stage whose failures are
 * the hardest to tell apart from the outside: a preview that never answers the
 * readiness probe looks the same whether the build produced nothing, the port
 * was taken, or the process is up and the probe is pointed elsewhere. So this
 * process names its own outcome on one line, in the vocabulary the preview
 * runner uses for stages:
 *
 *     [meetspace] STAGE=start STATUS=ready url=http://0.0.0.0:8080
 *     [meetspace] STAGE=start STATUS=failed REASON=build-output-missing
 *
 * That ready line is only written once this process has asked itself for `/`
 * and been answered 200. A bound socket is not a served application, and the
 * gap between the two is exactly where a readiness probe times out with nothing
 * in the log to explain it.
 *
 * The prefix is this process's own, not the runner's: `scripts/preview.js`
 * prints exactly one `[preview] STAGE=` line per run and these lines must not
 * be mistaken for it. They are the evidence the runner quotes, not the verdict.
 */

/* eslint-disable no-console */

const fs = require('fs');
const http = require('http');
const path = require('path');

const { buildConfigJs, buildInterfaceConfigJs } = require('./runtime-config');
const { renderShell } = require('./shell');
const { contentTypeFor, resolveAsset } = require('./static');

const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Port used when the environment does not assign one.
 */
const DEFAULT_PORT = 8080;

/**
 * Address to bind. Containers and preview harnesses reach the process from
 * outside their network namespace, so loopback is not enough.
 */
const DEFAULT_HOST = '0.0.0.0';

/**
 * Prefix every line this process writes about its own startup carries. It is
 * deliberately not `[preview]`: that prefix belongs to the preview runner's
 * verdict, of which there is exactly one per run.
 */
const LOG_PREFIX = '[meetspace]';

/**
 * The preview stage this process is. Startup is the whole of what this process
 * contributes to a preview run, so the value never varies.
 */
const STAGE = 'start';

/**
 * Why startup stopped, and what that means for whoever reads the log. The keys
 * are the `REASON=` tokens: one token per cause that calls for a different
 * repair, because a reason that does not change the next action is noise.
 */
const STARTUP_REASONS = {
    'build-output-missing': 'the build did not produce the files named above, so there is nothing to serve; '
        + 'this is a build stage failure surfacing at startup, not a server fault.',
    'internal': 'startup failed for a reason this server does not recognise; the line above is all of it.',
    'port-invalid': 'PORT must be an integer between 1 and 65535; no socket was ever opened.',
    'port-unavailable': 'the port could not be bound, so nothing is listening and a readiness probe '
        + 'against it can only time out.',
    'readiness-check-failed': 'the port is open but this server did not serve the application over it, '
        + 'so a probe that reaches this process still gets an error; the failure above is what the '
        + 'probe would see too.'
};

/**
 * Socket errors that mean the port itself is the problem: taken by another
 * process, not permitted, or not an address on this machine.
 */
const BIND_ERROR_CODES = [ 'EACCES', 'EADDRINUSE', 'EADDRNOTAVAIL' ];

/**
 * Every build output `make preview` deploys, checked as one set.
 *
 * The shell only loads a few of these directly, but a deploy is all-or-nothing:
 * `deploy-init` empties `libs/` and the copies follow one after another, so a
 * build or deploy that died halfway leaves some of this list on disk and the
 * rest absent. Checking only what the shell names would let such a run reach
 * `STATUS=ready` and hand the browser a chunk load error instead — a build
 * failure wearing a runtime failure's clothes.
 *
 * The six bundles are `deploy-appbundle-preview` in the Makefile, which is
 * `PREVIEW_ENTRIES` in `webpack.config.js`; `server.test.js` holds this list and
 * that target together.
 */
const REQUIRED_BUILD_OUTPUTS = [
    'css/all.css',
    'libs/app.bundle.min.js',
    'libs/chunks',
    'libs/external_api.min.js',
    'libs/face-landmarks-worker.min.js',
    'libs/lib-jitsi-meet.min.js',
    'libs/noise-suppressor-worklet.min.js',
    'libs/screenshot-capture-worker.min.js',
    'libs/vb-inference-worker.min.js'
];

/**
 * How long a browser may reuse an asset. Bundle URLs carry a version query and
 * chunks are content hashed, so this only bounds how stale an unversioned asset
 * can get.
 */
const ASSET_MAX_AGE = 3600;

/**
 * How long the readiness self-request may take before startup calls it failed.
 *
 * Bounded once rather than retried: a server that cannot answer its own first
 * request in this long is not slow, it is broken, and retrying only moves the
 * failure to the preview runner's preparation timeout, where it arrives without
 * a reason.
 */
const READINESS_TIMEOUT = 5000;

/**
 * Builds an error that already knows why startup cannot continue.
 *
 * The reason travels with the error rather than being re-derived from its
 * message at the point of reporting: message text is for people, and matching
 * on it is how classification quietly goes wrong.
 *
 * @param {string} reason - One of the `STARTUP_REASONS` keys.
 * @param {string} message - What went wrong, for a person.
 * @returns {Error} The error to throw.
 */
function startupError(reason, message) {
    const error = new Error(message);

    error.reason = reason;

    return error;
}

/**
 * Names the cause of a startup failure.
 *
 * @param {Error} error - What startup failed with.
 * @returns {string} One of the `STARTUP_REASONS` keys.
 */
function classifyStartupError(error) {
    if (error && Object.prototype.hasOwnProperty.call(STARTUP_REASONS, error.reason)) {
        return error.reason;
    }

    // Binding is asynchronous, so a taken or forbidden port arrives as a socket
    // error rather than as one of ours.
    if (error && BIND_ERROR_CODES.includes(error.code)) {
        return 'port-unavailable';
    }

    return 'internal';
}

/**
 * Renders the line printed once the server is listening.
 *
 * A readiness probe that times out against a process that printed this line is
 * a probe pointed at the wrong place; against a process that did not, it is a
 * startup that never happened. That distinction is the whole point of the line.
 *
 * @param {number} port - The port being listened on.
 * @returns {string} The line to log.
 */
function formatReady(port) {
    return `${LOG_PREFIX} STAGE=${STAGE} STATUS=ready url=http://${DEFAULT_HOST}:${port}`;
}

/**
 * Renders the report for a startup failure.
 *
 * Three lines, always in this order: the classification, the failure in the
 * server's own words, and what the classification means for the reader.
 *
 * @param {Error} error - What startup failed with.
 * @returns {string[]} The lines to log.
 */
function formatStartupFailure(error) {
    const reason = classifyStartupError(error);
    const message = (error && error.message) || String(error);

    return [
        `${LOG_PREFIX} STAGE=${STAGE} STATUS=failed REASON=${reason}`,
        `${LOG_PREFIX} ${message}`,
        `${LOG_PREFIX} ${STARTUP_REASONS[reason]}`
    ];
}

/**
 * Reports a startup failure and marks this process as failed.
 *
 * The exit code is set rather than the process being killed, so the report is
 * written out in full before the process leaves.
 *
 * @param {Error} error - What startup failed with.
 * @param {Function} [logError] - Where the report goes.
 * @returns {void}
 */
function failStartup(error, logError = console.error) {
    for (const line of formatStartupFailure(error)) {
        logError(line);
    }

    process.exitCode = 1;
}

/**
 * Reads the port from the environment.
 *
 * @param {Object} env - The environment to read from.
 * @returns {number} The port to listen on.
 */
function readPort(env) {
    const raw = env.PORT;

    if (raw === undefined || String(raw).trim() === '') {
        return DEFAULT_PORT;
    }

    const port = Number(raw);

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw startupError('port-invalid', `PORT is not a valid port number: ${JSON.stringify(raw)}`);
    }

    return port;
}

/**
 * Whether a build output is there in a form that can be served.
 *
 * Existence alone is too weak a test for the way these files arrive. `cp` and a
 * redirected compiler both create the destination before they fill it, so an
 * interrupted deploy leaves empty files and empty directories behind. An empty
 * `libs/chunks` is a copy that started and did not finish, and a zero byte
 * bundle is not a bundle; both are the build stage failing, and neither should
 * be able to pass for a build.
 *
 * @param {string} target - The absolute path of the build output.
 * @returns {boolean} True when the output is present and not empty.
 */
function isBuilt(target) {
    let stats;

    try {
        stats = fs.statSync(target);
    } catch (error) {
        // Anything that cannot be stat'd cannot be served, and the reason it
        // cannot be is the deploy's to explain, not this check's.
        return false;
    }

    if (stats.isDirectory()) {
        return fs.readdirSync(target).length > 0;
    }

    return stats.isFile() && stats.size > 0;
}

/**
 * Verifies that the application has been built.
 *
 * Every output is checked, not just the first one to fail: a preview log that
 * names one missing file at a time turns one broken build into as many restarts
 * as there are files.
 *
 * @param {string} root - The repository root.
 * @returns {string[]} The missing build outputs, empty when the build is there.
 */
function missingBuildOutputs(root) {
    return REQUIRED_BUILD_OUTPUTS.filter(file => !isBuilt(path.join(root, file)));
}

/**
 * Sends a response without a body payload of its own.
 *
 * @param {Object} res - The response.
 * @param {number} status - The status code.
 * @param {string} message - The plain text body.
 * @returns {void}
 */
function sendText(res, status, message) {
    const body = `${message}\n`;

    res.writeHead(status, {
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
        'content-type': 'text/plain; charset=utf-8',
        'x-content-type-options': 'nosniff'
    });
    res.end(body);
}

/**
 * Sends an in-memory body.
 *
 * @param {Object} req - The request.
 * @param {Object} res - The response.
 * @param {Object} options - The options.
 * @param {Buffer} options.body - The body to send.
 * @param {string} options.contentType - The content type of the body.
 * @param {string} options.cacheControl - The caching policy for the body.
 * @returns {void}
 */
function sendBuffer(req, res, { body, cacheControl, contentType }) {
    res.writeHead(200, {
        'cache-control': cacheControl,
        'content-length': body.length,
        'content-type': contentType,
        'x-content-type-options': 'nosniff'
    });
    res.end(req.method === 'HEAD' ? undefined : body);
}

/**
 * Streams a file from disk.
 *
 * @param {Object} req - The request.
 * @param {Object} res - The response.
 * @param {Object} options - The options.
 * @param {string} options.filePath - The absolute path of the file.
 * @param {Function} options.log - Where diagnostics go.
 * @param {Object} options.stats - The `fs.Stats` of the file.
 * @returns {void}
 */
function sendFile(req, res, { filePath, log, stats }) {
    const etag = `W/"${stats.size.toString(16)}-${stats.mtimeMs.toString(16)}"`;

    if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag });
        res.end();

        return;
    }

    res.writeHead(200, {
        'cache-control': `public, max-age=${ASSET_MAX_AGE}`,
        'content-length': stats.size,
        'content-type': contentTypeFor(filePath),
        etag,
        'last-modified': stats.mtime.toUTCString(),
        'x-content-type-options': 'nosniff'
    });

    if (req.method === 'HEAD') {
        res.end();

        return;
    }

    const stream = fs.createReadStream(filePath);

    stream.on('error', error => {
        log(`error streaming ${filePath}: ${error.message}`);
        res.destroy();
    });
    stream.pipe(res);
}

/**
 * Creates the request handler.
 *
 * The shell and both configuration files are rendered once here: they depend on
 * files and environment variables that do not change while the process runs.
 *
 * @param {Object} [options] - The options.
 * @param {string} [options.root] - The repository root to serve from.
 * @param {Object} [options.env] - The environment to read configuration from.
 * @param {Function} [options.log] - Where diagnostics go.
 * @returns {Function} A `http.createServer` request listener.
 */
function createRequestHandler({ env = process.env, log = console.log, root = REPO_ROOT } = {}) {
    const documentRoot = path.resolve(root);
    let shell = null;

    try {
        shell = Buffer.from(
            renderShell({
                onMissingInclude: virtualPath => log(`include not found, skipping: ${virtualPath}`),
                root: documentRoot
            }));
    } catch (error) {
        // A shell that cannot be rendered is a failure of what this server
        // serves, not of the server itself, so it is answered rather than
        // thrown: the readiness check then meets it as a probe would and names
        // it, instead of the process dying at construction with a stack trace.
        // The cause is written here because the response must not carry it.
        log(`${LOG_PREFIX} the application shell could not be rendered: ${error.message}`);
    }

    const generated = new Map([
        [ '/config.js', Buffer.from(buildConfigJs(env)) ],
        [ '/interface_config.js', Buffer.from(buildInterfaceConfigJs({ env,
            root: documentRoot })) ]
    ]);

    return (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.setHeader('allow', 'GET, HEAD');
            sendText(res, 405, 'Method not allowed');

            return;
        }

        const { pathname } = new URL(req.url, 'http://localhost');
        const generatedBody = generated.get(pathname);

        if (generatedBody) {
            sendBuffer(req, res, {
                body: generatedBody,
                cacheControl: 'no-store',
                contentType: 'text/javascript; charset=utf-8'
            });

            return;
        }

        const filePath = resolveAsset(pathname, documentRoot);

        if (filePath) {
            fs.stat(filePath, (error, stats) => {
                if (error || !stats.isFile()) {
                    sendText(res, 404, 'Not found');

                    return;
                }

                sendFile(req, res, { filePath,
                    log,
                    stats });
            });

            return;
        }

        if (!shell) {
            sendText(res, 500, 'Application shell unavailable');

            return;
        }

        // Any other path is a room name: the client router resolves it.
        sendBuffer(req, res, {
            body: shell,
            cacheControl: 'no-store',
            contentType: 'text/html; charset=utf-8'
        });
    };
}

/**
 * Asks this server for the application, the way a readiness probe will.
 *
 * `/` rather than a dedicated health path: a probe answered by an endpoint that
 * proves only that the process is alive is the exact failure this check exists
 * to catch. The request goes to the loopback address regardless of the bound
 * address, because it must not depend on the machine being reachable from
 * outside itself.
 *
 * @param {Object} options - The options.
 * @param {number} options.port - The port the server is listening on.
 * @param {number} [options.timeout] - How long to wait for the answer.
 * @returns {Promise<void>} Resolves when the server answered 200, rejects with
 * a `readiness-check-failed` error otherwise.
 */
function checkReadiness({ port, timeout = READINESS_TIMEOUT }) {
    const target = `GET http://127.0.0.1:${port}/`;

    return new Promise((resolve, reject) => {
        const request = http.get({
            // No connection pooling: a socket kept alive by the agent would
            // outlive this request and hold the process open past its verdict.
            agent: false,
            headers: { 'user-agent': `${LOG_PREFIX} readiness-check` },
            host: '127.0.0.1',
            path: '/',
            port
        }, response => {
            const status = response.statusCode;

            // Drained even when it is about to be discarded, so the socket ends
            // rather than being torn down under the server.
            response.resume();
            response.on('end', () => {
                if (status === 200) {
                    resolve();

                    return;
                }

                reject(startupError(
                    'readiness-check-failed',
                    `${target} answered ${status}, expected 200`));
            });
        });

        request.setTimeout(timeout, () => {
            request.destroy(startupError(
                'readiness-check-failed',
                `${target} did not answer within ${timeout}ms`));
        });

        request.on('error', error => reject(
            error.reason
                ? error
                : startupError('readiness-check-failed', `${target} failed: ${error.message}`)));
    });
}

/**
 * Starts the server.
 *
 * Everything that can be known before a socket is opened is checked first and
 * thrown; binding and serving fail later and asynchronously, so those failures
 * are handed to `onError` instead. Every path carries a reason.
 *
 * The ready line waits for the readiness check, so it means what a probe needs
 * it to mean: this process answered a request for the application.
 *
 * @param {Object} [options] - The options.
 * @param {string} [options.root] - The repository root to serve from.
 * @param {Object} [options.env] - The environment to read configuration from.
 * @param {Function} [options.log] - Where diagnostics go.
 * @param {Function} [options.onError] - Called with a failure that only shows
 * up once the server tries to bind or serve.
 * @param {number} [options.readinessTimeout] - How long the readiness check may
 * take.
 * @returns {Object} The listening `http.Server`.
 */
function start({
    env = process.env,
    log = console.log,
    onError = failStartup,
    readinessTimeout = READINESS_TIMEOUT,
    root = REPO_ROOT
} = {}) {
    const documentRoot = path.resolve(root);
    const missing = missingBuildOutputs(documentRoot);

    if (missing.length) {
        throw startupError(
            'build-output-missing',
            `missing ${missing.length} of ${REQUIRED_BUILD_OUTPUTS.length} build outputs: `
            + `${missing.join(', ')}. `
            + 'Run "npm run build:preview" (or "npm run build") first.');
    }

    const port = readPort(env);
    const server = http.createServer(createRequestHandler({ env,
        log,
        root: documentRoot }));

    server.on('error', error => {
        // A server that never bound holds nothing open; closing it is what makes
        // the process able to leave with the exit code the report just set.
        server.close(() => { /* already closed by the failed bind */ });
        onError(error);
    });

    server.listen(port, DEFAULT_HOST, () => {
        checkReadiness({ port: server.address().port,
            timeout: readinessTimeout })
            .then(() => log(formatReady(port)))
            .catch(error => {
                // Nothing is served, so nothing is worth keeping open; the
                // sockets go with it, or the process would outlive its own
                // verdict and the preview would wait out its timeout anyway.
                server.closeAllConnections();
                server.close(() => { /* reported below, whatever it took */ });
                onError(error);
            });
    });

    for (const signal of [ 'SIGINT', 'SIGTERM' ]) {
        process.once(signal, () => {
            log(`${LOG_PREFIX} ${signal} received, shutting down`);
            server.close(() => process.exit(0));
        });
    }

    return server;
}

if (require.main === module) {
    try {
        start();
    } catch (error) {
        failStartup(error);
    }
}

module.exports = {
    DEFAULT_PORT,
    READINESS_TIMEOUT,
    REQUIRED_BUILD_OUTPUTS,
    STARTUP_REASONS,
    checkReadiness,
    classifyStartupError,
    createRequestHandler,
    failStartup,
    formatReady,
    formatStartupFailure,
    missingBuildOutputs,
    readPort,
    start
};

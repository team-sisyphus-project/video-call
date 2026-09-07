/**
 * Production server for the built application.
 *
 * Serves one port, plain HTTP: the built bundles and assets, the two
 * configuration files generated from the environment, and the application shell
 * for every other path, because rooms are addressed by path (`/StandUp`).
 *
 * TLS, redirects and compression are the terminator's job, not this server's.
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
 * Build outputs the shell cannot render without. Their absence is a broken
 * deployment, not a runtime condition to paper over.
 */
const REQUIRED_BUILD_OUTPUTS = [
    'css/all.css',
    'libs/app.bundle.min.js',
    'libs/lib-jitsi-meet.min.js'
];

/**
 * How long a browser may reuse an asset. Bundle URLs carry a version query and
 * chunks are content hashed, so this only bounds how stale an unversioned asset
 * can get.
 */
const ASSET_MAX_AGE = 3600;

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
        throw new Error(`PORT is not a valid port number: ${JSON.stringify(raw)}`);
    }

    return port;
}

/**
 * Verifies that the application has been built.
 *
 * @param {string} root - The repository root.
 * @returns {string[]} The missing build outputs, empty when the build is there.
 */
function missingBuildOutputs(root) {
    return REQUIRED_BUILD_OUTPUTS.filter(file => !fs.existsSync(path.join(root, file)));
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
    const shell = Buffer.from(
        renderShell({
            onMissingInclude: virtualPath => log(`include not found, skipping: ${virtualPath}`),
            root: documentRoot
        }));
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

        // Any other path is a room name: the client router resolves it.
        sendBuffer(req, res, {
            body: shell,
            cacheControl: 'no-store',
            contentType: 'text/html; charset=utf-8'
        });
    };
}

/**
 * Starts the server.
 *
 * @param {Object} [options] - The options.
 * @param {string} [options.root] - The repository root to serve from.
 * @param {Object} [options.env] - The environment to read configuration from.
 * @param {Function} [options.log] - Where diagnostics go.
 * @returns {Object} The listening `http.Server`.
 */
function start({ env = process.env, log = console.log, root = REPO_ROOT } = {}) {
    const documentRoot = path.resolve(root);
    const missing = missingBuildOutputs(documentRoot);

    if (missing.length) {
        throw new Error(
            `The application is not built, missing: ${missing.join(', ')}. `
            + 'Run "npm run build" first.');
    }

    const port = readPort(env);
    const server = http.createServer(createRequestHandler({ env,
        log,
        root: documentRoot }));

    server.listen(port, DEFAULT_HOST, () => {
        log(`meetspace listening on http://${DEFAULT_HOST}:${port}`);
    });

    for (const signal of [ 'SIGINT', 'SIGTERM' ]) {
        process.once(signal, () => {
            log(`${signal} received, shutting down`);
            server.close(() => process.exit(0));
        });
    }

    return server;
}

if (require.main === module) {
    try {
        start();
    } catch (error) {
        console.error(`[meetspace] ${error.message}`);
        process.exit(1);
    }
}

module.exports = {
    DEFAULT_PORT,
    createRequestHandler,
    missingBuildOutputs,
    readPort,
    start
};

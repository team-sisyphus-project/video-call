/**
 * Tests for the production server.
 *
 * Run with `npm run test:server`.
 */

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const { after, before, describe, it } = require('node:test');
const os = require('os');
const path = require('path');

const { buildConfigJs, buildInterfaceConfigJs, readBackend } = require('./runtime-config');
const { renderShell } = require('./shell');
const { contentTypeFor, resolveAsset } = require('./static');

const {
    STARTUP_REASONS,
    classifyStartupError,
    createRequestHandler,
    formatReady,
    formatStartupFailure,
    missingBuildOutputs,
    readPort
} = require('./index');

/**
 * Writes a file and the directories leading to it.
 *
 * @param {string} file - The absolute path of the file.
 * @param {string} contents - What to write.
 * @returns {void}
 */
function write(file, contents) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
}

/**
 * Creates a throwaway document root that mirrors the parts of the repository
 * the server reads.
 *
 * @returns {string} The absolute path of the document root.
 */
function createFixtureRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meetspace-server-'));

    write(path.join(root, 'index.html'), [
        '<html><head>',
        '<!--#include virtual="base.html" -->',
        '<!--#include virtual="missing.html" -->',
        '<script><!--#include virtual="/config.js" --></script>',
        '<script><!--#include virtual="/interface_config.js" --></script>',
        '<script src="libs/app.bundle.min.js?v=139"></script>',
        '</head><body><div id="react"></div></body></html>'
    ].join('\n'));
    write(path.join(root, 'base.html'), '<base href="/" />');
    write(path.join(root, 'interface_config.js'), 'var interfaceConfig = {\n    APP_NAME: \'Jitsi Meet\'\n};\n');
    write(path.join(root, 'css/all.css'), 'body{margin:0}');
    write(path.join(root, 'libs/app.bundle.min.js'), 'void 0;');
    write(path.join(root, 'libs/lib-jitsi-meet.min.js'), 'void 0;');
    write(path.join(root, 'secret.txt'), 'do not serve me');

    return root;
}

/**
 * Creates a document root the server can actually be spawned against: the
 * fixture of `createFixtureRoot`, with this server's own sources copied in so
 * that the repository root the process resolves is the fixture.
 *
 * @returns {string} The absolute path of the document root.
 */
function createRunnableRoot() {
    const root = createFixtureRoot();

    fs.cpSync(__dirname, path.join(root, 'server'), {
        filter: source => !source.endsWith('.test.js'),
        recursive: true
    });

    return root;
}

/**
 * Finds a port nothing is listening on.
 *
 * @returns {Promise<number>} The port.
 */
function freePort() {
    return new Promise(resolve => {
        const probe = http.createServer();

        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();

            probe.close(() => resolve(port));
        });
    });
}

/**
 * Runs the server as the preview platform runs it — as its own process — and
 * collects what it said and how it left.
 *
 * @param {Object} options - The options.
 * @param {string} options.root - The document root to spawn against.
 * @param {Object} [options.env] - Environment overrides for the process.
 * @param {RegExp} [options.until] - When given, the run is stopped as soon as
 * the output matches, instead of being waited out.
 * @returns {Promise<Object>} The exit code, signal and combined output.
 */
function runServer({ env = {}, root, until = null }) {
    return new Promise(resolve => {
        const child = spawn(process.execPath, [ path.join(root, 'server', 'index.js') ], {
            env: { ...process.env,
                ...env },
            stdio: [ 'ignore', 'pipe', 'pipe' ]
        });
        let output = '';
        let stopped = false;

        /**
         * Keeps a chunk of the run's output, and ends the run once the caller
         * has seen what it was waiting for.
         *
         * @param {string} chunk - What the run wrote.
         * @returns {void}
         */
        const record = chunk => {
            output += chunk;

            if (until && !stopped && until.test(output)) {
                stopped = true;
                child.kill('SIGTERM');
            }
        };

        for (const stream of [ child.stdout, child.stderr ]) {
            stream.setEncoding('utf8');
            stream.on('data', record);
        }

        child.on('close', (code, signal) => resolve({ code,
            output,
            signal }));
    });
}

/**
 * The classification lines of a run, in order.
 *
 * @param {string} output - What the run wrote.
 * @returns {string[]} The lines carrying a `STAGE=` marker.
 */
function stageLines(output) {
    return output.split('\n').filter(line => line.includes('STAGE='));
}

describe('readPort', () => {
    it('defaults when PORT is absent or empty', () => {
        assert.strictEqual(readPort({}), 8080);
        assert.strictEqual(readPort({ PORT: '' }), 8080);
    });

    it('reads the port from the environment', () => {
        assert.strictEqual(readPort({ PORT: '5400' }), 5400);
    });

    it('rejects values that are not ports', () => {
        for (const PORT of [ '0', '-1', '70000', 'http', '80.5' ]) {
            assert.throws(() => readPort({ PORT }), /not a valid port/);
        }
    });
});

describe('readBackend', () => {
    it('defaults when the environment names no backend', () => {
        assert.strictEqual(readBackend({}), 'alpha.jitsi.net');
        assert.strictEqual(readBackend({ MEETSPACE_BACKEND: '' }), 'alpha.jitsi.net');
    });

    it('accepts a bare host and a URL', () => {
        assert.strictEqual(readBackend({ MEETSPACE_BACKEND: 'meet.example.com' }), 'meet.example.com');
        assert.strictEqual(readBackend({ MEETSPACE_BACKEND: 'localhost:5280' }), 'localhost:5280');
        assert.strictEqual(
            readBackend({ MEETSPACE_BACKEND: 'https://meet.example.com/some/path' }),
            'meet.example.com');
    });

    it('rejects a host that could break out of the generated source', () => {
        for (const MEETSPACE_BACKEND of [ 'a.com\'; alert(1); var x=\'', 'a b.com', '../etc', 'meet..com' ]) {
            assert.throws(() => readBackend({ MEETSPACE_BACKEND }), /not a valid host/);
        }
    });
});

describe('buildConfigJs', () => {
    it('points the client at the configured backend', () => {
        const source = buildConfigJs({ MEETSPACE_BACKEND: 'meet.example.com' });

        assert.match(source, /^\/\*.*\*\/\nvar config = \{/s);
        assert.ok(source.includes('"domain": "meet.example.com"'));
        assert.ok(source.includes('"muc": "conference.meet.example.com"'));
        assert.ok(source.includes('"bosh": "https://meet.example.com/http-bind"'));
        assert.ok(source.includes('"websocket": "wss://meet.example.com/xmpp-websocket"'));
    });

    it('enables the welcome page, which is the first screen', () => {
        assert.ok(buildConfigJs({}).includes('"enableWelcomePage": true'));
    });

    it('evaluates to a config object', () => {
        // eslint-disable-next-line no-new-func
        const config = new Function(`${buildConfigJs({})}\nreturn config;`)();

        assert.strictEqual(config.hosts.domain, 'alpha.jitsi.net');
    });
});

describe('buildInterfaceConfigJs', () => {
    let root;

    before(() => {
        root = createFixtureRoot();
    });
    after(() => fs.rmSync(root, { recursive: true,
        force: true }));

    it('serves the checked in file unchanged by default', () => {
        assert.strictEqual(
            buildInterfaceConfigJs({ env: {},
                root }),
            fs.readFileSync(path.join(root, 'interface_config.js'), 'utf8'));
    });

    it('applies the application name from the environment', () => {
        const source = buildInterfaceConfigJs({ env: { MEETSPACE_APP_NAME: 'MeetSpace' },
            root });

        assert.ok(source.includes('interfaceConfig.APP_NAME = "MeetSpace";'));
    });
});

describe('renderShell', () => {
    let root;

    before(() => {
        root = createFixtureRoot();
    });
    after(() => fs.rmSync(root, { recursive: true,
        force: true }));

    it('resolves every include directive', () => {
        const html = renderShell({ root });

        assert.ok(!html.includes('#include'));
        assert.ok(html.includes('<base href="/" />'));
    });

    it('turns the configuration includes into requests this server answers', () => {
        const html = renderShell({ root });

        assert.ok(html.includes('<script src="config.js"></script>'));
        assert.ok(html.includes('<script src="interface_config.js"></script>'));
    });

    it('reports includes that do not exist instead of failing', () => {
        const missing = [];

        renderShell({ onMissingInclude: virtualPath => missing.push(virtualPath),
            root });

        assert.deepStrictEqual(missing, [ 'missing.html' ]);
    });
});

describe('resolveAsset', () => {
    const root = path.resolve('/srv/app');

    it('resolves paths inside the served directories', () => {
        assert.strictEqual(resolveAsset('/css/all.css', root), path.join(root, 'css/all.css'));
        assert.strictEqual(
            resolveAsset('/libs/chunks/1.min.js', root),
            path.join(root, 'libs/chunks/1.min.js'));
        assert.strictEqual(resolveAsset('/manifest.json', root), path.join(root, 'manifest.json'));
        assert.strictEqual(resolveAsset('/olm.wasm', root), path.join(root, 'olm.wasm'));
    });

    it('treats anything else as a room name', () => {
        for (const pathname of [ '/', '/StandUp', '/moderated/room', '/package.json', '/conference.js' ]) {
            assert.strictEqual(resolveAsset(pathname, root), null, pathname);
        }
    });

    it('refuses to escape the document root', () => {
        for (const pathname of [
            '/../package.json',
            '/css/../../package.json',
            '/css/%2e%2e/%2e%2e/package.json',
            '/libs/..%2f..%2fpackage.json',
            '/libs/%00.wasm'
        ]) {
            const resolved = resolveAsset(pathname, root);

            assert.ok(
                resolved === null || resolved.startsWith(root + path.sep),
                `${pathname} resolved to ${resolved}`);
        }
    });
});

describe('contentTypeFor', () => {
    it('maps the types the application loads', () => {
        assert.strictEqual(contentTypeFor('/libs/olm.wasm'), 'application/wasm');
        assert.strictEqual(contentTypeFor('/css/all.css'), 'text/css; charset=utf-8');
        assert.strictEqual(contentTypeFor('/libs/app.bundle.min.js'), 'text/javascript; charset=utf-8');
        assert.strictEqual(contentTypeFor('/lang/main.json'), 'application/json; charset=utf-8');
    });

    it('does not guess at unknown types', () => {
        assert.strictEqual(contentTypeFor('/what.xyz'), 'application/octet-stream');
    });
});

describe('missingBuildOutputs', () => {
    let root;

    before(() => {
        root = createFixtureRoot();
    });
    after(() => fs.rmSync(root, { recursive: true,
        force: true }));

    it('is empty for a built checkout', () => {
        assert.deepStrictEqual(missingBuildOutputs(root), []);
    });

    it('names what is missing', () => {
        fs.rmSync(path.join(root, 'libs/app.bundle.min.js'));

        assert.deepStrictEqual(missingBuildOutputs(root), [ 'libs/app.bundle.min.js' ]);
    });
});

describe('the served application', () => {
    let root;
    let server;
    let origin;

    before(async () => {
        root = createFixtureRoot();
        server = http.createServer(createRequestHandler({ env: { MEETSPACE_BACKEND: 'meet.example.com' },
            log: () => { /* quiet */ },
            root }));
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        origin = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(root, { recursive: true,
            force: true });
    });

    /**
     * Requests a path from the test server.
     *
     * @param {string} pathname - The path to request.
     * @param {Object} [init] - `fetch` options.
     * @returns {Promise<Object>} The response.
     */
    const get = (pathname, init) => fetch(`${origin}${pathname}`, init);

    it('serves the first screen with 200 and no redirect', async () => {
        const response = await get('/', { redirect: 'manual' });

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers.get('content-type'), 'text/html; charset=utf-8');
        assert.ok((await response.text()).includes('<div id="react">'));
    });

    it('serves the shell for a room path', async () => {
        const response = await get('/StandUp');

        assert.strictEqual(response.status, 200);
        assert.ok((await response.text()).includes('<div id="react">'));
    });

    it('serves the generated configuration', async () => {
        const response = await get('/config.js');

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers.get('content-type'), 'text/javascript; charset=utf-8');
        assert.ok((await response.text()).includes('"domain": "meet.example.com"'));
    });

    it('serves the generated interface configuration', async () => {
        const response = await get('/interface_config.js');

        assert.strictEqual(response.status, 200);
        assert.ok((await response.text()).includes('interfaceConfig'));
    });

    it('serves assets with their content type', async () => {
        const response = await get('/css/all.css');

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers.get('content-type'), 'text/css; charset=utf-8');
        assert.strictEqual(await response.text(), 'body{margin:0}');
    });

    it('answers a missing asset with 404, not with the shell', async () => {
        const response = await get('/libs/nope.min.js');

        assert.strictEqual(response.status, 404);
    });

    it('does not serve files outside the served directories', async () => {
        const response = await get('/css/../secret.txt');

        assert.notStrictEqual(await response.text(), 'do not serve me');
    });

    it('answers HEAD without a body', async () => {
        const response = await get('/css/all.css', { method: 'HEAD' });

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers.get('content-length'), '14');
        assert.strictEqual(await response.text(), '');
    });

    it('rejects methods that change state', async () => {
        const response = await get('/', { method: 'POST' });

        assert.strictEqual(response.status, 405);
        assert.strictEqual(response.headers.get('allow'), 'GET, HEAD');
    });
});

describe('classifyStartupError', () => {
    it('reads the reason the failure carries', () => {
        for (const reason of Object.keys(STARTUP_REASONS)) {
            assert.strictEqual(classifyStartupError(Object.assign(new Error('x'), { reason })), reason);
        }
    });

    it('classifies a bind failure by its socket error code', () => {
        for (const code of [ 'EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL' ]) {
            assert.strictEqual(
                classifyStartupError(Object.assign(new Error('listen'), { code })),
                'port-unavailable');
        }
    });

    it('does not invent a reason for a failure it does not know', () => {
        assert.strictEqual(classifyStartupError(new Error('boom')), 'internal');
        assert.strictEqual(
            classifyStartupError(Object.assign(new Error('boom'), { reason: 'made-up' })),
            'internal');
    });
});

describe('formatStartupFailure', () => {
    it('names the stage, the reason and the failure itself', () => {
        const lines = formatStartupFailure(
            Object.assign(new Error('PORT is not a valid port number: "nope"'),
                { reason: 'port-invalid' }));

        assert.strictEqual(lines[0], '[meetspace] STAGE=start STATUS=failed REASON=port-invalid');
        assert.ok(lines[1].includes('PORT is not a valid port number'));
        assert.strictEqual(lines.length, 3);
    });

    it('gives every reason a marker of its own', () => {
        const markers = Object.keys(STARTUP_REASONS).map(
            reason => formatStartupFailure(Object.assign(new Error('x'), { reason }))[0]);

        assert.strictEqual(new Set(markers).size, Object.keys(STARTUP_REASONS).length);
    });

    it('does not print what the preview runner claims as its own verdict', () => {
        const lines = [
            ...formatStartupFailure(Object.assign(new Error('x'), { reason: 'internal' })),
            formatReady(8080)
        ];

        assert.ok(lines.every(line => !line.includes('[preview] STAGE=')), lines.join('\n'));
    });
});

describe('the server as its own process', () => {
    let root;

    before(() => {
        root = createRunnableRoot();
    });
    after(() => fs.rmSync(root, { recursive: true,
        force: true }));

    it('says it is ready, once, with the port it is listening on', async () => {
        const port = await freePort();
        const { output } = await runServer({ env: { PORT: String(port) },
            root,
            until: /STATUS=ready/ });

        assert.deepStrictEqual(
            stageLines(output),
            [ `[meetspace] STAGE=start STATUS=ready url=http://0.0.0.0:${port}` ]);
    });

    it('classifies a missing build output and exits non-zero', async () => {
        const missingRoot = createRunnableRoot();

        fs.rmSync(path.join(missingRoot, 'libs/app.bundle.min.js'));

        const { code, output } = await runServer({ root: missingRoot });

        fs.rmSync(missingRoot, { recursive: true,
            force: true });

        assert.notStrictEqual(code, 0);
        assert.deepStrictEqual(
            stageLines(output),
            [ '[meetspace] STAGE=start STATUS=failed REASON=build-output-missing' ]);
        assert.ok(output.includes('libs/app.bundle.min.js'), output);
    });

    it('classifies an unusable PORT and exits non-zero', async () => {
        const { code, output } = await runServer({ env: { PORT: 'eighty-eighty' },
            root });

        assert.notStrictEqual(code, 0);
        assert.deepStrictEqual(
            stageLines(output),
            [ '[meetspace] STAGE=start STATUS=failed REASON=port-invalid' ]);
        assert.ok(output.includes('eighty-eighty'), output);
    });

    it('classifies a port it cannot bind and exits non-zero', async () => {
        const occupant = http.createServer();

        await new Promise(resolve => occupant.listen(0, '0.0.0.0', resolve));

        const { port } = occupant.address();
        const { code, output } = await runServer({ env: { PORT: String(port) },
            root });

        await new Promise(resolve => occupant.close(resolve));

        assert.notStrictEqual(code, 0);
        assert.deepStrictEqual(
            stageLines(output),
            [ '[meetspace] STAGE=start STATUS=failed REASON=port-unavailable' ]);
    });
});

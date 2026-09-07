/**
 * Tests for the production server.
 *
 * Run with `npm run test:server`.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const { after, before, describe, it } = require('node:test');
const os = require('os');
const path = require('path');

const { buildConfigJs, buildInterfaceConfigJs, readBackend } = require('./runtime-config');
const { renderShell } = require('./shell');
const { contentTypeFor, resolveAsset } = require('./static');

const { createRequestHandler, missingBuildOutputs, readPort } = require('./index');

const REPO_ROOT = path.join(__dirname, '..');

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

/**
 * Evaluates a checked in `interface_config.js` and hands back the object it
 * declares, so the assertions read the values the browser would.
 *
 * @param {string} file - Repository relative path of the file.
 * @returns {Object} The declared `interfaceConfig`.
 */
function readInterfaceConfig(file) {
    const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

    // eslint-disable-next-line no-new-func
    return new Function(`${source}\nreturn interfaceConfig;`)();
}

describe('the checked in branding', () => {
    const title = fs.readFileSync(path.join(REPO_ROOT, 'title.html'), 'utf8');

    for (const file of [ 'interface_config.js', 'demo/interface_config.js' ]) {
        describe(file, () => {
            const interfaceConfig = readInterfaceConfig(file);

            it('names the product MeetSpace', () => {
                assert.strictEqual(interfaceConfig.APP_NAME, 'MeetSpace');
                assert.strictEqual(interfaceConfig.PROVIDER_NAME, 'MeetSpace');
            });

            it('points the welcome page logo at the MeetSpace watermark', () => {
                assert.strictEqual(
                    interfaceConfig.DEFAULT_WELCOME_PAGE_LOGO_URL,
                    'images/meetspace-watermark.svg');
                assert.ok(fs.existsSync(path.join(REPO_ROOT, 'images/meetspace-watermark.svg')));
            });

            it('keeps the header watermark switched on', () => {
                // The flag gates the header mark itself, not whose mark it is:
                // turning it off would leave the header with no logo at all.
                assert.strictEqual(interfaceConfig.SHOW_JITSI_WATERMARK, true);
            });

            it('links the watermark to this deployment, not to upstream', () => {
                assert.strictEqual(interfaceConfig.JITSI_WATERMARK_LINK, '/');
            });

            it('carries no upstream product name', () => {
                const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

                assert.ok(!source.includes('\'Jitsi Meet\''), 'Jitsi Meet is still a value');
                assert.ok(!source.includes('images/watermark.svg'), 'the upstream watermark is still referenced');
            });
        });
    }

    it('titles the browser tab MeetSpace', () => {
        assert.ok(title.includes('<title>MeetSpace</title>'));
        assert.ok(title.includes('<meta property="og:title" content="MeetSpace"/>'));
        assert.ok(title.includes('<meta itemprop="name" content="MeetSpace"/>'));
    });

    it('describes the product in its own words', () => {
        const description = 'Video meetings in the browser. No installs.';

        assert.strictEqual(title.split(description).length - 1, 3);
        assert.ok(!title.includes('Jitsi'));
    });

    it('shares the MeetSpace card and favicon, and both exist', () => {
        for (const [ tag, asset ] of [
            [ '<meta property="og:image" content="images/meetspace-logo.png?v=1"/>', 'images/meetspace-logo.png' ],
            [ '<meta itemprop="image" content="images/meetspace-logo.png?v=1"/>', 'images/meetspace-logo.png' ],
            [ '<link rel="icon" href="images/meetspace-favicon.svg?v=1">', 'images/meetspace-favicon.svg' ]
        ]) {
            assert.ok(title.includes(tag), tag);
            assert.ok(fs.existsSync(path.join(REPO_ROOT, asset)), asset);
        }
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

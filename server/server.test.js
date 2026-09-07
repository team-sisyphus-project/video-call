/**
 * Tests for the production server, and for the demo configuration template it
 * is mirrored by.
 *
 * Run with `npm run test:server`.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const { after, before, describe, it } = require('node:test');
const os = require('os');
const path = require('path');

const { buildConfigJs, buildInterfaceConfigJs, readBackend, readServices } = require('./runtime-config');
const { renderShell } = require('./shell');
const { contentTypeFor, resolveAsset } = require('./static');

const { createRequestHandler, missingBuildOutputs, readPort } = require('./index');

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
 * Evaluates the generated `config.js` the way the browser does.
 *
 * @param {Object} [env] - The environment to generate for.
 * @returns {Object} The `config` object the client would read.
 */
function evaluateConfig(env = {}) {
    // eslint-disable-next-line no-new-func
    return new Function(`${buildConfigJs(env)}\nreturn config;`)();
}

/**
 * Evaluates the demo `config.js` template the way the browser does.
 *
 * The template is read as it is checked in, placeholder and all: `demo/build-index.js`
 * only substitutes the backend host, which is a string and cannot change the
 * shape of the object.
 *
 * @returns {Object} The `config` object a demo visitor would read.
 */
function evaluateDemoConfig() {
    const source = fs.readFileSync(path.join(__dirname, '../demo/config.js'), 'utf8');

    // eslint-disable-next-line no-new-func
    return new Function(`${source}\nreturn config;`)();
}

/**
 * Reads the toolbar button keys from the client's own constants.
 *
 * An unknown key in `toolbarButtons` does not fail anywhere: the client simply
 * never matches it, and the button quietly stays missing. Reading the keys the
 * client actually declares turns that into a test failure.
 *
 * @returns {Array<string>} Every button key the client understands.
 */
function readKnownToolbarButtons() {
    const source = fs.readFileSync(
        path.join(__dirname, '../react/features/toolbox/constants.ts'), 'utf8');
    const declaration = (/export const TOOLBAR_BUTTONS: ToolbarButton\[\] = \[([^\]]*)\]/).exec(source);

    assert.ok(declaration, 'TOOLBAR_BUTTONS was not found in the client constants');

    return declaration[1].match(/'[^']+'/g).map(quoted => quoted.slice(1, -1));
}

/**
 * Reads the client's main bar thresholds from its own constants.
 *
 * The client sizes the bar, not the configuration: it keeps a table of window
 * widths, each entry holding a fixed number of slots, and the widest entry the
 * window clears is the one that lays the bar out. `mainToolbarButtons` only
 * replaces the *order* of an entry, and a row is matched to an entry by its
 * length, so the width a row addresses is a fact about the client rather than
 * about the row. Reading the table here is what makes a width in a test mean
 * the same thing it means in a browser.
 *
 * The two widest entries are placeholders that carry no order of their own; the
 * client drops them unless a configuration hands them one.
 *
 * @returns {Array<Object>} Per entry: `width`, the window width it addresses,
 * `slots`, how many buttons its bar holds, and `order`, the client's own order
 * for it, or null when it is a placeholder.
 */
function readMainToolbarThresholds() {
    const source = fs.readFileSync(
        path.join(__dirname, '../react/features/toolbox/constants.ts'), 'utf8');
    const declaration = (/export const THRESHOLDS = \[([\s\S]*?)\n\];/).exec(source);

    assert.ok(declaration, 'THRESHOLDS was not found in the client constants');

    const entries = [ ...declaration[1].matchAll(
        /width:\s*(\d+),\s*order:\s*(?:\[([^\]]*)\]|DUMMY_(\d+)_BUTTONS_THRESHOLD_VALUE)/g) ]
        .map(([ , width, order, placeholderSlots ]) => {
            const keys = order ? order.match(/'[^']+'/g).map(quoted => quoted.slice(1, -1)) : null;

            return {
                order: keys,
                slots: keys ? keys.length : Number(placeholderSlots),
                width: Number(width)
            };
        });

    assert.ok(entries.length > 0, 'no thresholds were read from the client constants');

    return entries;
}

/**
 * The main bar the client lays out at a window width, for a configuration.
 *
 * Mirrors what the client does with `mainToolbarButtons`: a row replaces the
 * order of the threshold entry that has as many slots as the row has buttons, a
 * placeholder no row matches is dropped, and the bar is the first entry the
 * window is wider than.
 *
 * @param {Object} config - The `config` object the client would read.
 * @param {number} clientWidth - The window width to lay the bar out for.
 * @returns {Array<string>} The buttons the bar holds, in the order it holds
 * them.
 */
function barAt(config, clientWidth) {
    const rows = new Map(config.mainToolbarButtons.map(row => [ row.length, row ]));
    const table = readMainToolbarThresholds()
        .map(({ order, slots, width }) => {
            return {
                order: rows.get(slots) || order,
                width
            };
        })
        .filter(entry => entry.order);

    return (table.find(({ width }) => clientWidth > width) || table[table.length - 1]).order;
}

/**
 * The enabled buttons the bar leaves to the "More" menu at a window width.
 *
 * `hangup` is not among them: the client renders leaving beside the bar, so it
 * is in neither the bar nor the menu.
 *
 * @param {Object} config - The `config` object the client would read.
 * @param {number} clientWidth - The window width to lay the bar out for.
 * @returns {Array<string>} The buttons that end up under "More".
 */
function overflowAt(config, clientWidth) {
    const bar = barAt(config, clientWidth);

    return config.toolbarButtons.filter(button => !bar.includes(button) && button !== 'hangup');
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
        assert.strictEqual(evaluateConfig().hosts.domain, 'alpha.jitsi.net');
    });
});

describe('the toolbar the configuration serves', () => {
    const PRIMARY_BUTTONS = [
        'microphone',
        'camera',
        'desktop',
        'chat',
        'participants-pane',
        'raisehand'
    ];

    it('enables the primaries and the leave button', () => {
        const { toolbarButtons } = evaluateConfig();

        for (const button of [ ...PRIMARY_BUTTONS, 'hangup' ]) {
            assert.ok(toolbarButtons.includes(button), `${button} is not enabled`);
        }
    });

    it('keeps the secondary actions available, for the "More" menu to hold', () => {
        const { toolbarButtons } = evaluateConfig();

        for (const button of [
            'tileview',
            'fullscreen',
            'select-background',
            'videoquality',
            'security',
            'closedcaptions',
            'noisesuppression',
            'sharedvideo',
            'shareaudio',
            'whiteboard',
            'stats',
            'settings',
            'shortcuts',
            'profile',
            'help'
        ]) {
            assert.ok(toolbarButtons.includes(button), `${button} is not reachable`);
        }
    });

    it('drops the actions this deployment has no backend for', () => {
        const { toolbarButtons } = evaluateConfig();

        for (const button of [ 'recording', 'livestreaming', 'highlight', 'invite', 'linktosalesforce' ]) {
            assert.ok(!toolbarButtons.includes(button), `${button} is offered without a backend`);
        }
    });

    it('is an allowlist, so every button it names is a button the client knows', () => {
        const { toolbarButtons } = evaluateConfig();
        const known = readKnownToolbarButtons();

        for (const button of toolbarButtons) {
            assert.ok(known.includes(button), `${button} is not a toolbar button`);
        }

        assert.strictEqual(new Set(toolbarButtons).size, toolbarButtons.length, 'a button is listed twice');
    });

    it('fills the widest bar row with the primaries, then the two viewing controls', () => {
        const { mainToolbarButtons } = evaluateConfig();

        assert.deepStrictEqual(mainToolbarButtons[0], [ ...PRIMARY_BUTTONS, 'tileview', 'fullscreen' ]);
    });

    it('leads every row with primaries, so a narrower window drops secondaries first', () => {
        for (const row of evaluateConfig().mainToolbarButtons) {
            const lead = row.slice(0, Math.min(row.length, PRIMARY_BUTTONS.length));

            assert.deepStrictEqual(
                lead.filter(button => !PRIMARY_BUTTONS.includes(button)),
                [],
                `${row.join(', ')} does not lead with the primaries`);
        }
    });

    it('addresses one main bar row per width the client offers, from 8 down to 2', () => {
        const { mainToolbarButtons } = evaluateConfig();

        assert.deepStrictEqual(mainToolbarButtons.map(row => row.length), [ 8, 7, 6, 5, 4, 3, 2 ]);
    });

    it('never widens the bar past the eight slots the primaries were sized for', () => {
        const { mainToolbarButtons } = evaluateConfig();

        // The client keeps 9 and 10 slot rows that only exist once configured.
        // Overriding them would grow the bar instead of focusing it.
        assert.ok(mainToolbarButtons.every(row => row.length <= 8));
    });

    it('puts nothing in the bar that is not enabled', () => {
        const { mainToolbarButtons, toolbarButtons } = evaluateConfig();

        for (const row of mainToolbarButtons) {
            for (const button of row) {
                assert.ok(toolbarButtons.includes(button), `${button} is in the bar but not enabled`);
            }
        }
    });

    it('leaves every enabled button that is not in the widest row to the "More" menu', () => {
        const { mainToolbarButtons, toolbarButtons } = evaluateConfig();
        const [ widestRow ] = mainToolbarButtons;

        // 'hangup' is rendered next to the bar rather than in it.
        const overflow = toolbarButtons.filter(
            button => !widestRow.includes(button) && button !== 'hangup');

        assert.deepStrictEqual(overflow, [
            'select-background',
            'videoquality',
            'security',
            'closedcaptions',
            'noisesuppression',
            'sharedvideo',
            'shareaudio',
            'whiteboard',
            'stats',
            'settings',
            'shortcuts',
            'profile',
            'help'
        ]);
    });
});

describe('the bar a desktop and a mobile window lay out', () => {
    const CORE_BUTTONS = [
        'microphone',
        'camera',
        'desktop',
        'chat',
        'participants-pane',
        'raisehand'
    ];

    // A laptop window, and a phone held upright.
    const DESKTOP_WIDTH = 1280;
    const MOBILE_WIDTH = 390;

    // Everything this deployment enables that neither bar holds.
    const MENU_AT_DESKTOP = [
        'select-background',
        'videoquality',
        'security',
        'closedcaptions',
        'noisesuppression',
        'sharedvideo',
        'shareaudio',
        'whiteboard',
        'stats',
        'settings',
        'shortcuts',
        'profile',
        'help'
    ];

    it('lays out a row of this configuration at both widths', () => {
        const config = evaluateConfig();

        for (const width of [ DESKTOP_WIDTH, MOBILE_WIDTH ]) {
            assert.ok(
                config.mainToolbarButtons.includes(barAt(config, width)),
                `at ${width}px the client falls back to a row of its own`);
        }
    });

    it('takes the size of each bar from the client thresholds', () => {
        const config = evaluateConfig();

        assert.strictEqual(barAt(config, DESKTOP_WIDTH).length, 8);
        assert.strictEqual(barAt(config, MOBILE_WIDTH).length, 4);
    });

    it('leads the desktop bar with the core controls', () => {
        const bar = barAt(evaluateConfig(), DESKTOP_WIDTH);

        assert.deepStrictEqual(bar.slice(0, CORE_BUTTONS.length), CORE_BUTTONS);

        // The eight slots a desktop window gives the bar belong to the client,
        // and it fills every one of them: what a row leaves out, it picks
        // itself. The two past the core controls are therefore chosen rather
        // than spare, and tile view and full screen are the choice.
        assert.deepStrictEqual(bar.slice(CORE_BUTTONS.length), [ 'tileview', 'fullscreen' ]);
    });

    it('holds nothing but core controls in the mobile bar', () => {
        const bar = barAt(evaluateConfig(), MOBILE_WIDTH);

        assert.deepStrictEqual(
            bar.filter(button => !CORE_BUTTONS.includes(button)),
            [],
            `${bar.join(', ')} is not all core controls`);

        // Four slots for six core controls: screen share and raise hand are
        // the two a phone gives up, and they give way to "More", not to a
        // button nobody chose.
        assert.deepStrictEqual(bar, [ 'microphone', 'camera', 'chat', 'participants-pane' ]);
    });

    it('renders leaving outside both bars', () => {
        const config = evaluateConfig();

        assert.ok(config.toolbarButtons.includes('hangup'), 'leaving is not enabled');

        for (const width of [ DESKTOP_WIDTH, MOBILE_WIDTH ]) {
            assert.ok(
                !barAt(config, width).includes('hangup'),
                `hangup holds a slot in the bar at ${width}px`);
        }
    });

    it('leaves every other enabled button to the "More" menu', () => {
        const config = evaluateConfig();

        assert.deepStrictEqual(overflowAt(config, DESKTOP_WIDTH), MENU_AT_DESKTOP);
        assert.deepStrictEqual(overflowAt(config, MOBILE_WIDTH), [
            'desktop',
            'raisehand',
            'tileview',
            'fullscreen',
            ...MENU_AT_DESKTOP
        ]);
    });
});

describe('the services the environment configures', () => {
    const RECORDING = { MEETSPACE_RECORDING_SHARING_URL: 'https://recordings.example.com/' };
    const STREAMING = { MEETSPACE_LIVE_STREAMING_HELP_URL: 'https://help.example.com/streaming' };
    const DIAL_IN = {
        MEETSPACE_DIAL_IN_CONF_CODE_URL: 'https://dial-in.example.com/code',
        MEETSPACE_DIAL_IN_NUMBERS_URL: 'https://dial-in.example.com/numbers'
    };
    const EVERYTHING = { ...RECORDING,
        ...STREAMING,
        ...DIAL_IN };

    it('offers nothing and configures nothing when no service URL is named', () => {
        const config = evaluateConfig();

        for (const button of [ 'recording', 'highlight', 'livestreaming', 'invite' ]) {
            assert.ok(!config.toolbarButtons.includes(button), `${button} is offered without a service`);
        }

        for (const key of [
            'recordingService',
            'recordingSharingUrl',
            'liveStreaming',
            'dialInNumbersUrl',
            'dialInConfCodeUrl'
        ]) {
            assert.ok(!(key in config), `${key} is configured without a service`);
        }
    });

    it('offers recording, and highlights with it, once the recording URL is named', () => {
        const config = evaluateConfig(RECORDING);

        assert.ok(config.toolbarButtons.includes('recording'));
        assert.ok(config.toolbarButtons.includes('highlight'));
        assert.strictEqual(config.recordingService.enabled, true);
        assert.strictEqual(config.recordingSharingUrl, 'https://recordings.example.com/');

        // One service does not turn on another.
        assert.ok(!config.toolbarButtons.includes('livestreaming'));
        assert.ok(!config.toolbarButtons.includes('invite'));
    });

    it('offers live streaming once the streaming URL is named', () => {
        const config = evaluateConfig(STREAMING);

        assert.ok(config.toolbarButtons.includes('livestreaming'));
        assert.strictEqual(config.liveStreaming.enabled, true);
        assert.strictEqual(config.liveStreaming.helpLink, 'https://help.example.com/streaming');
        assert.ok(!config.toolbarButtons.includes('recording'));
    });

    it('offers dial-in once both dial-in URLs are named', () => {
        const config = evaluateConfig(DIAL_IN);

        assert.ok(config.toolbarButtons.includes('invite'));
        assert.strictEqual(config.dialInNumbersUrl, 'https://dial-in.example.com/numbers');
        assert.strictEqual(config.dialInConfCodeUrl, 'https://dial-in.example.com/code');
    });

    it('reports a half configured service instead of hiding it', () => {
        assert.throws(
            () => readServices({ MEETSPACE_DIAL_IN_NUMBERS_URL: 'https://dial-in.example.com/numbers' }),
            /dial-in is half configured.*MEETSPACE_DIAL_IN_CONF_CODE_URL/s);
        assert.throws(
            () => readServices({ MEETSPACE_DIAL_IN_CONF_CODE_URL: 'https://dial-in.example.com/code' }),
            /dial-in is half configured.*MEETSPACE_DIAL_IN_NUMBERS_URL/s);
    });

    it('treats an empty variable as an unnamed one', () => {
        const config = evaluateConfig({ MEETSPACE_RECORDING_SHARING_URL: '   ' });

        assert.ok(!config.toolbarButtons.includes('recording'));
    });

    it('refuses a service URL the browser cannot fetch', () => {
        assert.throws(
            // eslint-disable-next-line no-script-url
            () => readServices({ MEETSPACE_RECORDING_SHARING_URL: 'javascript:alert(1)' }),
            /not an http\(s\) URL/);
        assert.throws(
            () => readServices({ MEETSPACE_LIVE_STREAMING_HELP_URL: 'help.example.com/streaming' }),
            /not a valid URL/);
    });

    it('encodes a service URL that could break out of the generated source', () => {
        const source = buildConfigJs({
            MEETSPACE_RECORDING_SHARING_URL: 'https://recordings.example.com/a"+alert(1)+"b'
        });

        assert.ok(!source.includes('alert(1)+"b"'), 'the URL escaped its string');
        assert.strictEqual(
            evaluateConfig({ MEETSPACE_RECORDING_SHARING_URL: 'https://recordings.example.com/a"+alert(1)+"b' })
                .recordingSharingUrl,
            'https://recordings.example.com/a%22+alert(1)+%22b');
    });

    it('names only buttons the client knows, whatever is configured', () => {
        const { toolbarButtons } = evaluateConfig(EVERYTHING);
        const known = readKnownToolbarButtons();

        for (const button of toolbarButtons) {
            assert.ok(known.includes(button), `${button} is not a toolbar button`);
        }

        assert.strictEqual(new Set(toolbarButtons).size, toolbarButtons.length, 'a button is listed twice');
    });

    it('leaves a configured service under "More" rather than in the bar', () => {
        const { mainToolbarButtons } = evaluateConfig(EVERYTHING);

        assert.deepStrictEqual(mainToolbarButtons, evaluateConfig().mainToolbarButtons);

        for (const row of mainToolbarButtons) {
            for (const button of row) {
                assert.ok(
                    ![ 'recording', 'highlight', 'livestreaming', 'invite' ].includes(button),
                    `${button} holds a slot in the bar`);
            }
        }
    });

    it('adds a service button in its place, not at the end of the menu', () => {
        const withoutServices = evaluateConfig().toolbarButtons;
        const withServices = evaluateConfig(EVERYTHING).toolbarButtons;

        // Turning a service on inserts buttons; it never reorders the rest.
        assert.deepStrictEqual(
            withServices.filter(button => withoutServices.includes(button)),
            withoutServices);
        assert.ok(
            withServices.indexOf('invite') < withServices.indexOf('help'),
            'the service buttons were appended after the menu');
    });
});

describe('the toolbar the demo shows', () => {
    it('offers exactly the buttons the served configuration offers', () => {
        assert.deepStrictEqual(
            evaluateDemoConfig().toolbarButtons,
            evaluateConfig().toolbarButtons);
    });

    it('lays the bar out exactly as the served configuration does', () => {
        assert.deepStrictEqual(
            evaluateDemoConfig().mainToolbarButtons,
            evaluateConfig().mainToolbarButtons);
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

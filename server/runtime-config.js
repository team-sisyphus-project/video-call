/**
 * Runtime generation of the two configuration files the application shell
 * loads: `config.js` (Jitsi client configuration) and `interface_config.js`
 * (branding/UI configuration).
 *
 * A deployment configures the backend through the environment, never through a
 * tracked file, so the same build can be pointed at a different signalling
 * deployment without a rebuild.
 */

const fs = require('fs');
const path = require('path');

/**
 * Signalling deployment used when the environment does not name one.
 */
const DEFAULT_BACKEND = 'alpha.jitsi.net';

/**
 * Hostnames we accept from the environment: dot separated labels with an
 * optional port. An allowlist, because the value is interpolated into the
 * JavaScript we serve to every visitor.
 */
const BACKEND_PATTERN = /^[a-z\d]([a-z\d-]*[a-z\d])?(\.[a-z\d]([a-z\d-]*[a-z\d])?)*(:\d{1,5})?$/i;

/**
 * Reads the signalling backend host from the environment.
 *
 * Accepts a bare host (`meet.example.com`) or a URL (`https://meet.example.com/`)
 * and always returns the bare host, because the host is what the client
 * configuration needs for the XMPP domain.
 *
 * @param {Object} env - The environment to read from.
 * @returns {string} The validated backend host.
 */
function readBackend(env) {
    const raw = String(env.MEETSPACE_BACKEND || DEFAULT_BACKEND).trim();
    const host = raw
        .replace(/^[a-z][a-z\d+.-]*:\/\//i, '')
        .replace(/\/.*$/, '');

    if (!BACKEND_PATTERN.test(host)) {
        throw new Error(
            `MEETSPACE_BACKEND is not a valid host: ${JSON.stringify(raw)}. `
            + 'Expected something like "meet.example.com".');
    }

    return host;
}

/**
 * The optional backends a deployment may run behind the toolbar.
 *
 * Recording, live streaming and dial-in are not parts of this application: they
 * are separate services a deployment either runs or does not. The client cannot
 * tell the difference. It renders whatever `toolbarButtons` names, and a button
 * whose service is missing looks like every other button until someone presses
 * it. So each service here stays off until the environment names the URLs the
 * client needs to reach it; naming them is what adds the buttons back and fills
 * in the configuration keys the client reads.
 *
 * `variables` are the environment variables holding a service's URLs, in the
 * order `config` reads them. A service's variables are required together: half
 * a service is a misconfiguration, and it is reported as one rather than
 * quietly hidden.
 */
const OPTIONAL_SERVICES = [
    {
        name: 'recording',

        // The recorder runs beside the signalling deployment and the client
        // never addresses it directly, so the one recording URL the client
        // takes is where a finished recording is fetched from. A highlight
        // marks a moment in a recording, so it arrives and leaves with one.
        buttons: [ 'recording', 'highlight' ],
        variables: [ 'MEETSPACE_RECORDING_SHARING_URL' ],
        config: ([ recordingSharingUrl ]) => {
            return {
                recordingService: {
                    enabled: true,
                    sharingEnabled: true
                },
                recordingSharingUrl
            };
        }
    },
    {
        name: 'live streaming',

        // The stream key reaches the recorder through the signalling
        // deployment, so the client takes no ingest URL. The streaming URL it
        // does render is the platform's help page, shown beside the field the
        // key is typed into, and a deployment with somewhere to stream to has
        // one to point at.
        buttons: [ 'livestreaming' ],
        variables: [ 'MEETSPACE_LIVE_STREAMING_HELP_URL' ],
        config: ([ helpLink ]) => {
            return {
                liveStreaming: {
                    enabled: true,
                    helpLink
                }
            };
        }
    },
    {
        name: 'dial-in',

        // Dial-in is the whole of what the invite button offers here: one
        // endpoint lists the numbers to call, the other turns a room into the
        // PIN to type after dialling. The client asks for both or shows
        // neither, which is why both are required together.
        buttons: [ 'invite' ],
        variables: [ 'MEETSPACE_DIAL_IN_NUMBERS_URL', 'MEETSPACE_DIAL_IN_CONF_CODE_URL' ],
        config: ([ dialInNumbersUrl, dialInConfCodeUrl ]) => {
            return {
                dialInConfCodeUrl,
                dialInNumbersUrl
            };
        }
    }
];

/**
 * Every button an optional service owns.
 *
 * These are the buttons `buildToolbarButtons` drops unless the service that
 * backs them is configured.
 */
const OPTIONAL_BUTTONS = new Set(OPTIONAL_SERVICES.flatMap(service => service.buttons));

/**
 * The controls a call is actually run with.
 *
 * They lead `toolbarButtons` and fill the main bar at every width.
 */
const PRIMARY_BUTTONS = [
    'microphone',
    'camera',
    'desktop',
    'chat',
    'participants-pane',
    'raisehand'
];

/**
 * Everything else a conference may offer, in the order it is offered.
 *
 * Reachable through the "More" menu, apart from the two the widest bar rows
 * spend their spare slots on. Entries owned by an optional service keep their
 * place here whether or not the service is configured, so that turning a
 * service on adds a button where it belongs instead of at the end.
 *
 * `linktosalesforce` is absent outright: it needs a CRM, which is not a service
 * this deployment offers to configure.
 */
const SECONDARY_BUTTONS = [
    'tileview',
    'fullscreen',
    'invite',
    'select-background',
    'videoquality',
    'security',
    'closedcaptions',
    'noisesuppression',
    'sharedvideo',
    'shareaudio',
    'whiteboard',
    'recording',
    'highlight',
    'livestreaming',
    'stats',
    'settings',
    'shortcuts',
    'profile',
    'help'
];

/**
 * What the main toolbar shows, per width.
 *
 * The client picks one of these by *length*: it keeps a table of width
 * thresholds, each holding a fixed number of slots, and replaces the order of
 * the entry whose slot count matches the length of one of these arrays. So the
 * length of each array is the width it addresses, and the position in the
 * array is the position in the bar.
 *
 * On web the table runs from 8 slots (wide) down to 2 (narrow), and the bar
 * always fills its slots: a shorter list does not make a shorter bar, it just
 * lets the client pick the remainder itself. The 9 and 10 slot entries the
 * client also accepts are deliberately not overridden here: they are inert
 * unless configured, and configuring them would make the bar wider than the
 * focused set, not narrower.
 *
 * The two widest rows therefore carry the six primaries plus the two viewing
 * controls that would otherwise be chosen for us. "More" and "Leave" are
 * rendered outside this list and do not take a slot. Optional services never
 * appear here: a service a deployment may not run cannot hold a fixed slot in
 * the bar, so its buttons live under "More".
 */
const MAIN_TOOLBAR_BUTTONS = [
    [ ...PRIMARY_BUTTONS, 'tileview', 'fullscreen' ],
    [ ...PRIMARY_BUTTONS, 'tileview' ],
    [ ...PRIMARY_BUTTONS ],
    [ 'microphone', 'camera', 'desktop', 'chat', 'participants-pane' ],
    [ 'microphone', 'camera', 'chat', 'participants-pane' ],
    [ 'microphone', 'camera', 'chat' ],
    [ 'microphone', 'camera' ]
];

/**
 * Reads one service URL from the environment.
 *
 * The value ends up in the JavaScript served to every visitor, so it is parsed
 * rather than trusted: what comes back is the URL the parser normalised, with
 * anything that is not a plain URL character percent encoded.
 *
 * @param {Object} env - The environment to read from.
 * @param {string} name - The environment variable to read.
 * @returns {string|null} The normalised URL, or null when the variable is unset.
 */
function readServiceUrl(env, name) {
    const raw = env[name] && String(env[name]).trim();

    if (!raw) {
        return null;
    }

    let url;

    try {
        url = new URL(raw);
    } catch (error) {
        throw new Error(
            `${name} is not a valid URL: ${JSON.stringify(raw)}. `
            + 'Expected something like "https://meet.example.com/service".',
            { cause: error });
    }

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error(
            `${name} is not an http(s) URL: ${JSON.stringify(raw)}. `
            + 'The browser fetches this address, so only http and https are accepted.');
    }

    return url.href;
}

/**
 * Reads which optional services the environment configures.
 *
 * A service whose URLs are absent contributes nothing: no buttons, no
 * configuration keys, and so no way into a backend that is not there.
 *
 * @param {Object} env - The environment to read from.
 * @returns {Object} `buttons`, the toolbar keys the configured services add,
 * and `config`, the client configuration keys they contribute.
 */
function readServices(env) {
    const buttons = [];
    let config = {};

    for (const service of OPTIONAL_SERVICES) {
        const urls = service.variables.map(name => readServiceUrl(env, name));
        const named = service.variables.filter((_name, index) => urls[index]);

        if (named.length === 0) {
            continue;
        }

        if (named.length !== service.variables.length) {
            const missing = service.variables.filter((_name, index) => !urls[index]);

            throw new Error(
                `${service.name} is half configured: ${named.join(', ')} names a service URL `
                + `but ${missing.join(', ')} is empty. The client needs every one of them, so set `
                + `them all, or none to leave ${service.name} off.`);
        }

        buttons.push(...service.buttons);
        config = {
            ...config,
            ...service.config(urls)
        };
    }

    return {
        buttons,
        config
    };
}

/**
 * The buttons a conference may offer at all.
 *
 * `toolbarButtons` is an allowlist, not a toolbar layout: it decides what
 * exists, and the client then splits it between the main bar and the "More"
 * menu. Left undefined, the client enables every button it knows about, which
 * is how the default deployment ends up with a crowded bar.
 *
 * The primaries lead the list; everything after them is reachable under "More",
 * minus the buttons of every optional service the environment did not
 * configure.
 *
 * @param {Array<string>} serviceButtons - The buttons the configured optional
 * services add.
 * @returns {Array<string>} The buttons this deployment offers.
 */
function buildToolbarButtons(serviceButtons) {
    return [

        // The primaries, plus leaving, which the client renders beside the bar
        // rather than in it.
        ...PRIMARY_BUTTONS,
        'hangup',
        ...SECONDARY_BUTTONS.filter(
            button => !OPTIONAL_BUTTONS.has(button) || serviceButtons.includes(button))
    ];
}

/**
 * Builds the client configuration object for a backend host.
 *
 * @param {string} backend - The signalling deployment host.
 * @param {Object} services - The optional services the environment configured,
 * as `readServices` returns them.
 * @returns {Object} The `config` object the application reads.
 */
function buildConfig(backend, services) {
    return {
        analytics: {
            disabled: true,
            rtcstatsEnabled: false
        },

        // Absolute URLs: this server serves the application only, it is not a
        // reverse proxy in front of the signalling deployment.
        bosh: `https://${backend}/http-bind`,
        websocket: `wss://${backend}/xmpp-websocket`,

        defaultLocalDisplayName: 'me',
        defaultRemoteDisplayName: 'Guest',

        deploymentInfo: {
            environment: 'meetspace'
        },

        // No gravatar, no analytics, no third party beacons.
        disableThirdPartyRequests: true,

        enableClosePage: false,

        // Visitors land on the welcome page and pick a room from there.
        enableWelcomePage: true,

        hosts: {
            domain: backend,
            muc: `conference.${backend}`
        },

        // The bar carries the controls a call is actually run with; the rest
        // of `toolbarButtons` sits one click away under "More".
        mainToolbarButtons: MAIN_TOOLBAR_BUTTONS,

        p2p: {
            enabled: true
        },

        // The prejoin screen shows the camera and microphone preview before
        // anything is joined.
        prejoinConfig: {
            enabled: true,
            hideDisplayName: false
        },

        testing: {},

        toolbarButtons: buildToolbarButtons(services.buttons),

        // What the configured optional services need the client to know:
        // where to fetch a recording, where to read about streaming, which
        // numbers to dial. Nothing at all when none of them is configured.
        ...services.config
    };
}

/**
 * Generates the `config.js` served to the browser.
 *
 * @param {Object} env - The environment to read the backend and the optional
 * services from.
 * @returns {string} JavaScript source declaring the global `config`.
 */
function buildConfigJs(env) {
    const backend = readBackend(env);
    const config = JSON.stringify(buildConfig(backend, readServices(env)), null, 4);

    return '/* Generated by server/index.js. Configure with MEETSPACE_BACKEND. */\n'
        + `var config = ${config};\n`;
}

/**
 * Generates the `interface_config.js` served to the browser.
 *
 * The checked in file is the source of truth; the environment may only
 * override the application name, so a deployment can be renamed without a
 * rebuild.
 *
 * @param {Object} options - The options.
 * @param {Object} options.env - The environment to read overrides from.
 * @param {string} options.root - The repository root.
 * @returns {string} JavaScript source declaring the global `interfaceConfig`.
 */
function buildInterfaceConfigJs({ env, root }) {
    const source = fs.readFileSync(path.join(root, 'interface_config.js'), 'utf8');
    const appName = env.MEETSPACE_APP_NAME && String(env.MEETSPACE_APP_NAME).trim();

    if (!appName) {
        return source;
    }

    return `${source}\ninterfaceConfig.APP_NAME = ${JSON.stringify(appName)};\n`;
}

module.exports = {
    DEFAULT_BACKEND,
    buildConfigJs,
    buildInterfaceConfigJs,
    readBackend,
    readServices
};

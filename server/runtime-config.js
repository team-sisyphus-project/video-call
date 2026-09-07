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
 * The buttons a conference may offer at all.
 *
 * `toolbarButtons` is an allowlist, not a toolbar layout: it decides what
 * exists, and the client then splits it between the main bar and the "More"
 * menu. Left undefined, the client enables every button it knows about, which
 * is how the default deployment ends up with a crowded bar.
 *
 * The primaries lead the list; everything after them is reachable under
 * "More". Omitted on purpose, because this deployment has no backend for them:
 * `recording`, `livestreaming` and `highlight` (no recorder), `invite` (no
 * dial-in or invitation service) and `linktosalesforce` (no CRM). A deployment
 * that runs those services re-enables them by adding the key back here.
 */
const TOOLBAR_BUTTONS = [

    // The primaries MAIN_TOOLBAR_BUTTONS keeps in the bar, plus leaving, which
    // the client renders beside the bar rather than in it.
    'microphone',
    'camera',
    'desktop',
    'chat',
    'participants-pane',
    'raisehand',
    'hangup',

    // Secondaries. Reachable, but through the "More" menu.
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
 * rendered outside this list and do not take a slot.
 */
const MAIN_TOOLBAR_BUTTONS = [
    [ 'microphone', 'camera', 'desktop', 'chat', 'participants-pane', 'raisehand', 'tileview', 'fullscreen' ],
    [ 'microphone', 'camera', 'desktop', 'chat', 'participants-pane', 'raisehand', 'tileview' ],
    [ 'microphone', 'camera', 'desktop', 'chat', 'participants-pane', 'raisehand' ],
    [ 'microphone', 'camera', 'desktop', 'chat', 'participants-pane' ],
    [ 'microphone', 'camera', 'chat', 'participants-pane' ],
    [ 'microphone', 'camera', 'chat' ],
    [ 'microphone', 'camera' ]
];

/**
 * Builds the client configuration object for a backend host.
 *
 * @param {string} backend - The signalling deployment host.
 * @returns {Object} The `config` object the application reads.
 */
function buildConfig(backend) {
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

        // The bar carries the controls a call is actually run with; the rest of
        // TOOLBAR_BUTTONS sits one click away under "More".
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

        toolbarButtons: TOOLBAR_BUTTONS
    };
}

/**
 * Generates the `config.js` served to the browser.
 *
 * @param {Object} env - The environment to read the backend from.
 * @returns {string} JavaScript source declaring the global `config`.
 */
function buildConfigJs(env) {
    const backend = readBackend(env);
    const config = JSON.stringify(buildConfig(backend), null, 4);

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
    readBackend
};

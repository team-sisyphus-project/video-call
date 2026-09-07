/* eslint-disable no-unused-vars, no-var */

/**
 * MeetSpace demo configuration.
 *
 * Served only in demo mode (`make demo`). The signalling endpoints are written
 * as same origin paths so the dev server proxies them to MEETSPACE_BACKEND,
 * which keeps the browser on a single origin and avoids the CORS restrictions a
 * public Jitsi deployment applies to cross origin XMPP connections.
 *
 * With the backend reachable this is a fully working meeting client. With no
 * network the welcome page, the prejoin screen, device selection, camera and
 * microphone preview and the settings surfaces still load, so the product can
 * be explored offline.
 */

// Rewritten by demo/build-index.js from the MEETSPACE_BACKEND env var.
var MEETSPACE_BACKEND = '__MEETSPACE_BACKEND__';

var config = {
    hosts: {
        domain: MEETSPACE_BACKEND,
        muc: `conference.${MEETSPACE_BACKEND}`
    },

    // Same origin, proxied to MEETSPACE_BACKEND by the dev server.
    bosh: '/http-bind',
    websocket: '/xmpp-websocket',

    // Demo visitors land on the welcome page and pick a room from there.
    enableWelcomePage: true,
    enableClosePage: false,

    // The prejoin screen is the first thing a demo visitor should see: it shows
    // the camera and microphone preview without joining anything.
    prejoinConfig: {
        enabled: true,
        hideDisplayName: false
    },

    // The toolbar, identical to what `server/runtime-config.js` serves in
    // production. The demo exists to show the product, so it shows the
    // product's toolbar rather than the client's default one. A change here is
    // a change there as well: `server/server.test.js` fails when the two drift
    // apart.
    //
    // `toolbarButtons` is the availability allowlist -- what a conference may
    // offer at all. Left undefined, the client enables every button it knows
    // about. Recording, live streaming, highlights and dial-in are omitted
    // because the demo runs no backend for them: the served configuration adds
    // those buttons when the deployment names their service URLs, and the demo
    // names none. CRM links are omitted outright.
    toolbarButtons: [

        // The primaries, plus leaving, which renders beside the bar.
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
    ],

    // What the main bar shows, per width. The client picks a row by its length,
    // which is the number of slots the current width gives the bar (8 down to
    // 2), and the position in the row is the position in the bar.
    mainToolbarButtons: [
        [ 'microphone', 'camera', 'desktop', 'chat', 'participants-pane', 'raisehand', 'tileview', 'fullscreen' ],
        [ 'microphone', 'camera', 'desktop', 'chat', 'participants-pane', 'raisehand', 'tileview' ],
        [ 'microphone', 'camera', 'desktop', 'chat', 'participants-pane', 'raisehand' ],
        [ 'microphone', 'camera', 'desktop', 'chat', 'participants-pane' ],
        [ 'microphone', 'camera', 'chat', 'participants-pane' ],
        [ 'microphone', 'camera', 'chat' ],
        [ 'microphone', 'camera' ]
    ],

    // No gravatar, no analytics, no callstats, no third party beacons.
    disableThirdPartyRequests: true,
    analytics: {
        disabled: true,
        rtcstatsEnabled: false
    },

    p2p: {
        enabled: true
    },

    defaultLocalDisplayName: 'me',
    defaultRemoteDisplayName: 'Guest',

    testing: {},

    deploymentInfo: {
        environment: 'meetspace-demo'
    }
};

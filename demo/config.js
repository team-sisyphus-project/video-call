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

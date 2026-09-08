/* eslint-disable no-console */

/**
 * Generates `demo/index.static.html`: the demo shell for a prebuilt deployment.
 *
 * Same idea as build-index.js (inline the SSI includes, load config.js and
 * interface_config.js from demo/) but it keeps the production bundle references
 * (libs/*.min.js, css/all.css) so the page can be served by demo/serve-static.js
 * from a `make compile deploy` output — no webpack-dev-server at runtime.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BACKEND = process.env.MEETSPACE_BACKEND || 'alpha.jitsi.net';

function readInclude(virtualPath) {
    const file = path.join(ROOT, virtualPath.replace(/^\//, ''));

    if (!fs.existsSync(file)) {
        console.warn(`[demo] include not found, skipping: ${virtualPath}`);

        return '';
    }

    return fs.readFileSync(file, 'utf8');
}

const runtimeConfig = fs.readFileSync(path.join(ROOT, 'demo/config.js'), 'utf8')
    .replace('__MEETSPACE_BACKEND__', BACKEND);

fs.writeFileSync(path.join(ROOT, 'demo/config.runtime.js'), runtimeConfig);

let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

html = html.replace(
    /<script><!--#include virtual="\/config\.js" -->[\s\S]*?<\/script>/,
    '<script src="/demo/config.runtime.js"></script>');
html = html.replace(
    /<script><!--#include virtual="\/interface_config\.js" -->[\s\S]*?<\/script>/,
    '<script src="/demo/interface_config.js"></script>');
html = html.replace(
    /<!--#include virtual="([^"]+)" -->/g,
    (_match, virtualPath) => readInclude(virtualPath));

// Room URLs are /RoomName — every asset reference must be root-relative.
html = html.replace(/(src|href)="(libs|css|images|sounds|fonts|static|lang)\//g, '$1="/$2/');

fs.writeFileSync(path.join(ROOT, 'demo/index.static.html'), html);
console.log(`[demo] wrote demo/index.static.html (backend: ${BACKEND})`);

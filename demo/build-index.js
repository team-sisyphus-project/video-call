/* eslint-disable no-console */

/**
 * Generates `index.demo.html` from `index.html`.
 *
 * The upstream `index.html` relies on server side includes (SSI) that only a
 * real deployment (nginx/apache) resolves, and it loads the production bundle
 * names. Demo mode serves the app shell straight from the local dev server, so
 * the includes are inlined here and the bundle references are pointed at the
 * unminified files webpack-dev-server serves from memory.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/**
 * Reads a file referenced by an SSI include.
 *
 * @param {string} virtualPath - The path used in the include directive.
 * @returns {string} The file contents, or an empty string when absent.
 */
function readInclude(virtualPath) {
    const file = path.join(ROOT, virtualPath.replace(/^\//, ''));

    if (!fs.existsSync(file)) {
        console.warn(`[demo] include not found, skipping: ${virtualPath}`);

        return '';
    }

    return fs.readFileSync(file, 'utf8');
}

const BACKEND = process.env.MEETSPACE_BACKEND || 'alpha.jitsi.net';

// The demo config is a template so the backend can be swapped without editing
// a tracked file.
const runtimeConfig = fs.readFileSync(path.join(ROOT, 'demo/config.js'), 'utf8')
    .replace('__MEETSPACE_BACKEND__', BACKEND);

fs.writeFileSync(path.join(ROOT, 'demo/config.runtime.js'), runtimeConfig);
console.log(`[demo] backend: ${BACKEND}`);

let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// The two config files are kept as separate requests so they can be edited
// without regenerating the demo shell.
html = html.replace(
    /<script><!--#include virtual="\/config\.js" -->[\s\S]*?<\/script>/,
    '<script src="demo/config.runtime.js"></script>');
html = html.replace(
    /<script><!--#include virtual="\/interface_config\.js" -->[\s\S]*?<\/script>/,
    '<script src="demo/interface_config.js"></script>');

// Every other include is inlined.
html = html.replace(
    /<!--#include virtual="([^"]+)" -->/g,
    (_match, virtualPath) => readInclude(virtualPath));

// webpack-dev-server emits unminified bundles under /libs/.
html = html.replace('libs/app.bundle.min.js?v=139', 'libs/app.bundle.js');

// The reload-on-missing-asset guard would fight the dev server, so drop the
// minified names it watches for.
html = html.replace('"app.bundle.min.js",', '');

const out = path.join(ROOT, 'index.demo.html');

fs.writeFileSync(out, html);
console.log(`[demo] wrote ${path.relative(ROOT, out)}`);

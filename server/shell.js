/**
 * Resolution of the application shell.
 *
 * `index.html` is written for a web server with server side includes (nginx,
 * apache). This module resolves those includes once at startup so the shell can
 * be served by any static file server.
 */

const fs = require('fs');
const path = require('path');

/**
 * Matches an SSI include directive, with or without the space before the
 * closing marker (both spellings appear in `index.html`).
 */
const INCLUDE_PATTERN = /<!--#include\s+virtual="([^"]+)"\s*-->/g;

/**
 * Matches the inline `<script>` that includes a configuration file. Those two
 * are generated per request from the environment, so the include becomes a
 * reference instead of inlined content.
 */
const CONFIG_SCRIPT_PATTERN
    = /<script><!--#include\s+virtual="\/(config|interface_config)\.js"\s*-->\s*<\/script>/g;

/**
 * Reads a file referenced by an include directive.
 *
 * Absent includes resolve to an empty string, which is what a web server does
 * with an optional include and what several of them (`head.html`, `body.html`)
 * are for.
 *
 * @param {string} root - The directory includes are resolved against.
 * @param {string} virtualPath - The path used in the include directive.
 * @param {Function} onMissing - Called with the path when the file is absent.
 * @returns {string} The file contents, or an empty string.
 */
function readInclude(root, virtualPath, onMissing) {
    const file = path.resolve(root, virtualPath.replace(/^\/+/, ''));

    // An include must not escape the repository.
    if (file !== root && !file.startsWith(root + path.sep)) {
        throw new Error(`Include escapes the document root: ${virtualPath}`);
    }

    if (!fs.existsSync(file)) {
        onMissing(virtualPath);

        return '';
    }

    return fs.readFileSync(file, 'utf8');
}

/**
 * Renders the application shell served for every non asset path.
 *
 * @param {Object} options - The options.
 * @param {string} options.root - The repository root.
 * @param {Function} [options.onMissingInclude] - Called with the path of an
 * include that does not exist.
 * @returns {string} The HTML of the shell.
 */
function renderShell({ root, onMissingInclude = () => { /* ignored */ } }) {
    const documentRoot = path.resolve(root);
    const source = fs.readFileSync(path.join(documentRoot, 'index.html'), 'utf8');

    return source
        .replace(CONFIG_SCRIPT_PATTERN, (_match, name) => `<script src="${name}.js"></script>`)
        .replace(
            INCLUDE_PATTERN,
            (_match, virtualPath) => readInclude(documentRoot, virtualPath, onMissingInclude));
}

module.exports = { renderShell };

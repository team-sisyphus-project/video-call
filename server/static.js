/**
 * Mapping of request paths onto files on disk.
 *
 * Only the directories the built application actually needs are reachable;
 * everything else falls through to the application shell, because room names
 * are top level paths (`/StandUp`).
 */

const path = require('path');

/**
 * Directories served as-is.
 */
const ASSET_DIRECTORIES = [
    'css',
    'fonts',
    'images',
    'lang',
    'libs',
    'sounds',
    'static'
];

/**
 * Files at the repository root that the shell references by name.
 */
const ROOT_FILES = [
    'favicon.ico',
    'manifest.json',
    'pwa-worker.js'
];

/**
 * Content types by file extension. Anything unknown is served as an opaque
 * download rather than guessed at.
 */
const CONTENT_TYPES = {
    '.bin': 'application/octet-stream',
    '.css': 'text/css; charset=utf-8',
    '.gif': 'image/gif',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.ogg': 'audio/ogg',
    '.otf': 'font/otf',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.tflite': 'application/octet-stream',
    '.ttf': 'font/ttf',
    '.txt': 'text/plain; charset=utf-8',
    '.wasm': 'application/wasm',
    '.wav': 'audio/wav',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2'
};

/**
 * The content type for a file.
 *
 * @param {string} filePath - The path of the file.
 * @returns {string} The value for the `Content-Type` header.
 */
function contentTypeFor(filePath) {
    return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/**
 * Decodes a request path into a repository relative path.
 *
 * @param {string} pathname - The pathname of the request URL.
 * @returns {string|null} The relative path, or `null` when the path is
 * malformed or tries to escape the document root.
 */
function toRelativePath(pathname) {
    let decoded;

    try {
        decoded = decodeURIComponent(pathname);
    } catch (error) {
        return null;
    }

    if (decoded.includes('\0') || decoded.includes('\\')) {
        return null;
    }

    const normalized = path.posix.normalize(decoded).replace(/^\/+/, '');

    if (normalized === '' || normalized === '.' || normalized.startsWith('..')) {
        return null;
    }

    return normalized;
}

/**
 * Resolves a request path to a file on disk.
 *
 * @param {string} pathname - The pathname of the request URL.
 * @param {string} root - The repository root.
 * @returns {string|null} The absolute path of the file to serve, or `null` when
 * the path is not an asset path and should be answered with the shell.
 */
function resolveAsset(pathname, root) {
    const relative = toRelativePath(pathname);

    if (relative === null) {
        return null;
    }

    const segments = relative.split('/');
    const isAsset = segments.length === 1
        ? ROOT_FILES.includes(segments[0]) || segments[0].endsWith('.wasm')
        : ASSET_DIRECTORIES.includes(segments[0]);

    if (!isAsset) {
        return null;
    }

    const documentRoot = path.resolve(root);
    const resolved = path.resolve(documentRoot, relative);

    // Defence in depth: normalisation above should already guarantee this.
    if (!resolved.startsWith(documentRoot + path.sep)) {
        return null;
    }

    return resolved;
}

module.exports = {
    ASSET_DIRECTORIES,
    ROOT_FILES,
    contentTypeFor,
    resolveAsset
};

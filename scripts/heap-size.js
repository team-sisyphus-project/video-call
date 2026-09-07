/* eslint-disable no-console */

/**
 * Picks the V8 old-space size a build on this machine can actually have.
 *
 * `make all` compiles with a fixed `--max-old-space-size=8192`. That number is
 * a release machine's number. A preview host has a fraction of that memory,
 * and the flag does not reserve anything — it raises the ceiling at which V8
 * gives up. Set above what the machine has, the ceiling is never reached: the
 * kernel runs out first and kills webpack, which the preview log can only
 * report as `signal=SIGKILL`. A build that dies that way looks exactly like a
 * build that is merely slow.
 *
 * So the ceiling is derived from the machine instead of assumed:
 *
 *   - at most `MAX_HEAP_MB`, because a bigger heap than the release build asks
 *     for buys nothing and only delays the point at which V8 collects;
 *   - `HEAP_SHARE` of total memory, leaving the rest for everything the build
 *     spawns that is not V8's heap — the OS, the loader, source files, and the
 *     workers webpack forks;
 *   - never below `MIN_HEAP_MB`, because this compilation does not fit in less
 *     and a heap set under it fails at once rather than late. On a machine
 *     that small the floor is a deliberate over-commit: better a clear V8
 *     out-of-memory than a build that thrashes for the whole preparation
 *     window.
 *
 * Usage: `node scripts/heap-size.js` prints the number of megabytes on stdout
 * and one line saying how it got there on stderr, so `$(shell ...)` in the
 * Makefile reads the number while the log keeps the reasoning.
 */

const os = require('os');

/**
 * Bytes in a megabyte, in the sense `--max-old-space-size` means it.
 */
const BYTES_PER_MB = 1024 * 1024;

/**
 * The largest heap this build is ever given — what `make all` hardcodes.
 */
const MAX_HEAP_MB = 8192;

/**
 * The smallest heap this build is ever given.
 */
const MIN_HEAP_MB = 2048;

/**
 * The share of the machine's memory the heap may claim.
 */
const HEAP_SHARE = 0.75;

/**
 * The prefix this script's own output carries. Prefixes are owned by the
 * process that writes them, so the runner's report stays distinguishable from
 * the output of what it runs.
 */
const PREFIX = '[heap-size]';

/**
 * The heap size, in megabytes, for a build on a machine of this size.
 *
 * @param {number} [totalBytes] - The machine's total memory.
 * @returns {number} The megabytes to pass to `--max-old-space-size`.
 */
function heapSizeMb(totalBytes = os.totalmem()) {
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
        return MIN_HEAP_MB;
    }

    const share = Math.floor(totalBytes / BYTES_PER_MB * HEAP_SHARE);

    return Math.max(MIN_HEAP_MB, Math.min(MAX_HEAP_MB, share));
}

/**
 * Says how the heap size was arrived at, in one line.
 *
 * A build that quietly asks for less memory than the release build is a trap
 * for whoever reads the log next: the number alone reads as a constant someone
 * typed. The share, the cap and the floor are all named so the number can be
 * checked against the machine without reading this file.
 *
 * @param {number} [totalBytes] - The machine's total memory.
 * @returns {string} The line to write.
 */
function formatNote(totalBytes = os.totalmem()) {
    const heapMb = heapSizeMb(totalBytes);
    const bounds = `cap ${MAX_HEAP_MB}, floor ${MIN_HEAP_MB}`;

    if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
        return `${PREFIX} stage build: heap ${heapMb} MB, machine memory unknown (${bounds})`;
    }

    const totalMb = Math.floor(totalBytes / BYTES_PER_MB);
    const share = Math.round(HEAP_SHARE * 100);

    return `${PREFIX} stage build: heap ${heapMb} MB of ${totalMb} MB total `
        + `(${share}% share, ${bounds})`;
}

/**
 * Prints the heap size for this machine.
 *
 * @param {Object} [options] - Where the two halves of the output go.
 * @param {Function} [options.log] - Where the number goes.
 * @param {Function} [options.note] - Where the reasoning goes.
 * @returns {number} The megabytes that were printed.
 */
function main({ log = console.log, note = console.error } = {}) {
    const totalBytes = os.totalmem();
    const heapMb = heapSizeMb(totalBytes);

    note(formatNote(totalBytes));
    log(String(heapMb));

    return heapMb;
}

if (require.main === module) {
    main();
}

module.exports = {
    HEAP_SHARE,
    MAX_HEAP_MB,
    MIN_HEAP_MB,
    PREFIX,
    formatNote,
    heapSizeMb,
    main
};

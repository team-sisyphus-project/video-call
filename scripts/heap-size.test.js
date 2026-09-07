/**
 * Tests for the build heap sizer.
 *
 * Run with `npm run test:heap-size`.
 *
 * The sizer is a pure function of one number, so the machine it runs on is
 * passed in rather than read: the cases that matter — a host far smaller than
 * the release machine, a host far larger, and the floor — cannot all be
 * observed on any one machine.
 */

const assert = require('assert');
const { execFile } = require('child_process');
const { describe, it } = require('node:test');
const path = require('path');

const {
    HEAP_SHARE,
    MAX_HEAP_MB,
    MIN_HEAP_MB,
    PREFIX,
    formatNote,
    heapSizeMb
} = require('./heap-size');

const SIZER = path.join(__dirname, 'heap-size.js');

/**
 * A machine of the given size, in bytes.
 *
 * @param {number} megabytes - How much memory the machine has.
 * @returns {number} The byte count.
 */
function mb(megabytes) {
    return megabytes * 1024 * 1024;
}

/**
 * A machine of the given size, in bytes.
 *
 * @param {number} gigabytes - How much memory the machine has.
 * @returns {number} The byte count.
 */
function gb(gigabytes) {
    return mb(gigabytes * 1024);
}

describe('heapSizeMb', () => {
    it('leaves a quarter of a small machine to everything that is not the heap', () => {
        assert.strictEqual(heapSizeMb(gb(4)), 3072);
        assert.strictEqual(heapSizeMb(gb(8)), 6144);
    });

    it('never asks a large machine for more than the release build does', () => {
        assert.strictEqual(heapSizeMb(gb(16)), MAX_HEAP_MB);
        assert.strictEqual(heapSizeMb(gb(64)), MAX_HEAP_MB);
        assert.strictEqual(heapSizeMb(gb(1024)), MAX_HEAP_MB);
    });

    it('holds the floor on a machine too small for the share', () => {
        assert.strictEqual(heapSizeMb(gb(2)), MIN_HEAP_MB);
        assert.strictEqual(heapSizeMb(gb(1)), MIN_HEAP_MB);
        assert.strictEqual(heapSizeMb(1), MIN_HEAP_MB);
    });

    it('lets the share govern between the two bounds', () => {
        assert.strictEqual(heapSizeMb(mb(4000)), 3000);
        assert.strictEqual(heapSizeMb(mb(10000)), 7500);
    });

    it('takes whichever of the share, the cap and the floor binds', () => {
        // The share of each of these lands outside a bound: 1500 under the
        // floor, 12000 over the cap.
        assert.strictEqual(heapSizeMb(mb(2000)), MIN_HEAP_MB);
        assert.strictEqual(heapSizeMb(mb(16000)), MAX_HEAP_MB);
    });

    it('stays between the floor and the cap for every machine size', () => {
        for (let size = 0.5; size <= 128; size *= 2) {
            const heap = heapSizeMb(gb(size));

            assert.ok(heap >= MIN_HEAP_MB && heap <= MAX_HEAP_MB, `${size}GB gave ${heap}`);
            assert.ok(Number.isInteger(heap), `${size}GB gave a non-integer ${heap}`);
        }
    });

    it('falls back to the floor when the machine will not say how big it is', () => {
        for (const unknown of [ 0, -1, NaN, Infinity, null ]) {
            assert.strictEqual(heapSizeMb(unknown), MIN_HEAP_MB, `${unknown} gave the wrong heap`);
        }
    });
});

describe('formatNote', () => {
    it('names the heap, the machine, the share and both bounds', () => {
        assert.strictEqual(
            formatNote(gb(8)),
            `${PREFIX} stage build: heap 6144 MB of 8192 MB total `
                + `(${Math.round(HEAP_SHARE * 100)}% share, cap 8192, floor 2048)`);
    });

    it('says the machine size is unknown rather than inventing one', () => {
        assert.strictEqual(
            formatNote(NaN),
            `${PREFIX} stage build: heap 2048 MB, machine memory unknown (cap 8192, floor 2048)`);
    });

    it('describes the number it explains, on every machine size', () => {
        for (const size of [ 1, 4, 8, 32 ]) {
            assert.ok(
                formatNote(gb(size)).includes(`heap ${heapSizeMb(gb(size))} MB`),
                `the note for ${size}GB does not name its own heap size`);
        }
    });

    it('is one line, and not shaped like the runner verdict', () => {
        const note = formatNote(gb(8));

        assert.ok(!note.includes('\n'));
        assert.ok(!note.includes('[preview] STAGE='));
    });
});

describe('running the sizer', () => {
    it('prints the number alone on stdout and the reasoning on stderr', async () => {
        const { stderr, stdout } = await new Promise((resolve, reject) => {
            execFile(process.execPath, [ SIZER ], (error, out, err) => {
                if (error) {
                    reject(error);

                    return;
                }
                resolve({ stderr: err,
                    stdout: out });
            });
        });

        const printed = Number(stdout.trim());

        assert.ok(Number.isInteger(printed), `stdout was not a bare number: ${JSON.stringify(stdout)}`);
        assert.ok(printed >= MIN_HEAP_MB && printed <= MAX_HEAP_MB);
        assert.strictEqual(stdout.trim(), String(printed));
        assert.ok(stderr.includes(`${PREFIX} stage build: heap ${printed} MB`));
    });
});

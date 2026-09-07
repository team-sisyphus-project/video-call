/**
 * Tests for the two word shortening of generated room names.
 *
 * Run with `npm run test:unit`.
 */

const assert = require('assert');
const { describe, it } = require('node:test');

const toTwoWordRoomName = require('./twoWordRoomName.ts').default;

/**
 * Creates a generator that hands out the given names in order and records how
 * many times it was called. The last name repeats once the list runs out.
 *
 * @param {Array<string>} names - The names to hand out.
 * @returns {Function} The generator, carrying a `calls` counter.
 */
function generatorOf(...names) {
    const generate = () => {
        const name = names[Math.min(generate.calls, names.length - 1)];

        generate.calls++;

        return name;
    };

    generate.calls = 0;

    return generate;
}

describe('toTwoWordRoomName', () => {
    it('keeps the first two words of a generated name', () => {
        assert.strictEqual(
            toTwoWordRoomName(generatorOf('CriticalDaysArriveFast')),
            'CriticalDays');
    });

    it('returns a prefix of the generated name', () => {
        const generated = 'SlipperyIdeasComputeBadly';
        const shortened = toTwoWordRoomName(generatorOf(generated));

        assert.ok(generated.startsWith(shortened));
        assert.ok(shortened.length < generated.length);
    });

    it('asks the generator once when the name splits cleanly', () => {
        const generate = generatorOf('CriticalDaysArriveFast');

        toTwoWordRoomName(generate);

        assert.strictEqual(generate.calls, 1);
    });

    it('generates again when a name carries a compound word', () => {
        // `LongTerm` and `TVs` are single entries of the generator's own
        // vocabulary, but they split into two words each.
        const generate = generatorOf(
            'LongTermIdeasComputeBadly',
            'SlipperyTVsComputeBadly',
            'CriticalDaysArriveFast');

        assert.strictEqual(toTwoWordRoomName(generate), 'CriticalDays');
        assert.strictEqual(generate.calls, 3);
    });

    it('gives up after a bounded number of attempts', () => {
        const generate = generatorOf('LongTermIdeasComputeBadly');

        assert.strictEqual(toTwoWordRoomName(generate), 'LongTerm');
        assert.ok(generate.calls > 1);
        assert.ok(generate.calls <= 5);
    });

    it('returns a name of two or fewer words unchanged', () => {
        assert.strictEqual(toTwoWordRoomName(generatorOf('CriticalDays')), 'CriticalDays');
        assert.strictEqual(toTwoWordRoomName(generatorOf('Days')), 'Days');
    });

    it('returns a name it cannot split unchanged', () => {
        assert.strictEqual(toTwoWordRoomName(generatorOf('meeting-42')), 'meeting-42');
    });

    it('always yields two words for the pattern the generator uses', () => {
        const adjectives = [ 'Critical', 'Slippery', 'Quiet' ];
        const nouns = [ 'Days', 'Ideas', 'Rooms' ];
        const verbs = [ 'Arrive', 'Compute', 'Merge' ];
        const adverbs = [ 'Fast', 'Badly', 'Quietly' ];

        for (const adjective of adjectives) {
            for (const noun of nouns) {
                for (const verb of verbs) {
                    for (const adverb of adverbs) {
                        const generate
                            = generatorOf(`${adjective}${noun}${verb}${adverb}`);

                        assert.strictEqual(
                            toTwoWordRoomName(generate),
                            `${adjective}${noun}`);
                    }
                }
            }
        }
    });
});

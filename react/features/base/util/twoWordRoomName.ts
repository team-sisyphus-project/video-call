/**
 * The number of words a room name is shortened to. Two words stay readable when
 * they are spoken out loud, typed by hand or written down on a whiteboard.
 */
const WORD_COUNT = 2;

/**
 * The number of words the room name generator produces. Its single pattern is
 * adjective + plural noun + verb + adverb, so a generated name normally splits
 * into exactly this many words.
 */
const GENERATED_WORD_COUNT = 4;

/**
 * How many names may be generated before the shortening gives up and uses
 * whatever the last name was. A handful of the generator's words are themselves
 * capitalized compounds ({@code TVs}, {@code LongTerm}) which split into more
 * pieces than the pattern has words; generating again is cheap and lands on a
 * clean name almost immediately.
 */
const MAX_ATTEMPTS = 5;

/**
 * Matches one capitalized word of a name such as {@code CriticalDaysArriveFast}.
 */
const WORD_PATTERN = /[A-Z][a-z]*/g;

/**
 * Splits a name written in {@code CamelCase} into its words.
 *
 * @param {string} name - The name to split.
 * @returns {Array<string>} The words of the name, empty if it has none.
 */
function splitWords(name: string): string[] {
    return name.match(WORD_PATTERN) ?? [];
}

/**
 * Shortens the output of a room name generator to its first two words.
 *
 * The generator itself is left alone: it keeps its own vocabulary and stays the
 * single source of room names. Only the tail of the name — the verb and the
 * adverb — is dropped, which leaves the adjective and the noun a reader
 * remembers.
 *
 * A name that cannot be split into more than two words is handed back exactly
 * as the generator produced it, so shortening can never return less of a name
 * than there was.
 *
 * @param {Function} generateRoomName - The generator to take names from.
 * @returns {string} A room name of at most two words.
 */
export default function toTwoWordRoomName(generateRoomName: () => string): string {
    let name = '';
    let words: string[] = [];

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        name = generateRoomName();
        words = splitWords(name);

        if (words.length === GENERATED_WORD_COUNT) {
            break;
        }
    }

    return words.length > WORD_COUNT ? words.slice(0, WORD_COUNT).join('') : name;
}

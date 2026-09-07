import { generateRoomWithoutSeparator } from '@jitsi/js-utils/random';

import toTwoWordRoomName from './twoWordRoomName';

/**
 * Generates a random room name of two English words, such as
 * {@code CriticalDays}.
 *
 * @returns {string} A newly generated room name.
 */
export default function generateRoomName(): string {
    return toTwoWordRoomName(generateRoomWithoutSeparator);
}

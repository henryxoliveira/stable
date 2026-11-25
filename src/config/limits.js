/**
 * Shared numeric limits with no dependencies, so pure modules (like the cost
 * calculator) can import them without pulling in the database client.
 */

/** Seats in a roommate group (accepted members + pending invites). Also the max
 *  number of people a cost estimate can be split between. */
export const MAX_GROUP_SEATS = 16;

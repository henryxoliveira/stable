/**
 * How times are shown to people: always on the campus calendar (Pacific time).
 */

/** e.g. "Mar 1, 2027, 5:00 PM Pacific". Empty string for no date. */
export function formatPacific(date) {
  if (!date) return '';
  const text = new Date(date).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return `${text} Pacific`;
}

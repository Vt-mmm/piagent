/**
 * ISO input profile: YYYY-MM-DDTHH:mm[:ss[.fraction]] with Z or +/-HH:mm offset.
 * Validate the actual Gregorian calendar date, including years 0000..0099;
 * Date.parse accepting or normalizing a string does not establish its validity.
 * Reject locale-formatted strings, impossible dates, and non-finite Date values.
 * now is a finite millisecond number or Date; equality means expired.
 * Omitted now reads the clock only after expiry validation; explicit undefined
 * throws TypeError without reading the clock. Preserve isExpired.length === 1.
 */
export function isExpired(expiresAt, now = Date.now()) {
  const timestamp = Date.parse(expiresAt);
  if (Number.isNaN(timestamp)) return false;
  return Number(now) > timestamp;
}

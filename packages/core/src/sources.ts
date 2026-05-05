/**
 * A source is considered stale when it has shipped no release within this
 * window, or has never published one. Mirrors the "low" retier band ceiling
 * (a source slower than ~once a quarter). Shared so client and server agree.
 */
export const SOURCE_STALE_DAYS = 90;

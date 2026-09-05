/**
 * Reduce mutation-log rows to the set of entity ids they touch.
 *
 * Kept in its own module with no native imports so it can be tested under
 * Node — importing it from the hook file would drag in drizzle's expo-sqlite
 * driver, and therefore React Native.
 */
export function toIdSet(rows: { entityId: string }[]): Set<string> {
  return new Set(rows.map((row) => row.entityId));
}

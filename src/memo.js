/**
 * Single-flight memoization: concurrent callers for the same key share one
 * in-flight operation instead of each starting their own.
 *
 * Kept dependency-free so it is testable outside a DSH profile.
 * @module dsh-weixin-ilink/memo
 */

/**
 * @template T
 * @param {Map<string, Promise<T>>} map In-flight operations, owned by the caller.
 * @param {string} key
 * @param {() => Promise<T>} open Starts the operation; called at most once per in-flight key.
 * @returns {Promise<T>}
 */
export function singleFlight(map, key, open) {
  const inFlight = map.get(key)
  if (inFlight !== undefined) return inFlight
  const started = Promise.resolve()
    .then(open)
    .finally(() => map.delete(key))
  map.set(key, started)
  return started
}

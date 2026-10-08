/**
 * Conflict-safe merge helpers for live match state.
 *
 * The live match has two independent scorers. When both phones save close
 * together, a stale full-state write must not silently erase the other
 * scorer's change. This helper performs a three-way merge using:
 *   base   = state the user edited
 *   local  = the user's new state
 *   remote = state saved by the other scorer
 */
export function liveRevision(state) {
  const value = Number(state?._revision);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function equal(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function mergeValue(base, local, remote) {
  if (equal(local, base)) return remote;
  if (equal(remote, base)) return local;
  if (local && remote && typeof local === "object" && typeof remote === "object"
      && !Array.isArray(local) && !Array.isArray(remote)) {
    const keys = new Set([...Object.keys(base || {}), ...Object.keys(local), ...Object.keys(remote)]);
    const out = {};
    for (const key of keys) {
      const b = base?.[key];
      const l = local?.[key];
      const r = remote?.[key];
      if (l === undefined && r === undefined) continue;
      out[key] = mergeValue(b, l, r);
    }
    return out;
  }

  if (Array.isArray(local) && Array.isArray(remote) && Array.isArray(base)) {
    // Preserve independent appends (most importantly rack entries from two
    // phones). For same-position edits, local wins deliberately: the scorer
    // who made the latest retry has the explicit correction.
    const common = Math.min(base.length, local.length, remote.length);
    const out = [];
    for (let i = 0; i < common; i++) out.push(mergeValue(base[i], local[i], remote[i]));

    const localAdded = local.slice(base.length);
    const remoteAdded = remote.slice(base.length);
    out.push(...localAdded);
    out.push(...remoteAdded.filter(item => !localAdded.some(existing => equal(existing, item))));
    out.push(...local.slice(common, base.length > common ? base.length : common));
    out.push(...remote.slice(common, base.length > common ? base.length : common));
    return out;
  }

  // A true conflict on one scalar: preserve the user's explicit latest edit.
  return local;
}

export function mergeLiveMatchState(base, local, remote) {
  const merged = mergeValue(base || {}, local || {}, remote || {});
  merged._revision = liveRevision(remote);
  return merged;
}

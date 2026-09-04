/**
 * Colony-only project hiding. Threads stay in the harness; the map just stops drawing
 * that repo until you unhide it. Names are folder basenames, the same key plots use.
 */

export function hideProject(hidden, name) {
  const id = String(name || '')
  if (!id) return [...hidden]
  if (hidden.includes(id)) return [...hidden]
  return [...hidden, id]
}

export function unhideProject(hidden, name) {
  const id = String(name || '')
  return hidden.filter((n) => n !== id)
}

export function liveThreadsForColony(threads, archivedIds, hiddenProjects) {
  const archived = archivedIds instanceof Set ? archivedIds : new Set(archivedIds)
  const hidden = hiddenProjects instanceof Set ? hiddenProjects : new Set(hiddenProjects)
  return threads.filter((t) => !t.archived && !archived.has(t.id) && !hidden.has(t.project || 'unknown'))
}

export function hiddenCatalog(hidden, threads) {
  const names = [...new Set(hidden.map(String).filter(Boolean))].sort((a, b) => a.localeCompare(b))
  return names.map((name) => ({
    name,
    count: threads.filter((t) => !t.archived && (t.project || 'unknown') === name).length,
  }))
}

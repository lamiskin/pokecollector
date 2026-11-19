// Auto-filing is best effort: by the time the allocation result arrives the
// card is already in the collection, so this may only ever explain a shortfall
// — never imply that the add itself failed. A full allocation returns null.
//
// `fallbackName` is the destination the job was opened with. It matters twice:
// the backend returns `binder_name: null` when the list is unavailable, and an
// allocation of `null` means the list was removed before the add (the scan
// job's foreign key is cleared), so there is no name in the response at all.
export function allocationNotice(allocation, t, fallbackName = null) {
  if (!allocation) {
    return fallbackName
      ? t('scanner.allocationListUnavailable').replace('{name}', fallbackName)
      : null
  }

  const requested = Number(allocation.requested || 0)
  const allocated = Number(allocation.allocated || 0)
  const failed = allocation.reason === 'list_unavailable'
    || allocation.reason === 'no_unallocated_copies'
  if (!failed && !(requested > 0 && allocated < requested)) return null

  const name = allocation.binder_name || fallbackName || t('scanner.allocationFallbackName')

  if (allocation.reason === 'list_unavailable') {
    return t('scanner.allocationListUnavailable').replace('{name}', name)
  }
  if (allocation.reason === 'no_unallocated_copies') {
    return t('scanner.allocationNoCopies').replace('{name}', name)
  }
  if (allocated > 0) {
    return t('scanner.allocationPartial')
      .replace('{allocated}', String(allocated))
      .replace('{requested}', String(requested))
      .replace('{name}', name)
  }
  return t('scanner.allocationNone').replace('{name}', name)
}

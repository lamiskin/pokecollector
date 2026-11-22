/**
 * What the scan submit button says while a batch is on its way.
 *
 * Two different waits share one button: shrinking the photos in the browser and
 * uploading the result. Calling both "Uploading" made the slow downscale phase
 * look like an upload that had stalled, so the phases are named separately and
 * carry a number — a count while preparing, a percentage while uploading.
 * Translation goes through `t`, so the strings stay catalogued.
 */
export function scanSubmitLabel(t, { submitting, progress } = {}) {
  if (!submitting) return t('scanner.startScanning')

  if (progress?.phase === 'prepare' && progress.total) {
    return `${t('scanner.preparingPhotos')} ${progress.done}/${progress.total}`
  }
  if (progress?.phase === 'upload' && progress.total) {
    // 100 is reserved for the response; the last byte is not the last state.
    const percent = Math.min(99, Math.floor((progress.loaded / progress.total) * 100))
    return `${t('scanner.submittingBatch')} ${percent}%`
  }
  return t('scanner.submittingBatch')
}

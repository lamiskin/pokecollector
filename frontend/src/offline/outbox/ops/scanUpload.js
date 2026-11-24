import { ITEM_TYPES } from '../../constants.js'
import { toBinderId } from '../../ops/scanSubmit.js'
import { validateShape } from '../classify.js'

export const scanUpload = {
  type: ITEM_TYPES.SCAN_UPLOAD,

  /**
   * `POST /api/cards/recognize/jobs` as multipart. Every photo becomes a fresh in-memory
   * Blob (stored Blobs are unreliable on Safari). No `Content-Type`: `fetch` must add the
   * multipart boundary itself.
   */
  async buildRequest(item, readPhotos) {
    const form = new FormData()
    for await (const photo of readPhotos(item.id)) {
      form.append('files', new Blob([photo.bytes], { type: photo.type }), photo.name)
    }
    form.append('individual_positions', JSON.stringify(item.payload?.individualPositions ?? []))
    // The batch's chosen destination list. Entries queued before destinations existed have no
    // `binderId`, and an absent/empty value must simply post no field, not fail the replay.
    const binderId = toBinderId(item.payload?.binderId)
    if (binderId !== null) form.append('binder_id', String(binderId))
    return { url: '/api/cards/recognize/jobs', method: 'POST', headers: {}, body: form }
  },

  validateResponse: json => validateShape(ITEM_TYPES.SCAN_UPLOAD, json),

  summarize(item) {
    return item.display?.title || `${item.photoCount} photo${item.photoCount === 1 ? '' : 's'}`
  },

  onSynced(queryClient) {
    queryClient?.invalidateQueries({ queryKey: ['scan-jobs'] })
  },
}

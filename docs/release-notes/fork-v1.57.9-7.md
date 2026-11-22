<!-- Fork release 1.57.9-7 -->
<!-- release-coverage: #23 -->

### Fixes and changes

**Multi-photo scan batches no longer stop partway on mobile data.** A batch of
dozens of photos could fail with "The scan batch could not be submitted." The
browser was giving the upload 30 seconds — fine for an ordinary request, far too
little for tens of megabytes over a phone connection — and then abandoning it,
which the server saw as a broken request with no explanation. The batch upload
now allows up to 30 minutes, and the submit button says what is happening while
it waits: `Uploading photos… 12/48` while photos are prepared, then a percentage
while they are sent. Nothing about the stored photos or the recognition result
changes.

### Limitations and notes

- The limit is time, not size: a batch still has to fit the existing 200 MB
  job cap, which browser-side downscaling keeps it well under. A very slow or
  failing connection can still fail, but now after minutes of visible progress
  rather than after 30 seconds with no explanation.
- Ordinary API calls keep the 30-second client timeout; the longer one applies
  only to the scan-batch upload.

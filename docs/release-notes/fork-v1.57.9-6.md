<!-- Fork release 1.57.9-6 -->
<!-- release-coverage: #19 #20 -->

### Features

**Large photos are shrunk before they are uploaded.** The scanner and the
collection's own-photo upload now downscale large photos in the browser before
sending them. A typical phone photo is 3–15 MB, and a 50-photo scan meant
sending several hundred megabytes up a mobile connection before recognition
even started; those photos are now reduced to a fraction of that first. In
testing, a 6.2 MB photo became 1.47 MB, and a 14.2 MB one became 2.3 MB.

Nothing the recognizer sees changes. The browser scales to the same
2048-pixel edge the server already used, keeps the photo upright from its EXIF
orientation, and sends a metadata-free JPEG; the server still sanitizes every
upload exactly as before, and stored photos are unchanged.

### Fixes and changes

- Small photos are passed through untouched and never re-encoded.
- If the browser cannot decode a photo — HEIC outside Safari, for example — or
  shrinking would not actually make it smaller, the original file is uploaded
  unchanged instead of failing.

### Limitations and notes

- This is an upload-size optimization only. It does not change what is stored,
  and the server keeps enforcing its own size and pixel limits.
- The saving is largest on phone-camera photos. Screenshots and small images
  are already close to the stored size and are left alone.

<!-- Fork release 1.57.9-10 -->
<!-- release-coverage: #36 -->

### Fixes and changes

**Sign-in secrets stay out of logs without going dark.** The previous release
disabled the backend's entire access log so the OIDC callback's one-time `code`
and `state` could not be written anywhere. Access logging is back on for every
endpoint: the backend rewrites only `/api/auth/oidc/*` request targets to their
path, and nginx records those requests with a path-only format. Other endpoints
are logged exactly as before.

**Signing in no longer throttles everyone at once.** The sign-in limit was keyed
on the client address, which behind the bundled proxy is one shared address, so
ten attempts in a minute could lock the login page for the whole installation.
It is now keyed on the browser's own binding cookie, falling back to the address
for a browser's first request.

**A misbehaving profile endpoint no longer blocks sign-in.** When the provider
advertises UserInfo, a timeout, HTTP error, oversized body, malformed JSON or a
subject that does not match the validated ID token used to fail the whole
sign-in. Those now simply provide no extra name hints: the sign-in continues
with the validated ID token and asks for a username if nothing usable is left.

**Sign-in is faster.** Provider discovery metadata and signing keys are cached
for five minutes per configuration instead of being fetched on every request,
and concurrent first requests share one fetch.

**Linking an identity reports an expired session correctly.** Completing a link
with a bearer that no longer resolves to an active user now returns an
authentication error instead of a generic failure, so the page can ask you to
sign in again. A completion whose one-time window closed is refused before any
application token is issued.

**Local-mode installations are untouched by the OIDC schema work.** The OIDC
schema migrations now run only when an OIDC mode is configured, so a database
carried over from an earlier release keeps starting in `local` mode, including a
SQLite database whose password column predates nullable SSO accounts.

### Limitations and notes

- No screenshots: this release changes request logging, response headers,
  throttling, caching and error handling. Nothing visible in the interface
  changes.
- In `mixed` mode any identity the provider authenticates is provisioned a
  trainer account on first sign-in. Restrict who may obtain tokens for this
  client at the provider.
- Rotating `JWT_SECRET_KEY` invalidates in-flight sign-in and linking attempts
  (they fail closed); replicas must share the secret.
- Native OIDC needs PostgreSQL. An existing SQLite database still starts in
  `local` mode and refuses OIDC with an explicit message.
- Throttles are per backend process and keyed on a client-supplied cookie. An
  `oidc-only` deployment still needs a shared limit at its edge.
- One metadata-only database change: PostgreSQL drops the unused default on
  `oidc_auth_transactions.created_at`. No data is rewritten, and rolling back to
  `fork-v1.57.9-9` remains schema-compatible.

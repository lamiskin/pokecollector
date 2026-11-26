import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Fork-specific expectations. This fork deliberately keeps the security headers
// inline at server level: `Referrer-Policy` must be the `$referrer_policy` map so
// OIDC endpoints send no policy of their own and the backend's `no-referrer`
// survives (a static snippet header would shadow it). It also deliberately keeps
// `location = /index.html` free of location-level headers, using `expires -1`
// instead, because any location-level `add_header` would suppress the inherited
// CSP and Permissions-Policy. Do not "fix" either back to the upstream
// snippet-only / add_header structure during a sync.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const conf = fs.readFileSync(path.join(root, 'nginx.conf'), 'utf8').replace(/\r\n/g, '\n');
const snippet = fs.readFileSync(path.join(root, 'nginx-security-headers.conf'), 'utf8');
const INCLUDE = /include\s+\/etc\/nginx\/snippets\/pc-security-headers\.conf;/;

// Split the server block into its top-level location blocks (no nested braces in this file).
function locations() {
  return [...conf.matchAll(/^\s{4}location\s+([^{]+?)\s*\{([^}]*)\}/gm)].map((m) => ({
    name: m[1],
    body: m[2],
  }));
}

test('security header snippet carries the CSP with script-src self', () => {
  assert.match(snippet, /add_header Content-Security-Policy "[^"]*script-src 'self'[^"]*" always;/);
  for (const header of ['X-Frame-Options', 'X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy']) {
    assert.ok(snippet.includes(header), `${header} missing from snippet`);
  }
});

test('server block defines the security headers once, with the OIDC referrer map', () => {
  const serverLevel = conf.split(/^\s{4}location\s/m)[0];
  const directiveCount = (name) =>
    (serverLevel.match(new RegExp(`add_header\\s+${name}\\b`, 'g')) || []).length;
  const inSnippet = (name) => new RegExp(`add_header\\s+${name}\\b`).test(snippet);

  if (INCLUDE.test(serverLevel)) {
    // A snippet include replaces the inline set, so it must not sit next to it.
    assert.equal(directiveCount('Content-Security-Policy'), 0);
  } else {
    // Inline headers only work while Referrer-Policy stays the map variable.
    assert.match(
      serverLevel,
      /add_header\s+Referrer-Policy\s+\$referrer_policy\s+always;/,
      'server-level Referrer-Policy must use $referrer_policy, not a static value',
    );
    assert.match(conf, /map\s+\$uri\s+\$referrer_policy\s*\{/);
  }

  // Permissions-Policy and CSP must be defined exactly once for the server
  // block: inline when headers are inline, from the snippet when it is included
  // (never both, which would send duplicates).
  const usesSnippet = INCLUDE.test(serverLevel);
  for (const name of ['Permissions-Policy', 'Content-Security-Policy']) {
    const inline = directiveCount(name);
    const fromSnippet = inSnippet(name) ? 1 : 0;
    if (usesSnippet) {
      assert.equal(inline, 0, `${name} must not be duplicated inline when the snippet is included`);
      assert.equal(fromSnippet, 1, `${name} missing from the snippet`);
    } else {
      assert.equal(inline, 1, `${name} must be declared exactly once inline`);
    }
  }

  // The CSP must keep the strict scanner policy whichever source supplies it.
  const cspSource = directiveCount('Content-Security-Policy') ? serverLevel : snippet;
  assert.match(cspSource, /add_header Content-Security-Policy "[^"]*script-src 'self'[^"]*" always;/);
  assert.match(cspSource, /add_header Permissions-Policy "camera=\(self\)[^"]*" always;/);
});

test('every location that sets add_header also includes the snippet', () => {
  const withHeaders = locations().filter((loc) => loc.body.includes('add_header'));
  assert.ok(withHeaders.length >= 4);
  for (const loc of withHeaders) {
    assert.match(loc.body, INCLUDE, `location ${loc.name} must include the security headers`);
  }
});

test('HTML shell, manifest and SPA fallback revalidate; hashed assets stay immutable', () => {
  const byName = Object.fromEntries(locations().map((loc) => [loc.name, loc.body]));

  assert.ok(byName['= /index.html'], 'location = /index.html missing');
  // Revalidation may come from `expires -1` (which emits Cache-Control: no-cache)
  // or an explicit Cache-Control, but never from a location-level add_header:
  // that would suppress the inherited CSP and Permissions-Policy.
  assert.match(
    byName['= /index.html'],
    /expires\s+-1\s*;|Cache-Control[^;\n]*no-cache/,
    'location = /index.html must be non-cacheable (expires -1 or Cache-Control: no-cache)',
  );
  assert.doesNotMatch(
    byName['= /index.html'],
    /^\s*add_header\b/m,
    'location = /index.html must not declare a location-level header',
  );

  for (const name of ['= /manifest.json', '/']) {
    assert.ok(byName[name], `location ${name} missing`);
    assert.match(byName[name], /Cache-Control "no-cache" always;/);
  }

  const assets = locations().find((loc) => loc.name.startsWith('~*'));
  assert.match(assets.body, /public, immutable/);
});

test('cv-js-lab is cross-origin isolated without losing the shared headers', () => {
  const lab = locations().find((loc) => loc.name.includes('/cv-js-lab/'));
  assert.ok(lab, 'location ^~ /cv-js-lab/ missing');

  // Isolation is what makes SharedArrayBuffer (and multi-threaded WASM) available.
  assert.match(lab.body, /add_header\s+Cross-Origin-Opener-Policy\s+"same-origin"\s+always;/);
  assert.match(lab.body, /add_header\s+Cross-Origin-Embedder-Policy\s+"require-corp"\s+always;/);

  // A location-level add_header suppresses every inherited server header, so the
  // snippet include is the only thing keeping CSP and Permissions-Policy (camera)
  // on this page.
  assert.match(lab.body, INCLUDE, 'location /cv-js-lab/ must include the security headers');

  // Missing lab files must 404 rather than fall back to the SPA shell.
  assert.match(lab.body, /try_files\s+\$uri\s+\$uri\/\s+=404;/);

  // COEP server-wide would block third-party card art: it must stay scoped.
  const serverLevel = conf.split(/^\s{4}location\s/m)[0];
  assert.doesNotMatch(serverLevel, /Cross-Origin-(Opener|Embedder)-Policy/);
});

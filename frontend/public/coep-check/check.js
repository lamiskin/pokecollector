/* Cross-origin isolation probe. Plain classic script: the app's CSP is
   `script-src 'self'`, so no inline handler can be used here.
   Reports two independent facts: whether this document is cross-origin
   isolated, and whether a cross-origin no-cors image (third-party card art)
   still loads under the policy that isolated it. */
(function () {
  'use strict';

  var TCGDEX_ART = 'https://assets.tcgdex.net/en/base/base1/1/high.webp';
  var PROBES = [
    { key: 'control', label: 'same-origin control', url: '/cardback.jpg', cors: false },
    { key: 'nocors', label: 'tcgdex art (no-cors)', url: TCGDEX_ART, cors: false },
    { key: 'cors', label: 'tcgdex art (CORS mode)', url: TCGDEX_ART, cors: true },
  ];

  var isolated = window.crossOriginIsolated === true;
  var hasSab = typeof SharedArrayBuffer !== 'undefined';
  var failures = [];
  var seenFailures = Object.create(null);
  var results = Object.create(null);

  function el(id) { return document.getElementById(id); }

  function setStat(id, text, tone) {
    var node = el(id);
    if (!node) return;
    node.textContent = text;
    node.className = 'v' + (tone ? ' ' + tone : '');
  }

  function recordFailure(source, why) {
    var key = source + '|' + why;
    if (seenFailures[key]) return;
    seenFailures[key] = true;
    failures.push({ source: source, why: why });
    renderFailures();
  }

  function renderFailures() {
    var list = el('failures');
    if (!list) return;
    list.textContent = '';
    if (!failures.length) {
      var none = document.createElement('li');
      none.className = 'none';
      none.textContent = 'none';
      list.appendChild(none);
      return;
    }
    failures.forEach(function (failure) {
      var item = document.createElement('li');
      item.textContent = failure.why + ' — ' + failure.source;
      list.appendChild(item);
    });
  }

  // Resource errors do not bubble; a capture-phase listener on window sees them.
  window.addEventListener('error', function (event) {
    var target = event.target;
    if (!target || target === window) return;
    var source = target.currentSrc || target.src || target.href || '(unknown)';
    var kind = target.tagName ? target.tagName.toLowerCase() : 'resource';
    recordFailure(source, kind + ' failed to load');
  }, true);

  function renderProbeRow(probe, state, detail) {
    var row = document.querySelector('[data-probe="' + probe.key + '"]');
    if (!row) return;
    var cell = row.querySelector('td.state');
    if (!cell) return;
    cell.className = 'state ' + state;
    cell.textContent = detail;
  }

  function renderStrip(probe, img) {
    var strip = el('strip');
    if (!strip) return;
    var figure = document.createElement('figure');
    var caption = document.createElement('figcaption');
    caption.textContent = probe.label;
    figure.appendChild(img);
    figure.appendChild(caption);
    strip.appendChild(figure);
  }

  function buildProbeRows() {
    var body = el('probes');
    if (!body) return;
    body.textContent = '';
    PROBES.forEach(function (probe) {
      var row = document.createElement('tr');
      row.setAttribute('data-probe', probe.key);
      var name = document.createElement('td');
      name.textContent = probe.label;
      var url = document.createElement('td');
      url.className = 'url';
      url.textContent = probe.url;
      var state = document.createElement('td');
      state.className = 'state pending';
      state.textContent = 'pending';
      row.appendChild(name);
      row.appendChild(url);
      row.appendChild(state);
      body.appendChild(row);
    });
  }

  function runProbe(probe) {
    var started = Date.now();
    var img = document.createElement('img');
    img.alt = probe.label;
    img.decoding = 'async';
    // crossOrigin must be set before src: it decides the request mode.
    if (probe.cors) img.crossOrigin = 'anonymous';

    img.addEventListener('load', function () {
      results[probe.key] = true;
      renderProbeRow(probe, 'ok', 'loaded (' + (Date.now() - started) + ' ms)');
      updateVerdict();
    });

    img.addEventListener('error', function () {
      results[probe.key] = false;
      renderProbeRow(probe, 'bad', 'failed — see the failure list');
      recordFailure(probe.url, probe.label + ' failed to load');
      updateVerdict();
    });

    img.src = probe.url;
    renderStrip(probe, img);
  }

  function verdict() {
    var nocors = results.nocors;
    var cors = results.cors;
    var control = results.control;

    if (!isolated) {
      return {
        tone: 'bad',
        title: 'Not cross-origin isolated',
        body: 'This document did not receive a working COOP+COEP pair. On Firefox or Safari this is '
          + 'expected: neither implements COEP `credentialless`. On Chromium, the headers are missing '
          + 'from the response for this location.',
      };
    }
    if (control === false) {
      return {
        tone: 'warn',
        title: 'Isolated, but the same-origin control image failed',
        body: 'Isolation is on, yet /cardback.jpg did not load. That points at the deployment, not at '
          + 'the cross-origin policy. Check that the frontend image is present.',
      };
    }
    if (nocors === false) {
      return {
        tone: 'bad',
        title: 'Isolated with require-corp — third-party card art is blocked',
        body: 'crossOriginIsolated is true but the no-cors tcgdex image was refused. The effective '
          + 'policy is `require-corp`, and assets.tcgdex.net sends no Cross-Origin-Resource-Policy. '
          + 'The document must be served with `Cross-Origin-Embedder-Policy: credentialless`.',
      };
    }
    if (nocors === true) {
      return {
        tone: 'ok',
        title: 'Isolated and third-party card art loads',
        body: 'credentialless is working: SharedArrayBuffer is available to the SPA and '
          + 'assets.tcgdex.net images still load'
          + (cors === false ? ' (the CORS-mode probe failed, which does not affect plain <img> art)' : '')
          + '.',
      };
    }
    return {
      tone: 'warn',
      title: 'Isolated; art probes still pending',
      body: 'crossOriginIsolated is true. The image probes have not settled yet.',
    };
  }

  function updateVerdict() {
    markProbeStats();
    var node = el('verdict');
    if (!node) return;
    var state = verdict();
    node.className = 'verdict ' + state.tone;
    node.textContent = '';
    var title = document.createElement('strong');
    title.textContent = state.title;
    var body = document.createElement('span');
    body.textContent = state.body;
    node.appendChild(title);
    node.appendChild(body);
  }

  function renderFacts() {
    setStat('s-isolated', String(isolated), isolated ? 'ok' : 'bad');
    setStat('s-sab', hasSab ? 'available' : 'unavailable', hasSab ? 'ok' : 'bad');
    setStat('s-ua', navigator.userAgent || '(unknown)', 'muted');
  }

  function markProbeStats() {
    ['nocors', 'cors'].forEach(function (key) {
      var value = results[key];
      if (value === undefined) {
        setStat('s-' + key, 'pending', 'warn');
      } else if (value) {
        setStat('s-' + key, 'loaded', 'ok');
      } else {
        setStat('s-' + key, 'failed', 'bad');
      }
    });
  }

  function start() {
    renderFacts();
    buildProbeRows();
    renderFailures();
    PROBES.forEach(runProbe);
    // A probe that never fires load or error (a hung request) must not leave the
    // verdict at "pending" forever.
    window.setTimeout(function () {
      PROBES.forEach(function (probe) {
        if (results[probe.key] === undefined) {
          renderProbeRow(probe, 'bad', 'no load or error after 10 s');
          recordFailure(probe.url, probe.label + ' timed out');
        }
      });
      updateVerdict();
    }, 10000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();

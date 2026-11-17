// Citadel online demo: runs before anything else on the page and turns the dashboard into a frozen, read-only snapshot.
// Written by tools/build_demo.py (the snapshot time below is filled in by the build). Nothing here talks to a server:
//  - the clock reads the visitor's own time of day, on the day the snapshot was taken, so "tomorrow", bin days and
//    countdowns read the way they did that day however long ago it was built (and it isn't forever 3am);
//  - /api/* GETs are answered from the saved JSON in data/ (anything not saved says so), every change is refused;
//  - the event stream is a stub that "connects" and then never says anything changed;
//  - it opens in LCARS at Night (the header buttons still switch, and a visitor's own pick is kept for next time);
//  - redacted bookmarks and Remote Access say they aren't part of the demo; Settings is a read-only snapshot
//    (settings.html, which loads this file too).
(function () {
  'use strict';
  var SNAPSHOT = 1794885543766;
  var NOT_HERE = 'Not available in the online demo';
  var READ_ONLY = 'This is a read-only demo — nothing is saved';
  var DATA = new URL('data/', document.currentScript.src).href;

  // ---- the clock ----------------------------------------------------------------------------------------------------
  var RealDate = Date;
  var snap = new RealDate(SNAPSHOT), real = new RealDate();
  var offset = new RealDate(snap.getFullYear(), snap.getMonth(), snap.getDate(),
    real.getHours(), real.getMinutes(), real.getSeconds(), real.getMilliseconds()).getTime() - real.getTime();
  class DemoDate extends RealDate {
    constructor(...args) { if (args.length) super(...args); else super(RealDate.now() + offset); }
    static now() { return RealDate.now() + offset; }
  }
  window.Date = DemoDate;

  // ---- first visit: LCARS at Night (theme-init.js reads these next). The website's ?theme= is ignored on purpose.
  // DEFAULTS_V moves visitors of an older build (which followed the website's Day/Night) onto the new default once.
  var DEFAULTS_V = '2';
  try {
    if (localStorage.getItem('demo-defaults') !== DEFAULTS_V) {
      localStorage.setItem('mode', 'night'); localStorage.setItem('look', 'lcars');
      localStorage.removeItem('look-spec'); localStorage.removeItem('theme');
      localStorage.setItem('demo-defaults', DEFAULTS_V);
    }
  } catch (e) {
    // storage blocked: theme-init.js can't read anything either, so put LCARS on the page by hand
    document.documentElement.dataset.skin = 'lcars';
  }

  // ---- the API, from saved files ------------------------------------------------------------------------------------
  // The file name rule must match key_of() in tools/build_demo.py.
  function keyOf(url) {
    var rest = url.pathname.replace(/^\/api\/owner/, '') + url.search;
    return rest.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'index';
  }
  function reply(status, body) {
    return Promise.resolve(new Response(JSON.stringify(body), { status: status, headers: { 'Content-Type': 'application/json' } }));
  }
  var realFetch = window.fetch.bind(window);
  var cache = new Map();
  var index = null;                  // the keys the build saved (data/index.json)
  function saved(key) {
    if (!index) index = realFetch(DATA + 'index.json').then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; });
    return index.then(function (keys) { return keys.indexOf(key) < 0 ? null : load(key); });
  }
  function load(key) {
    if (!cache.has(key)) {
      cache.set(key, realFetch(DATA + key + '.json').then(function (r) { return r.ok ? r.text() : null; }).catch(function () { return null; }));
    }
    return cache.get(key);
  }
  // The Monitoring tile polls every couple of seconds: play back the readings taken during the build, forwards then
  // backwards, so the numbers move without jumping when the loop comes round.
  var frame = 0;
  function monitoring() {
    return saved('monitoring_frames').then(function (text) {
      var frames = text ? JSON.parse(text) : [];
      if (!frames.length) return reply(503, { detail: NOT_HERE });
      var n = frames.length, cycle = Math.max(1, 2 * n - 2), i = frame++ % cycle;
      return reply(200, frames[i < n ? i : cycle - i]);
    });
  }
  window.fetch = function (input, init) {
    var url;
    try { url = new URL(typeof input === 'string' ? input : input.url, location.href); } catch (e) { return realFetch(input, init); }
    if (url.origin !== location.origin || url.pathname.indexOf('/api/') !== 0) return realFetch(input, init);
    var method = String((init && init.method) || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    // 409, not 403: Citadel's api.js reloads the page on a 403 (it means "this device was revoked").
    if (method !== 'GET') return reply(409, { detail: READ_ONLY });
    var key = keyOf(url);
    if (key === 'monitoring') return monitoring();
    return saved(key).then(function (text) {
      if (text === null) return reply(503, { detail: NOT_HERE });
      // the server's own "now" (bins' morning/evening wording, service uptimes) follows the demo clock too
      if (key === 'state') { var s = JSON.parse(text); s.now = new DemoDate().toISOString(); return reply(200, s); }
      return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
  };

  // ---- the event stream: connects, then stays quiet -----------------------------------------------------------------
  function QuietEventSource(url) {
    var self = this;
    this.url = String(url);
    this.readyState = 0;
    this.onopen = this.onerror = this.onmessage = null;
    setTimeout(function () {
      if (self.readyState === 2) return;
      self.readyState = 1;
      if (typeof self.onopen === 'function') self.onopen(new Event('open'));
    }, 0);
  }
  QuietEventSource.CONNECTING = 0; QuietEventSource.OPEN = 1; QuietEventSource.CLOSED = 2;
  QuietEventSource.prototype.addEventListener = function () {};
  QuietEventSource.prototype.removeEventListener = function () {};
  QuietEventSource.prototype.close = function () { this.readyState = 2; };
  window.EventSource = QuietEventSource;

  // ---- links that lead out of the demo ------------------------------------------------------------------------------
  var toastTimer = 0;
  function toast(message) {          // the same toast element and style as Citadel's own (util.js)
    var el = document.getElementById('toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; el.setAttribute('role', 'status'); document.body.append(el); }
    el.textContent = message;
    el.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('is-on'); }, 5000);
  }
  // A small notice in the middle of the screen, dismissed by its button, Esc or a click outside it (demo.css).
  function popup(title, message) {
    var d = document.createElement('dialog');
    d.className = 'demo-pop';
    d.innerHTML = '<b></b><p></p><button type="button" class="btn">OK</button>';
    d.querySelector('b').textContent = title;
    d.querySelector('p').textContent = message;
    d.querySelector('button').addEventListener('click', function () { d.close(); });
    d.addEventListener('click', function (ev) { if (ev.target === d) d.close(); });
    d.addEventListener('close', function () { d.remove(); });
    document.body.append(d);
    d.showModal();
    d.querySelector('button').focus();
  }
  document.addEventListener('click', function (e) {
    if (!e.target.closest) return;
    var vnc = e.target.closest('[data-vnc], [data-vnc-close]');
    if (vnc) { e.preventDefault(); e.stopPropagation(); popup('Remote access', 'Remote access to networked devices is not available in the Demo'); return; }
    var a = e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href');
    // Redacted bookmarks, and the Launchpad tiles of apps that only exist on the home network (their address was
    // removed: "#"). Inside Settings: a link to a dashboard page goes to that page of the dashboard around it.
    if (href.indexOf('https://redacted/') === 0) { e.preventDefault(); e.stopPropagation(); toast('Bookmarks are redacted in the online demo'); }
    else if (href.indexOf('/#') === 0 && window.parent !== window) { e.preventDefault(); e.stopPropagation(); window.parent.location.hash = href.slice(1); }
    else if (href === '/tv') { e.preventDefault(); e.stopPropagation(); toast('The TV screen isn’t part of the online demo'); }
    else if (href === '#' && a.target === '_blank') { e.preventDefault(); e.stopPropagation(); toast('That app runs on my home network only — ' + NOT_HERE.toLowerCase()); }
  }, true);
})();

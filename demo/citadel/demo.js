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
  var SNAPSHOT = 1795039924741;
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
  // ---- Fleet: made-up readings for the machines in data/fleet.json --------------------------------------------------
  // Real readings never leave the house. Each machine gets a believable history from a fixed seed (Mike's PC busier in
  // the evenings, the odd high-CPU moment), worked out for whatever range is asked, so a range always draws the same
  // and the 1 hour and 1 year views agree. Shapes match the stats collector's (collector/citadel_collector.py).
  var fleet = null;
  function machines() {
    if (!fleet) fleet = saved('fleet').then(function (t) { return t ? JSON.parse(t).machines : []; });
    return fleet;
  }
  function hash(a, b) {              // 0..1 from two integers
    var h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function seedOf(m) { var s = 7; for (var i = 0; i < m.id.length; i++) s = (Math.imul(s, 31) + m.id.charCodeAt(i)) | 0; return s; }
  function noise(seed, t, period) {  // smooth 0..1
    var x = t / period, i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
    return hash(seed, i) * (1 - u) + hash(seed, i + 1) * u;
  }
  function evening(seed, t) {        // 0..1: an evening at the PC (18:00 to midnight, most nights)
    var d = new RealDate(t * 1000), h = d.getHours() + d.getMinutes() / 60;
    if (h < 18) return 0;
    var day = Math.floor((t - h * 3600) / 86400);
    return hash(seed + 5, day) < 0.75 ? Math.sin(Math.PI * (h - 18) / 6) * (0.7 + 0.3 * noise(seed + 6, t, 1800)) : 0;
  }
  function spikeIn(m, seed, hour) {  // the high-CPU moment starting in this hour, if any
    if (hash(seed + 90, hour) >= (m.p.spikes || 0) / 24) return null;
    var start = hour * 3600 + Math.floor(hash(seed + 91, hour) * 100) * 30, dur = 60 + Math.floor(hash(seed + 92, hour) * 8) * 30;
    return { start: start, end: start + dur, peak: Math.round(62 + hash(seed + 93, hour) * 36), hour: hour };
  }
  function cpuBase(m, seed, t) {
    var p = m.p;
    var n = noise(seed + 1, t, 900), slot = Math.floor(t / 1200);
    var busy = hash(seed + 10, slot) < 0.07 ? 8 + hash(seed + 11, slot) * 24 : 0;    // now and then a busy twenty minutes
    return p.cpu * (0.3 + 1.6 * n * n) + busy + (p.evening || 0) * evening(seed, t) + p.cpu * 0.8 * (hash(seed + 2, Math.floor(t / 30)) - 0.5);
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function r1(v) { return v == null ? null : Math.round(v * 10) / 10; }
  function sleptAt(now) { return now - 95 * 60; }
  // one bucket [t, t + b): average and peak of every figure the machine reports
  function bucket(m, seed, t, b) {
    var p = m.p, n = Math.max(1, Math.min(8, Math.ceil(b / 1800))), cpu = 0, ev = 0;
    for (var i = 0; i < n; i++) { var x = t + (i + 0.5) * b / n; cpu += cpuBase(m, seed, x); ev += evening(seed, x); }
    cpu /= n; ev /= n;
    var peak = cpu * (1.2 + 0.5 * hash(seed + 3, t)), extra = 0;
    for (var h = Math.floor((t - 600) / 3600); h <= Math.floor((t + b) / 3600); h++) {
      var s = spikeIn(m, seed, h);
      if (!s) continue;
      var over = Math.min(s.end + 30, t + b) - Math.max(s.start, t);
      if (over <= 0) continue;
      extra += (s.peak - cpu) * over / b; peak = Math.max(peak, s.peak);
    }
    cpu = clamp(cpu + extra, 0, 100); peak = clamp(Math.max(peak, cpu), 0, 100);
    var out = { cpu: [cpu, peak], mem: [clamp(p.mem + (noise(seed + 4, t, 14400) - 0.5) * 6, 0, 100), 0], swap: [clamp((p.swap || 0) + (noise(seed + 7, t, 21600) - 0.5) * 2, 0, 100), 0] };
    out.mem[1] = out.mem[0] + 1.5; out.swap[1] = out.swap[0] + 0.5;
    if (p.temp != null) { var tc = p.temp + p.temp_k * cpu * 1.2 + (noise(seed + 8, t, 2400) - 0.5) * 7; out.cpu_temp = [tc, tc + p.temp_k * (peak - cpu) + 1]; }
    if (m.gpu) {
      var g = clamp((p.gpu || 0) * (0.4 + noise(seed + 9, t, 900)) + (p.gpu_evening || 0) * ev, 0, 100);
      out.gpu = [g, clamp(g * 1.25 + 2, 0, 100)];
      out.gpu_temp = [p.gpu_temp + 0.45 * g, p.gpu_temp + 0.45 * out.gpu[1] + 1];
    }
    return out;
  }
  function nowS() { return Math.floor(DemoDate.now() / 1000); }
  function series(m, frm, to) {
    var now = nowS(), seed = seedOf(m), span = Math.max(1, to - frm);
    var res = span <= 2 * 86400 ? 30 : span <= 45 * 86400 ? 300 : 3600, b = res * Math.max(1, Math.ceil(span / 600 / res));
    var out = { machine: m.id, from: frm, to: to, res: res, bucket: b, t: [], n: [], metrics: {} };
    var names = ['cpu', 'mem', 'swap', 'cpu_temp', 'gpu', 'gpu_temp'];
    names.forEach(function (k) { out.metrics[k] = { avg: [], max: [] }; });
    for (var t = Math.floor(frm / b) * b; t < to && t <= now; t += b) {
      if (!m.up && t >= sleptAt(now)) break;
      var v = bucket(m, seed, t, b);
      out.t.push(t); out.n.push(Math.round(b / 30));
      names.forEach(function (k) { out.metrics[k].avg.push(v[k] ? r1(v[k][0]) : null); out.metrics[k].max.push(v[k] ? r1(v[k][1]) : null); });
    }
    names.forEach(function (k) { if (!out.metrics[k].avg.some(function (x) { return x != null; })) delete out.metrics[k]; });
    return out;
  }
  function spikes(m, frm, to) {
    var now = nowS(), seed = seedOf(m), list = [];
    for (var h = Math.floor(frm / 3600) - 1; h <= Math.floor(to / 3600); h++) {
      var s = spikeIn(m, seed, h);
      if (!s || s.start < frm || s.start >= to || s.end > now || (!m.up && s.start >= sleptAt(now))) continue;
      var procs = m.p.procs || ['python3'], first = Math.floor(hash(seed + 94, h) * procs.length), top = [];
      for (var i = 0; i < Math.min(3, procs.length); i++) {
        top.push({ name: procs[(first + i) % procs.length], percent: r1(i === 0 ? s.peak * (0.55 + 0.2 * hash(seed + 99, h)) : s.peak * (0.15 / (i + 1)) * (1 + hash(seed + 95 + i, h))) });
      }
      list.push({ start: s.start, end: s.end, peak: s.peak, readings: (s.end - s.start) / 30 + 1, top: top });
    }
    return { machine: m.id, spikes: list.reverse().slice(0, 200) };
  }
  function disks(m, frm, to) {
    var now = nowS(), seed = seedOf(m), b = 3600 * Math.max(1, Math.ceil((to - frm) / 600 / 3600)), mounts = {};
    (m.disks || []).forEach(function (d, j) {
      var mt = { t: [], free: [], total: [] }, perDay = d[1] * 0.0004;
      for (var t = Math.floor(frm / b) * b; t < to && t <= now; t += b) {
        mt.t.push(t); mt.total.push(Math.round(d[1]));
        mt.free.push(Math.round(clamp(d[2] + (now - t) / 86400 * perDay + (noise(seed + 20 + j, t, 86400) - 0.5) * d[1] * 0.002, 0, d[1])));
      }
      mounts[d[0]] = mt;
    });
    return { machine: m.id, from: frm, to: to, bucket: b, mounts: mounts };
  }
  function latest(m) {               // the reading a machine's chip and Monitoring panel show
    var now = nowS(), at = m.up ? now : sleptAt(now), v = bucket(m, seedOf(m), at - 30, 30), memUsed = Math.round(m.mem * v.mem[0] / 100);
    var cpu = r1(v.cpu[0]), st = {
      v: 1, os: m.os, uptime_s: m.uptime_s, load: m.os.indexOf('Windows') === 0 ? [] : [0, 1, 2].map(function (i) { return r1(m.cores * cpu / 100 * (1 + i * 0.1) + 0.2); }),
      cpu: { percent: cpu, cores: m.cores, temp: v.cpu_temp ? r1(v.cpu_temp[0]) : null },
      mem: { total: Math.round(m.mem), used: memUsed, available: Math.round(m.mem) - memUsed, swap_total: Math.round(m.swap), swap_used: Math.round(m.swap * v.swap[0] / 100), buffers: 0, cached: Math.round((m.mem - memUsed) * 0.6) },
      disks: (m.disks || []).map(function (d) { return { mount: d[0], total: Math.round(d[1]), free: Math.round(d[2]) }; }),
      gpu: m.gpu ? { name: m.gpu.name, percent: r1(v.gpu[0]), temp: r1(v.gpu_temp[0]), mem_used_mb: Math.round(m.gpu.mem_total_mb * (0.05 + v.gpu[0] / 250)), mem_total_mb: m.gpu.mem_total_mb } : null,
      battery: m.battery || null, pi: m.pi || null,
      top: (m.p.procs || []).slice(0, 3).map(function (n, i) { return { name: n, percent: r1(cpu * (0.5 / (i + 1))) }; })
    };
    if (m.raid) st.raid = m.raid;
    if (m.os.indexOf('Windows') === 0) st.drive_temps = [];
    return { at: at, stats: st };
  }
  function fleetReply(url) {
    var path = url.pathname.replace(/^.*\/api\/owner/, ''), q = url.searchParams;
    return machines().then(function (list) {
      if (path === '/machines' || path === '/stats/machines') {
        var rows = list.filter(function (m) { return path === '/stats/machines' || m.rid != null; }).map(function (m) {
          var l = latest(m);
          return { id: path === '/machines' ? m.rid : m.id, name: m.name, up: m.up, always_on: m.always_on, at: l.at, stats: l.stats, error: null };
        });
        return reply(200, path === '/machines' ? { machines: rows } : { machines: rows, collector: { ok: true, error: null, at: nowS() } });
      }
      var m = list.find(function (x) { return x.id === q.get('machine'); }), frm = +q.get('start'), to = +q.get('end');
      if (!m || !(to > frm)) return reply(503, { detail: 'That isn’t a history Citadel can ask for' });
      var kind = path.split('/').pop();
      return reply(200, kind === 'series' ? series(m, frm, to) : kind === 'spikes' ? spikes(m, frm, to) : disks(m, frm, to));
    });
  }

  window.fetch = function (input, init) {
    var url;
    try { url = new URL(typeof input === 'string' ? input : input.url, location.href); } catch (e) { return realFetch(input, init); }
    if (url.origin !== location.origin || url.pathname.indexOf('/api/') !== 0) return realFetch(input, init);
    var method = String((init && init.method) || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    // 409, not 403: Citadel's api.js reloads the page on a 403 (it means "this device was revoked").
    if (method !== 'GET') return reply(409, { detail: READ_ONLY });
    if (/\/api\/owner\/(machines|stats\/(machines|series|spikes|disks))$/.test(url.pathname)) return fleetReply(url);
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
    var vnc = e.target.closest('[data-vnc], [data-vnc-close], [data-wake]');
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

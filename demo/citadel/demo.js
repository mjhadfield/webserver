// Citadel online demo: runs before anything else on the page and turns the dashboard into a frozen, read-only snapshot.
// Written by tools/build_demo.py (the snapshot time below is filled in by the build). Nothing here talks to a server:
//  - the clock reads the visitor's own time of day, on the day the snapshot was taken, so "tomorrow", bin days and
//    countdowns read the way they did that day however long ago it was built (and it isn't forever 3am);
//  - /api/* GETs are answered from the saved JSON in data/ (anything not saved says so), every change is refused;
//  - the event stream is a stub that "connects" and then never says anything changed;
//  - it opens in LCARS 25 at Night (Standard style; the header buttons still switch, and a visitor's own pick is kept);
//  - redacted bookmarks and Remote Access say they aren't part of the demo; Settings is a read-only snapshot
//    (settings.html, which loads this file too).
(function () {
  'use strict';
  var SNAPSHOT = 1795829891772;
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

  // ---- first visit: LCARS 25 at Night, Standard style (theme-init.js reads these next). The website's ?theme= is ignored.
  // DEFAULTS_V moves visitors of an older build onto the new default once; their own later picks are kept.
  var DEFAULTS_V = '4';
  try {
    if (localStorage.getItem('demo-defaults') !== DEFAULTS_V) {
      localStorage.setItem('mode', 'night'); localStorage.setItem('theme', 'lcars25'); localStorage.setItem('style', 'standard');
      localStorage.removeItem('style-spec'); localStorage.removeItem('style-by-family');
      localStorage.removeItem('look'); localStorage.removeItem('look-spec');
      localStorage.setItem('demo-defaults', DEFAULTS_V);
    }
  } catch (e) {
    // storage blocked: theme-init.js can't read anything either, so put LCARS 25 on the page by hand
    document.documentElement.dataset.mode = 'night';
    document.documentElement.dataset.theme = 'lcars25';
    document.documentElement.dataset.family = 'lcars';
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
          var row = { id: path === '/machines' ? m.rid : m.id, name: m.name, up: m.up, always_on: m.always_on, at: l.at, stats: l.stats, error: null };
          if (path === '/stats/machines') row.spec = m.spec || null;
          return row;
        });
        return reply(200, path === '/machines' ? { machines: rows } : { machines: rows, collector: { ok: true, error: null, at: nowS() } });
      }
      var m = list.find(function (x) { return x.id === q.get('machine'); }), frm = +q.get('start'), to = +q.get('end');
      if (!m || !(to > frm)) return reply(503, { detail: 'That isn’t a history Citadel can ask for' });
      var kind = path.split('/').pop();
      return reply(200, kind === 'series' ? series(m, frm, to) : kind === 'spikes' ? spikes(m, frm, to) : disks(m, frm, to));
    });
  }

  // ---- Controls: interactive in-memory sandbox over data/controls.json (nothing leaves the browser) -----------------
  var demoCtrl = null;
  function ctrlState() {
    if (!demoCtrl) demoCtrl = saved('controls').then(function (t) { return t ? JSON.parse(t) : null; });
    return demoCtrl;
  }
  function ctrlSummary(st) {
    var on = 0, total = 0, roomsOn = 0;
    (st.rooms || []).forEach(function (r) {
      if (r.lights && r.lights.length) {
        total += r.lights.length;
        on += r.lights.filter(function (b) { return b.on; }).length;
      } else {
        total += 1;
        if (r.on) on += 1;
      }
      if (r.on) roomsOn += 1;
    });
    st.summary = { on: on, total: total, rooms_on: roomsOn, rooms_total: (st.rooms || []).length };
  }
  function ctrlApply(item, body) {
    if (body.on === false) { item.on = false; return; }
    item.on = true;
    if (body.brightness != null) item.brightness = body.brightness;
    else if (!item.brightness && item.supports && item.supports.brightness) item.brightness = 100;
    if (body.kelvin != null) { item.color_mode = 'color_temp'; item.color_temp_kelvin = body.kelvin; item.rgb = null; }
    if (body.rgb != null) { item.color_mode = 'xy'; item.rgb = body.rgb.slice(0, 3); item.color_temp_kelvin = null; }
  }
  function controlsReply(url, method, init) {
    var sub = url.pathname.replace(/^\/api\/owner\/controls/, '');
    return ctrlState().then(function (st) {
      if (!st) return reply(503, { detail: NOT_HERE });
      if (method === 'GET' && !sub) return reply(200, st);
      if (method === 'PUT' && sub === '/order') {
        var ob = {};
        try { ob = init && init.body ? JSON.parse(init.body) : {}; } catch (e) {}
        var ord = Array.isArray(ob.order) ? ob.order : [];
        st.rooms.sort(function (a, b) {
          var ia = ord.indexOf(a.entity_id), ib = ord.indexOf(b.entity_id);
          return (ia < 0 ? 1e6 : ia) - (ib < 0 ? 1e6 : ib);
        });
        return reply(200, { ok: true, order: ord });
      }
      if (method !== 'POST') return reply(409, { detail: READ_ONLY });
      var body = {};
      try { body = init && init.body ? JSON.parse(init.body) : {}; } catch (e) {}
      if (sub === '/all-off') {
        var n = 0;
        (st.rooms || []).forEach(function (r) {
          if (r.on) n += 1;
          r.on = false;
          (r.lights || []).forEach(function (b) { b.on = false; });
        });
        ctrlSummary(st);
        return reply(200, { ok: true, turned_off: n });
      }
      if (sub.indexOf('/light/') === 0) {
        var eid = decodeURIComponent(sub.slice('/light/'.length));
        var room = (st.rooms || []).find(function (r) { return r.entity_id === eid; });
        if (room) {
          ctrlApply(room, body);
          (room.lights || []).forEach(function (b) { ctrlApply(b, body); });
          ctrlSummary(st);
          return reply(200, { ok: true });
        }
        var owner = (st.rooms || []).find(function (r) { return (r.lights || []).some(function (b) { return b.entity_id === eid; }); });
        if (owner) {
          var bulb = owner.lights.find(function (b) { return b.entity_id === eid; });
          ctrlApply(bulb, body);
          var lit = owner.lights.filter(function (b) { return b.on; });
          owner.on = lit.length > 0;
          if (lit.length) owner.brightness = Math.round(lit.reduce(function (s, b) { return s + (b.brightness || 100); }, 0) / lit.length);
          ctrlSummary(st);
          return reply(200, { ok: true });
        }
        return reply(404, { detail: 'No such light' });
      }
      if (sub.indexOf('/scene/') === 0) {
        var seid = decodeURIComponent(sub.slice('/scene/'.length));
        var presets = { relax: { brightness: 50, kelvin: 2400 }, concentrate: { brightness: 100, kelvin: 4800 },
                        energise: { brightness: 100, kelvin: 5800 }, nightlight: { brightness: 15, kelvin: 2100 },
                        cinema: { brightness: 25, rgb: [110, 62, 220] }, dimmed: { brightness: 30, kelvin: 2500 },
                        bright: { brightness: 100, kelvin: 3500 }, morning: { brightness: 75, kelvin: 5500 },
                        read: { brightness: 80, kelvin: 3200 }, savanna: { brightness: 65, rgb: [255, 118, 52] } };
        var sroom = (st.rooms || []).find(function (r) { return (r.scenes || []).some(function (sc) { return sc.entity_id === seid; }); });
        if (!sroom) return reply(404, { detail: 'No such scene' });
        var sc = sroom.scenes.find(function (x) { return x.entity_id === seid; });
        var p = presets[String(sc.name || '').toLowerCase()] || { brightness: 70, kelvin: 3000 };
        ctrlApply(sroom, p);
        (sroom.lights || []).forEach(function (b) { ctrlApply(b, p); });
        ctrlSummary(st);
        return reply(200, { ok: true });
      }
      return reply(409, { detail: READ_ONLY });
    });
  }

  // ---- PADD (in-memory demo sandbox; zero personal data ever exported) -----------------------------------------
  var paddState = null;
  function paddEnsure() {
    if (paddState) return paddState;
    var now = Math.floor(DemoDate.now() / 1000);
    paddState = {
      drops: [
        {
          id: 'demo-link-1', kind: 'link', title: 'FastAPI — Modern Python Web Framework',
          body: 'https://fastapi.tiangolo.com/', url: 'https://fastapi.tiangolo.com/',
          url_host: 'fastapi.tiangolo.com',
          url_description: 'FastAPI framework, high performance, easy to learn, fast to code, ready for production.',
          file_name: null, stored_name: null, mime_type: '', size_bytes: 0, sha256: '',
          device_id: 'demo', device_name: 'Phone', pinned: true, can_inline: false,
          can_zebralab_doc: false, can_zebralab_asset: false, created_at: now - 1400, updated_at: now - 1400
        },
        {
          id: 'demo-code-1', kind: 'code', title: 'Check systemd unit logs',
          body: 'journalctl --user -u hub -n 40 --no-pager\nsystemctl --user status hub',
          url: null, url_host: '', url_description: '',
          file_name: null, stored_name: null, mime_type: '', size_bytes: 0, sha256: '',
          device_id: 'demo', device_name: 'Laptop CLI', pinned: false, can_inline: false,
          can_zebralab_doc: false, can_zebralab_asset: false, created_at: now - 4200, updated_at: now - 4200
        },
        {
          id: 'demo-text-1', kind: 'text', title: '',
          body: 'Remember to pick up thermal 4x6 labels before Friday.',
          url: null, url_host: '', url_description: '',
          file_name: null, stored_name: null, mime_type: '', size_bytes: 0, sha256: '',
          device_id: 'demo', device_name: 'Desktop', pinned: false, can_inline: false,
          can_zebralab_doc: false, can_zebralab_asset: false, created_at: now - 9600, updated_at: now - 9600
        }
      ],
      notes: [
        {
          id: 'demo-note-1', title: 'Gig night checklist', kind: 'checklist',
          body: '- [x] Tickets downloaded offline\n- [x] Earplugs in jacket pocket\n- [ ] Portable charger topped up\n- [ ] Check last train home',
          tags: ['gigs', 'packing'], pinned: true, archived: false, device_name: 'Phone',
          check_done: 2, check_total: 4, created_at: now - 86400, updated_at: now - 3600
        },
        {
          id: 'demo-note-2', title: 'Homelab scratchpad', kind: 'note',
          body: '# Quick notes\n\nEverything in **PADD** syncs live across enrolled devices over the home network.\n\n```bash\npadd "https://example.com"\njournalctl -n 20 | padd --code\n```\n\n- [ ] Test nightly backup restore\n- [x] Label network switch ports',
          tags: ['homelab'], pinned: false, archived: false, device_name: 'Desktop',
          check_done: 1, check_total: 2, created_at: now - 172800, updated_at: now - 7200
        }
      ],
      lists: [
        {
          entity_id: 'todo.shopping_list', name: 'Shopping list', supported_features: 15, open_count: 3,
          items: [
            { uid: 'd1', summary: 'Coffee beans', status: 'needs_action', due: null, description: '' },
            { uid: 'd2', summary: 'Oat milk', status: 'needs_action', due: null, description: '' },
            { uid: 'd3', summary: 'AA batteries', status: 'needs_action', due: null, description: '' },
            { uid: 'd4', summary: 'Sourdough loaf', status: 'completed', due: null, description: '' }
          ]
        }
      ]
    };
    return paddState;
  }

  function paddNoteCounts(n) {
    var done = 0, total = 0;
    String(n.body || '').split('\n').forEach(function (ln) {
      var m = ln.match(/^\s*[-*]\s+\[([ xX])\]\s+/);
      if (m) { total++; if (m[1].toLowerCase() === 'x') done++; }
    });
    n.check_done = done; n.check_total = total;
  }

  function paddStorage(st) {
    return {
      used_bytes: st.drops.reduce(function (s, d) { return s + (d.size_bytes || 0); }, 0),
      cap_bytes: 5000000000, max_file_bytes: 500000000,
      file_count: st.drops.filter(function (d) { return !!d.stored_name; }).length,
      total_count: st.drops.length,
      pinned_count: st.drops.filter(function (d) { return !!d.pinned; }).length
    };
  }

  function paddReply(url, method, init) {
    var st = paddEnsure();
    var sub = url.pathname.slice('/api/owner/padd'.length);
    var body = {};
    if (init && typeof init.body === 'string' && init.body) { try { body = JSON.parse(init.body); } catch (e) {} }
    var now = Math.floor(DemoDate.now() / 1000);

    if (sub === '/drops' && method === 'GET') {
      return Promise.resolve(reply(200, { drops: st.drops, storage: paddStorage(st), device: { id: 'demo', name: 'Demo browser' }, zebralab_available: false }));
    }
    if (sub === '/drops' && method === 'POST') {
      var txt = String(body.text || '').trim();
      if (!txt) return Promise.resolve(reply(422, { detail: 'Nothing to drop.' }));
      var isUrl = /^https?:\/\/\S+$/i.test(txt);
      var kind = body.kind && body.kind !== 'auto' ? body.kind : (isUrl ? 'link' : 'text');
      var host = '';
      if (isUrl) { try { host = new URL(txt).hostname; } catch (e) {} }
      var drop = {
        id: 'demo-' + Math.random().toString(36).slice(2, 10), kind: kind, title: String(body.title || ''),
        body: txt, url: isUrl ? txt : null, url_host: host, url_description: '',
        file_name: null, stored_name: null, mime_type: '', size_bytes: 0, sha256: '',
        device_id: 'demo', device_name: 'Demo browser', pinned: !!body.pinned,
        can_inline: false, can_zebralab_doc: false, can_zebralab_asset: false, created_at: now, updated_at: now
      };
      st.drops.unshift(drop);
      return Promise.resolve(reply(201, { drop: drop, storage: paddStorage(st) }));
    }
    if (sub === '/drops/clear' && method === 'POST') {
      var before = st.drops.length;
      st.drops = st.drops.filter(function (d) { return d.pinned; });
      return Promise.resolve(reply(200, { removed: before - st.drops.length, freed_bytes: 0, storage: paddStorage(st) }));
    }
    var dm = sub.match(/^\/drops\/([^/]+)(\/.*)?$/);
    if (dm) {
      var did = decodeURIComponent(dm[1]), dact = dm[2] || '';
      var d = st.drops.find(function (x) { return x.id === did; });
      if (!d) return Promise.resolve(reply(404, { detail: 'Drop not found.' }));
      if (!dact && method === 'PATCH') {
        if (body.pinned !== undefined) d.pinned = !!body.pinned;
        if (body.title !== undefined) d.title = String(body.title);
        return Promise.resolve(reply(200, { drop: d, storage: paddStorage(st) }));
      }
      if (!dact && method === 'DELETE') {
        st.drops = st.drops.filter(function (x) { return x.id !== did; });
        return Promise.resolve(reply(200, { ok: true, storage: paddStorage(st) }));
      }
      if (dact === '/promote' && method === 'POST') {
        var pn = { id: 'demo-n-' + Math.random().toString(36).slice(2, 8), title: d.title || d.url_host || 'Saved drop',
          body: d.url || d.body, kind: 'note', tags: ['drop'], pinned: false, archived: false, device_name: 'Demo browser',
          check_done: 0, check_total: 0, created_at: now, updated_at: now };
        st.notes.unshift(pn);
        return Promise.resolve(reply(201, { note: pn }));
      }
      if (dact === '/ticket' && method === 'POST') {
        return Promise.resolve(reply(200, { drop_id: d.id, exp: now + 900, ttl: 900, share_url: location.origin + '/#padd', download_path: null,
          qr_svg: '<svg viewBox="0 0 24 24" width="180" height="180"><rect width="24" height="24" fill="#fff"/><path d="M3 3h7v7H3zm2 2v3h3V5zm9-2h7v7h-7zm2 2v3h3V5zM3 14h7v7H3zm2 2v3h3v-3zm9 0h3v3h-3zm4 4h3v1h-3z" fill="#111"/></svg>' }));
      }
      if (dact === '/revoke-share' && method === 'POST') return Promise.resolve(reply(200, { ok: true }));
    }
    if (sub === '/notes' && method === 'GET') {
      var arch = url.searchParams.get('archived') === '1';
      var list = st.notes.filter(function (n) { return !!n.archived === arch; });
      var tc = {};
      list.forEach(function (n) { (n.tags || []).forEach(function (t) { tc[t] = (tc[t] || 0) + 1; }); });
      var tags = Object.keys(tc).sort().map(function (k) { return { name: k, count: tc[k] }; });
      return Promise.resolve(reply(200, { notes: list, tags: tags }));
    }
    if (sub === '/notes' && method === 'POST') {
      var nn = { id: 'demo-n-' + Math.random().toString(36).slice(2, 8), title: body.title || 'Untitled note',
        body: body.body || '', kind: body.kind === 'checklist' ? 'checklist' : 'note', tags: body.tags || [],
        pinned: !!body.pinned, archived: false, device_name: 'Demo browser', check_done: 0, check_total: 0, created_at: now, updated_at: now };
      paddNoteCounts(nn);
      st.notes.unshift(nn);
      return Promise.resolve(reply(201, { note: nn }));
    }
    var nm = sub.match(/^\/notes\/([^/]+)(\/.*)?$/);
    if (nm) {
      var nid = decodeURIComponent(nm[1]), nact = nm[2] || '';
      var n = st.notes.find(function (x) { return x.id === nid; });
      if (!n) return Promise.resolve(reply(404, { detail: 'Note not found.' }));
      if (!nact && method === 'PATCH') {
        ['title', 'body', 'kind', 'tags', 'pinned', 'archived'].forEach(function (k) { if (body[k] !== undefined) n[k] = body[k]; });
        n.updated_at = now; paddNoteCounts(n);
        return Promise.resolve(reply(200, { note: n }));
      }
      if (!nact && method === 'DELETE') {
        st.notes = st.notes.filter(function (x) { return x.id !== nid; });
        return Promise.resolve(reply(200, { ok: true }));
      }
      if (nact === '/toggle-check' && method === 'POST') {
        var lines = String(n.body || '').split('\n'), idx = Number(body.line_index);
        if (lines[idx]) lines[idx] = lines[idx].replace(/\[([ xX])\]/, function (_, c) { return c.toLowerCase() === 'x' ? '[ ]' : '[x]'; });
        n.body = lines.join('\n'); n.updated_at = now; paddNoteCounts(n);
        return Promise.resolve(reply(200, { note: n }));
      }
      if (nact === '/checklist-action' && method === 'POST') {
        var ls = String(n.body || '').split('\n');
        n.body = body.action === 'reset'
          ? ls.map(function (ln) { return ln.replace(/^(\s*[-*]\s+)\[[xX]\]/, '$1[ ]'); }).join('\n')
          : ls.filter(function (ln) { return !/^\s*[-*]\s+\[[xX]\]/.test(ln); }).join('\n');
        n.updated_at = now; paddNoteCounts(n);
        return Promise.resolve(reply(200, { note: n }));
      }
    }
    if (sub === '/lists' && method === 'GET') {
      return Promise.resolve(reply(200, { available: true, error: null, lists: st.lists }));
    }
    var lm = sub.match(/^\/lists\/([^/]+)\/(items|items\/remove|clear-completed)$/);
    if (lm) {
      var eid = decodeURIComponent(lm[1]), lact = lm[2];
      var lst = st.lists.find(function (l) { return l.entity_id === eid; });
      if (!lst) return Promise.resolve(reply(404, { detail: 'Unknown list' }));
      if (lact === 'items' && method === 'POST') {
        lst.items.unshift({ uid: 'd-' + Math.random().toString(36).slice(2, 8), summary: String(body.summary || ''), status: 'needs_action', due: null, description: '' });
      } else if (lact === 'items' && method === 'PATCH') {
        var it = lst.items.find(function (i) { return (i.uid || i.summary) === body.item; });
        if (it) { if (body.status) it.status = body.status; if (body.rename) it.summary = body.rename; }
      } else if (lact === 'items/remove' && method === 'POST') {
        lst.items = lst.items.filter(function (i) { return (i.uid || i.summary) !== body.item; });
      } else if (lact === 'clear-completed' && method === 'POST') {
        lst.items = lst.items.filter(function (i) { return i.status !== 'completed'; });
      }
      lst.open_count = lst.items.filter(function (i) { return i.status !== 'completed'; }).length;
      return Promise.resolve(reply(200, { available: true, error: null, lists: st.lists }));
    }
    return Promise.resolve(reply(409, { detail: READ_ONLY }));
  }

  window.fetch = function (input, init) {
    var url;
    try { url = new URL(typeof input === 'string' ? input : input.url, location.href); } catch (e) { return realFetch(input, init); }
    if (url.origin !== location.origin || url.pathname.indexOf('/api/') !== 0) return realFetch(input, init);
    var method = String((init && init.method) || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    if (url.pathname === '/api/owner/controls' || url.pathname.indexOf('/api/owner/controls/') === 0) return controlsReply(url, method, init);
    if (url.pathname === '/api/owner/padd' || url.pathname.indexOf('/api/owner/padd/') === 0) return paddReply(url, method, init);
    // 409, not 403: Citadel's api.js reloads the page on a 403 (it means "this device was revoked").
    if (method !== 'GET') return reply(409, { detail: READ_ONLY });
    if (/\/api\/owner\/(machines|stats\/(machines|series|spikes|disks))$/.test(url.pathname)) return fleetReply(url);
    var key = keyOf(url);
    if (key === 'monitoring') return monitoring();
    if (key === 'audio_level') return reply(200, { level: -60 });
    if (url.pathname === '/api/owner/schedule') {
      return saved('schedule').then(function (text) {
        if (text === null) return reply(503, { detail: NOT_HERE });
        var sc = JSON.parse(text);
        var d = new DemoDate();
        sc.now = d.toISOString();
        return reply(200, sc);
      });
    }
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
    else if (href.indexOf('http://localhost:14564/') === 0) { e.preventDefault(); e.stopPropagation(); toast('The GoXLR utility runs on my PC only — ' + NOT_HERE.toLowerCase()); }
    else if (href.indexOf('/#') === 0 && window.parent !== window) { e.preventDefault(); e.stopPropagation(); window.parent.location.hash = href.slice(1); }
    else if (href === '/tv') { e.preventDefault(); e.stopPropagation(); toast('The TV screen isn’t part of the online demo'); }
    else if (href === '#' && a.target === '_blank') { e.preventDefault(); e.stopPropagation(); toast('That app runs on my home network only — ' + NOT_HERE.toLowerCase()); }
  }, true);
})();

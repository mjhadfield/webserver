// Runs before first paint: puts this device's mode (Day/Night), theme and style on the page straight away
// (see theme.js for the full story). A plain script, not a module, and a file rather than inline: CSP drops inline scripts.
try {
  var r = document.documentElement, ls = localStorage;
  // Ancient pre-`look` key ('dark' | 'light' | 'c:<id>'): only migrate when it holds an ancient value,
  // never when it holds one of the new theme ids ('citadel' | 'lcars' | 'lcars25' | 'borg').
  var oldTheme = ls.getItem('theme');
  if (oldTheme === 'light' || oldTheme === 'dark' || (oldTheme && oldTheme.indexOf('c:') === 0)) {
    if (ls.getItem('mode') === null) ls.setItem('mode', oldTheme === 'light' ? 'day' : 'night');
    ls.removeItem('theme'); ls.removeItem('theme-spec');
  }
  // One-time move from `look` / `look-spec` -> `theme`, `style`, `style-spec`.
  var oldLook = ls.getItem('look');
  if (oldLook !== null) {
    var oldSpec = null;
    try { oldSpec = JSON.parse(ls.getItem('look-spec') || 'null'); } catch (e) {}
    var mt = 'citadel', ms = 'standard', mspec = null;
    if (oldLook === 'lcars2') {
      mt = 'lcars25';
    } else if (oldLook === 'lcars' || oldLook === 'borg' || oldLook === 'citadel' || oldLook === 'lcars25') {
      mt = oldLook;
    } else if (oldLook.indexOf('c:') === 0) {
      var osk = oldSpec && oldSpec.skin;
      mt = osk === 'lcars2' ? 'lcars25' : (osk === 'lcars' || osk === 'borg' ? osk : 'citadel');
      ms = oldLook;
      if (oldSpec) {
        var mf = mt === 'lcars25' ? 'lcars' : mt;
        mspec = { family: mf, day: oldSpec.day, night: oldSpec.night };
      }
    }
    ls.setItem('theme', mt);
    ls.setItem('style', ms);
    if (mspec) ls.setItem('style-spec', JSON.stringify(mspec));
    else ls.removeItem('style-spec');
    ls.removeItem('look'); ls.removeItem('look-spec');
  }
  if (window.parent !== window) r.classList.add('in-frame');      // framed by the dashboard (Settings): no header of its own
  var m = ls.getItem('mode') === 'day' ? 'day' : 'night';
  var t = ls.getItem('theme') || 'citadel';
  if (t !== 'citadel' && t !== 'lcars' && t !== 'lcars25' && t !== 'borg') t = 'citadel';
  var f = t === 'lcars25' ? 'lcars' : t;
  r.dataset.mode = m;
  r.dataset.theme = t;
  r.dataset.family = f;
  // LCARS and Borg boot from the first paint so nothing flashes before animating in; app.js clears the class once filled
  if (f === 'lcars') r.classList.add('lc-boot');
  else if (f === 'borg') r.classList.add('brg-boot');
  var st = ls.getItem('style') || 'standard';
  if (st !== 'standard') {
    var sp = null;
    try { sp = JSON.parse(ls.getItem('style-spec') || 'null'); } catch (e) {}
    var h = sp && sp[m];
    if (h) {
      for (var k in h.vars) r.style.setProperty(k, h.vars[k]);
      if (h.bg) r.classList.add('has-bg');
      if (!h.glow) r.classList.add('no-glow');
    }
  }
  // LCARS screen overlay (Settings → Appearance → Overlay, this device's own; lcars.css): scanlines unless picked
  var ov = function () { var v = null; try { v = localStorage.getItem('lc-overlay'); } catch (e) {} if (v && v !== 'scan') r.dataset.lcOverlay = v; else delete r.dataset.lcOverlay; };
  ov();
  addEventListener('storage', function (e) { if (e.key === 'lc-overlay' || e.key === null) ov(); });
} catch (e) {}

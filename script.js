// The site: one terminal, hash routes (#/, #/cv, #/contact, #/projects, #/projects/<slug>).
// Home, CV and contact are static HTML in index.html (the CV and bio are baked in by the admin
// server); projects come from content/projects/*.json. Needs shared.js first.
(function () {
    'use strict';

    var MH = window.MH;
    var esc = MH.esc;
    var terminal = document.getElementById('terminal');
    var viewport = document.getElementById('viewport');
    var pathEl = document.getElementById('terminal-path');
    var barNav = document.getElementById('bar-nav');
    var closeBtn = document.getElementById('close-dot');
    var views = {};
    document.querySelectorAll('[data-view]').forEach(function (v) { views[v.dataset.view] = v; });

    var MOBILE = window.matchMedia('(max-width: 600px)');
    var REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)');
    var chrome = MH.initChrome();

    // ---------------------------------------------------------------------------------------
    // Project content. The index is small and fetched straight away; a write-up is fetched
    // when it's opened, then kept. Drafts are listed as "coming soon" cards (title, summary and
    // tags only) but never opened.
    // ---------------------------------------------------------------------------------------
    var projectIndex = null;
    var projects = {};
    function getJSON(url) {
        return fetch(url, { cache: 'no-cache' }).then(function (r) {
            if (!r.ok) throw new Error(r.status + ' ' + url);
            return r.json();
        });
    }
    var indexReady = getJSON('content/projects/index.json')
        .then(function (list) { projectIndex = list.filter(function (p) { return p.status === 'published' || p.status === 'draft'; }); })
        .catch(function () { projectIndex = null; });
    function loadProject(slug) {
        if (projects[slug]) return Promise.resolve(projects[slug]);
        return indexReady.then(function () {
            var listed = (projectIndex || []).some(function (p) { return p.slug === slug && p.status === 'published'; });
            if (!listed) return null;
            return getJSON('content/projects/' + encodeURIComponent(slug) + '.json').then(function (p) {
                projects[slug] = p;
                return p;
            });
        }).catch(function () { return null; });
    }

    function isDraft(slug) {
        return (projectIndex || []).some(function (p) { return p.slug === slug && p.status === 'draft'; });
    }

    function renderProjects() {
        var list = projectIndex;
        var live = (list || []).filter(function (p) { return p.status === 'published'; }).length;
        var soon = (list || []).length - live;
        views.projects.innerHTML =
            '<div class="proj-head">' + MH.cdBtn('#/', 'cd ~') +
            '<p class="section-label"><span class="prompt">$</span> ls -la ~/projects</p>' +
            '<p class="tagline">A collection of personal projects and GitHub repos. I wish I could take all of the credit, but Claude co-wrote an awful lot (from my schema!). I am not a developer, just an integration guy obsessed with numbers.' + '<span class="cursor">_</span></p>' +
            '</div>' +
            (list ? '<div class="proj-grid">' + list.map(function (p) {
                var draft = p.status === 'draft';
                // a draft: same tile, not a link -- no read permission yet (drwx------)
                var inner = '<span class="proj-card__ls">' + (draft ? 'drwx------' : 'drwxr-xr-x') + '  mike  ' + esc(p.updated) + '  <b>' + esc(p.slug) + '/</b></span>' +
                    '<span class="proj-card__title">' + esc(p.title) + '</span>' +
                    '<span class="proj-card__summary">' + esc(p.summary) + '</span>' +
                    '<span class="proj-card__foot">' + MH.tagsHtml(p.tags) +
                    (draft ? '<span class="proj-card__soon">coming soon</span>' : '<span class="proj-card__read">read &rarr;</span>') + '</span>';
                return draft ? '<div class="proj-card proj-card--draft" aria-label="' + esc(p.title) + ' — coming soon">' + inner + '</div>'
                    : '<a class="proj-card" href="#/projects/' + esc(p.slug) + '">' + inner + '</a>';
            }).join('') + '</div>' : '');
    }

    function renderArticle(slug, p) {
        views.article.innerHTML = p ? MH.articleHtml(p, '#/projects')
            : '<div class="terminal__body">' + MH.cdBtn('#/projects', 'cd ..') +
              '<p class="section-label"><span class="prompt">$</span> cat projects/' + esc(slug) + '/README.md</p>' +
              '<p class="tagline">' + (isDraft(slug) ? 'Permission denied — this write-up is still being written. Coming soon.' : 'No such project.') + '</p></div>';
        views.article.querySelectorAll('[data-open-fig]').forEach(function (btn) {
            btn.addEventListener('click', function () { openLightbox(p, btn.dataset.openFig, btn); });
        });
        watchLoopingVideos(views.article);
    }

    // "Play like a GIF" videos: muted loops that run only while on screen (no CPU spent on ones
    // scrolled out of view), and not at all for visitors who've asked for reduced motion.
    var loopWatcher = 'IntersectionObserver' in window ? new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
            if (en.isIntersecting && !REDUCED.matches) en.target.play().catch(function () { /* autoplay refused: stays on frame one */ });
            else en.target.pause();
        });
    }, { threshold: 0.25 }) : null;
    function watchLoopingVideos(root) {
        if (!loopWatcher) return;
        loopWatcher.disconnect();
        root.querySelectorAll('video[data-autoplay]').forEach(function (v) { loopWatcher.observe(v); });
    }

    // ---------------------------------------------------------------------------------------
    // Router + terminal resize
    // ---------------------------------------------------------------------------------------
    function parse(hash) {
        var parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
        if (parts[0] === 'projects' && parts[1]) {
            return { view: 'article', slug: decodeURIComponent(parts[1]), path: '~/projects/' + parts[1], up: '#/projects' };
        }
        var known = { cv: 'CV', contact: 'Contact', projects: 'Projects' };
        if (known[parts[0]]) return { view: parts[0], path: '~/' + parts[0], title: known[parts[0]] + ' — Mike Hadfield', up: '#/' };
        return { view: 'home', path: '~', title: 'Mike Hadfield' };
    }

    // gets a view's content ready (fetching if needed) before it's shown and measured
    function prepare(route) {
        if (route.view === 'projects') return indexReady.then(renderProjects);
        if (route.view === 'article') {
            return loadProject(route.slug).then(function (p) {
                route.title = (p ? p.title : isDraft(route.slug) ? 'Coming soon' : 'Not found') + ' — Mike Hadfield';
                renderArticle(route.slug, p);
            });
        }
        return Promise.resolve();
    }

    var current = null;
    var navSeq = 0;
    var cancelSwap = null;

    var HOST_LINK = '<a class="path-host" href="#/" title="Home" aria-label="mikehadfield — home">@mikehadfield</a>';

    function paintChrome(route) {
        var segs = route.path.split('/').slice(1), href = '#';
        // "@mikehadfield" is always a link home, whatever the page
        pathEl.innerHTML = 'visitor' + HOST_LINK + ':' + (segs.length ? '<a href="#/">~</a>' : '~') + segs.map(function (seg, i) {
            href += '/' + seg;
            return '/' + (i < segs.length - 1 ? '<a href="' + href + '">' + esc(seg) + '</a>' : esc(decodeURIComponent(seg)));
        }).join('');
        document.title = route.title;
        closeBtn.disabled = !route.up;   // the home page has nowhere further up to go
        windowLabels();
        barNav.querySelectorAll('a').forEach(function (a) {
            var on = a.dataset.route === route.view || (a.dataset.route === 'projects' && route.view === 'article');
            a.classList.toggle('is-current', on);
            if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
        });
    }

    function navigate(animate) {
        var route = parse(location.hash);
        var seq = ++navSeq;
        chrome.hideTip();
        chrome.closeBgMenu(false);
        prepare(route).then(function () {
            if (seq === navSeq) show(route, animate); // a newer navigation won
        });
    }

    function show(route, animate) {
        var from = current && views[current.view];
        var to = views[route.view];
        paintChrome(route);
        current = route;
        if (cancelSwap) { cancelSwap(); cancelSwap = null; }

        if (!animate || MOBILE.matches || REDUCED.matches || !from) {
            Object.keys(views).forEach(function (k) { views[k].hidden = views[k] !== to; });
            terminal.dataset.size = route.view;
            terminal.style.height = '';
            viewport.scrollTop = 0;
            if (animate) window.scrollTo(0, 0);
            return;
        }

        // 1. fade the old view out (120ms), 2. swap, 3. animate the terminal from its old size
        //    to the new view's size while the new view fades in. Only this one element's
        //    height/max-width transition -- no transforms on the page, no filters.
        var startH = terminal.offsetHeight;
        var cancelled = false;
        cancelSwap = function () { cancelled = true; };
        from.classList.add('view--leaving');
        setTimeout(function () {
            if (cancelled) return;
            cancelSwap = null;
            // every other view goes -- a click during the fade may have left one mid-leave
            Object.keys(views).forEach(function (k) {
                views[k].classList.remove('view--leaving', 'view--entering');
                views[k].hidden = views[k] !== to;
            });
            viewport.scrollTop = 0;

            // measure the new view at its final width, without animating
            terminal.style.transition = 'none';
            terminal.style.height = '';
            terminal.dataset.size = route.view;
            var endH = terminal.offsetHeight;
            terminal.style.height = startH + 'px';
            terminal.dataset.size = from.dataset.view;
            void terminal.offsetHeight; // commit the starting size
            terminal.style.transition = '';
            terminal.dataset.size = route.view;
            terminal.style.height = endH + 'px';

            to.classList.add('view--entering');
            var done = function () {
                terminal.style.height = '';
                to.classList.remove('view--entering');
            };
            terminal.addEventListener('transitionend', function handler(e) {
                if (e.target !== terminal) return;
                terminal.removeEventListener('transitionend', handler);
                done();
            });
            setTimeout(done, 400); // fallback when nothing changed size (no transitionend)
            var focusTarget = to.querySelector('h1, h2, .section-label');
            if (focusTarget) { focusTarget.setAttribute('tabindex', '-1'); focusTarget.focus({ preventScroll: true }); }
        }, 120);
    }

    window.addEventListener('hashchange', function () { navigate(true); });

    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        if (lb.open) return; // the dialog closes itself
        if (chrome.closePopups()) return;
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
        if (current && current.up) location.hash = current.up;
    });

    // red dot: up one level (article -> projects -> home)
    document.getElementById('close-dot').addEventListener('click', function () {
        if (current && current.up) location.hash = current.up;
    });

    // ---------------------------------------------------------------------------------------
    // Window controls. Yellow: minimise -- the window flies down to a tab docked at the bottom,
    // leaving an empty desk ("There's nothing else here..."); it stays minimised on every page
    // until the tab is clicked. Green, or a double-click on the title bar: maximise to the whole
    // browser window, with a tmux-style status line along the bottom. Both last for the visit.
    //
    // The movement is drawn as "zoom rectangles" -- a few bare outlines flying between the two
    // places, like the old Mac Finder -- rather than by moving the window itself: outlines are
    // cheap without a GPU, and the real window never gets a compositor layer of its own (that's
    // what drew the dark halo the terminal's load animation used to have; see .terminal).
    // ---------------------------------------------------------------------------------------
    var minDot = document.getElementById('min-dot');
    var maxDot = document.getElementById('max-dot');
    var dock = document.getElementById('dock');
    var dockTitle = document.getElementById('dock-title');
    var deskNote = document.getElementById('desk-note');
    var statusWin = document.getElementById('status-win');
    var statusClock = document.getElementById('status-clock');
    var WIN_KEY = 'mh-window';
    var winBusy = false;

    function isMin() { return document.body.classList.contains('is-min'); }
    function isMax() { return terminal.classList.contains('is-max'); }
    function saveWin() {
        try { sessionStorage.setItem(WIN_KEY, isMin() ? 'min' : isMax() ? 'max' : ''); } catch (e) { /* private mode: just this page */ }
    }

    // the dock tab and the status line name the current page, like the title bar does
    function windowLabels() {
        if (!dockTitle) return; // first paint happens before this block runs
        var path = pathEl.textContent;
        dockTitle.textContent = path;
        statusWin.textContent = '0:' + path.slice(path.indexOf(':') + 1) + '*';
    }
    function tickClock() {
        var d = new Date();
        statusClock.textContent = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }
    setInterval(function () { if (isMax()) tickClock(); }, 15000);

    function zoom(from, to, count, duration) {
        if (REDUCED.matches || !document.body.animate) return Promise.resolve();
        var box = function (r) { return { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' }; };
        var runs = [];
        for (var i = 0; i < count; i++) {
            var el = document.createElement('div');
            el.className = 'zoomrect';
            document.body.appendChild(el);
            var a = el.animate([Object.assign({ opacity: 0.9 }, box(from)), Object.assign({ opacity: 0.15 }, box(to))],
                { duration: duration, delay: i * 45, easing: 'cubic-bezier(0.45, 0, 0.2, 1)', fill: 'both' });
            runs.push(a.finished.then(function (anim) { return anim; }).finally(el.remove.bind(el)));
        }
        return Promise.all(runs).catch(function () { /* interrupted: nothing to tidy */ });
    }

    function setMax(on) {
        terminal.classList.toggle('is-max', on);
        document.body.classList.toggle('is-max', on);
        maxDot.setAttribute('aria-pressed', String(on));
        maxDot.title = on ? 'Restore size' : 'Maximise';
        maxDot.setAttribute('aria-label', on ? 'Restore the window size' : 'Maximise the window');
        if (on) tickClock();
    }
    function setMin(on) {
        document.body.classList.toggle('is-min', on);
        dock.hidden = !on;
        deskNote.hidden = !on;
    }

    function minimise() {
        if (winBusy || isMin()) return;
        winBusy = true;
        chrome.hideTip();
        chrome.closeBgMenu(false);
        var from = terminal.getBoundingClientRect();
        setMin(true);
        dock.style.visibility = 'hidden';
        dock.classList.remove('dock--arrived');
        zoom(from, dock.getBoundingClientRect(), 4, 340).then(function () {
            dock.style.visibility = '';
            dock.classList.add('dock--arrived');
            dock.focus({ preventScroll: true });
            winBusy = false;
        });
        saveWin();
    }
    function restore() {
        if (winBusy || !isMin()) return;
        winBusy = true;
        var from = dock.getBoundingClientRect();
        setMin(false);
        terminal.style.visibility = 'hidden';
        zoom(from, terminal.getBoundingClientRect(), 4, 340).then(function () {
            terminal.style.visibility = '';
            minDot.focus({ preventScroll: true });
            winBusy = false;
        });
        saveWin();
    }
    function toggleMax() {
        if (winBusy || isMin()) return;
        winBusy = true;
        chrome.hideTip();
        chrome.closeBgMenu(false);
        var from = terminal.getBoundingClientRect();
        setMax(!isMax());
        terminal.style.visibility = 'hidden';
        zoom(from, terminal.getBoundingClientRect(), 3, 240).then(function () {
            terminal.style.visibility = '';
            winBusy = false;
        });
        saveWin();
    }

    minDot.addEventListener('click', minimise);
    maxDot.addEventListener('click', toggleMax);
    dock.addEventListener('click', restore);
    document.querySelector('.terminal__bar').addEventListener('dblclick', function (e) {
        if (e.target.closest('a, button, nav')) return; // a double-click on a link or button is just that
        window.getSelection().removeAllRanges();
        toggleMax();
    });

    // carry on how the visit left it, without animating
    try {
        var savedWin = sessionStorage.getItem(WIN_KEY);
        if (savedWin === 'max') setMax(true);
        if (savedWin === 'min') setMin(true);
    } catch (e) { /* private mode */ }

    // ---------------------------------------------------------------------------------------
    // Image pop-out, full screen: the figure fitted to the window, its caption underneath, and
    // each numbered pin's note as a tooltip on hover / focus / tap. ←/→ through the figures. Click the image (or press Z) for 100% --
    // its real pixels, e.g. a 1440p screenshot on a 1080p screen -- then drag, scroll or swipe
    // to pan; click again to fit. Esc goes back to fit first, then closes. Pins sit in % of the
    // frame, which is always the image's exact shape, so they stay on their spots at any size.
    // Honestly it looks a bit janky on 1080p, but serves you right for living in 2010. 
    // ---------------------------------------------------------------------------------------
    var lb = document.getElementById('lightbox');
    var lbScroll = document.getElementById('lb-scroll');
    var lbFrame = document.getElementById('lb-frame');
    var lbZoom = document.getElementById('lb-zoom');
    var lbState = null;

    function openLightbox(project, figId, returnTo) {
        var ids = MH.figureIds(project.body, project.figures);
        lbState = { project: project, ids: ids, i: Math.max(0, ids.indexOf(figId)), returnTo: returnTo, zoomed: false };
        // opened from a playing video: pause it and carry on from the same moment, full screen
        var frame = returnTo && returnTo.closest('.fig__frame');
        var inline = frame && frame.querySelector('video');
        if (inline && !inline.hasAttribute('data-autoplay')) {
            lbState.resume = { at: inline.currentTime, play: !inline.paused };
            inline.pause();
        }
        lb.showModal();
        paintLightbox();
    }

    function paintLightbox() {
        var s = lbState;
        var fig = s.project.figures[s.ids[s.i]];
        s.w = +fig.w || 1600;
        s.h = +fig.h || 1000;
        s.zoomed = false;
        document.getElementById('lb-count').textContent = 'fig.' + (s.i + 1) + ' / ' + s.ids.length;
        document.getElementById('lb-title').textContent = fig.title || '';
        document.getElementById('lb-caption').textContent = fig.caption || '';
        s.video = MH.isVideo(fig.src);
        lbFrame.innerHTML = s.video
            ? '<video src="' + esc(fig.src) + '" controls playsinline preload="auto"' + (fig.loop ? ' loop' : '') + ' aria-label="' + esc(fig.alt || fig.title) + '"></video>'
            : '<img src="' + esc(fig.src) + '" alt="' + esc(fig.alt || fig.title) + '" width="' + s.w + '" height="' + s.h + '" draggable="false">' + MH.pinsHtml(fig.hotspots, true);
        if (s.video) {
            var vid = lbFrame.querySelector('video'), resume = s.resume;
            s.resume = null;
            if (resume) vid.currentTime = resume.at;
            if (fig.loop || (resume && resume.play)) vid.play().catch(function () { /* autoplay refused: press play */ });
        }
        chrome.hideTip();
        lb.querySelector('.lb__info').classList.toggle('is-empty', !fig.caption);
        document.getElementById('lb-prev').hidden = s.ids.length < 2;
        document.getElementById('lb-next').hidden = s.ids.length < 2;
        // trust the file over the stored size if they disagree (an image replaced outside the admin)
        var media = lbFrame.querySelector('img, video');
        media.addEventListener(s.video ? 'loadedmetadata' : 'load', function () {
            var nw = s.video ? media.videoWidth : media.naturalWidth, nh = s.video ? media.videoHeight : media.naturalHeight;
            if (nw && (nw !== s.w || nh !== s.h) && !/\.svg(\?|$)/i.test(fig.src)) {
                s.w = nw; s.h = nh;
                layoutLightbox();
            }
        });
        layoutLightbox();
    }

    // size the frame: fitted to the stage, or 1:1 (then optionally keep a point under the pointer)
    function layoutLightbox(anchor) {
        var s = lbState;
        lb.classList.remove('is-zoomed');
        var cs = getComputedStyle(lbScroll);
        var availW = lbScroll.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        var availH = lbScroll.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
        var fit = Math.min(availW / s.w, availH / s.h, 1);
        s.canZoom = fit < 0.995;
        if (!s.canZoom) s.zoomed = false;
        var scale = s.zoomed ? 1 : fit;
        lb.classList.toggle('is-zoomed', s.zoomed);
        lb.classList.toggle('can-zoom', s.canZoom && !s.zoomed && !s.video);
        lb.classList.toggle('is-video', !!s.video);
        lbFrame.style.width = Math.round(s.w * scale) + 'px';
        lbFrame.style.height = Math.round(s.h * scale) + 'px';
        // the bar's zoom button: also the way to 100% for a video, where a click belongs to its controls
        lbZoom.textContent = s.zoomed ? (s.video ? '100% · scroll to pan · back to fit' : '100% · drag to pan · click to fit')
            : s.canZoom ? 'fit ' + Math.round(fit * 100) + '% · ' + (s.video ? 'view at 100%' : 'click image for 100%') : '100%';
        lbZoom.disabled = !s.canZoom;
        if (s.zoomed) {
            if (anchor) { // the spot that was clicked stays under the pointer
                var r = lbScroll.getBoundingClientRect();
                lbScroll.scrollLeft = anchor.fx * s.w - (anchor.x - r.left);
                lbScroll.scrollTop = anchor.fy * s.h - (anchor.y - r.top);
            } else {
                lbScroll.scrollLeft = (s.w - lbScroll.clientWidth) / 2;
                lbScroll.scrollTop = (s.h - lbScroll.clientHeight) / 2;
            }
        } else {
            lbScroll.scrollLeft = 0;
            lbScroll.scrollTop = 0;
        }
    }

    function toggleZoom(e) {
        var s = lbState;
        if (!s || (!s.canZoom && !s.zoomed)) return;
        var anchor = null;
        if (e && !s.zoomed) {
            var r = lbFrame.getBoundingClientRect();
            anchor = { x: e.clientX, y: e.clientY, fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height };
        }
        s.zoomed = !s.zoomed;
        layoutLightbox(anchor);
    }

    // drag to pan at 100% (mouse; touch and wheel just scroll). A drag isn't a click.
    var drag = null, dragged = false;
    lbScroll.addEventListener('pointerdown', function (e) {
        dragged = false;
        if (!lbState || !lbState.zoomed || lbState.video || e.pointerType !== 'mouse' || e.button !== 0 || e.target.closest('.pin')) return;
        drag = { x: e.clientX, y: e.clientY, sl: lbScroll.scrollLeft, st: lbScroll.scrollTop, id: e.pointerId };
    });
    lbScroll.addEventListener('pointermove', function (e) {
        if (!drag) return;
        var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (!dragged && Math.abs(dx) + Math.abs(dy) > 4) {
            dragged = true;
            lbScroll.classList.add('is-dragging');
            lbScroll.setPointerCapture(drag.id);
        }
        if (dragged) {
            lbScroll.scrollLeft = drag.sl - dx;
            lbScroll.scrollTop = drag.st - dy;
        }
    });
    function endDrag() { drag = null; lbScroll.classList.remove('is-dragging'); }
    lbScroll.addEventListener('pointerup', endDrag);
    lbScroll.addEventListener('pointercancel', endDrag);
    lbZoom.addEventListener('click', function () { toggleZoom(null); });
    lbScroll.addEventListener('click', function (e) {
        if (dragged || e.target.closest('.pin') || lbState.video) return; // a video's clicks belong to its controls
        if (!e.target.closest('.lb__frame') && !lbState.zoomed) return; // the empty stage around a fitted image
        toggleZoom(e);
    });

    function step(d) {
        if (!lbState || lbState.ids.length < 2) return;
        lbState.i = (lbState.i + d + lbState.ids.length) % lbState.ids.length;
        paintLightbox();
    }

    document.getElementById('lb-prev').addEventListener('click', function () { step(-1); });
    document.getElementById('lb-next').addEventListener('click', function () { step(1); });
    document.getElementById('lb-close').addEventListener('click', function () { lb.close(); });
    lb.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowLeft') { step(-1); e.preventDefault(); }
        if (e.key === 'ArrowRight') { step(1); e.preventDefault(); }
        if (e.key === 'z' || e.key === 'Z') { toggleZoom(null); e.preventDefault(); }
    });
    lb.addEventListener('cancel', function (e) { // Esc: back to fit first, then close
        if (lbState && lbState.zoomed) { e.preventDefault(); toggleZoom(null); }
    });
    lb.addEventListener('close', function () {
        chrome.hideTip();
        lbFrame.innerHTML = ''; // stops a video
        if (lbState && lbState.returnTo) lbState.returnTo.focus();
    });
    window.addEventListener('resize', function () { if (lb.open && lbState) layoutLightbox(); });

    // ---------------------------------------------------------------------------------------
    // Contact form (Formspree). Honestly an amazing service. 
    // ---------------------------------------------------------------------------------------
    (function contact() {
        var form = document.getElementById('contact-form');
        var nameField = form.querySelector('input[name="name"]');
        var submitBtn = document.getElementById('submit-btn');
        var status = document.getElementById('form-status');
        var EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        var fields = [
            { el: nameField, validate: function (v) { return v.trim().length >= 3; } },
            { el: form.querySelector('input[name="email"]'), validate: function (v) { return EMAIL_PATTERN.test(v.trim()); } },
            { el: form.querySelector('textarea[name="message"]'), validate: function (v) { return v.trim().length >= 10; } }
        ];

        function validateField(f) {
            var ok = f.validate(f.el.value);
            f.el.classList.toggle('is-invalid', !ok);
            f.el.setAttribute('aria-invalid', ok ? 'false' : 'true');
            return ok;
        }
        function setStatus(text, variant) {
            status.textContent = text;
            status.className = 'form-status' + (variant ? ' form-status--' + variant : '');
        }
        function lockForm(locked) {
            for (var i = 0; i < form.elements.length; i++) form.elements[i].disabled = locked;
        }
        function showResetControl() {
            var reset = document.createElement('button');
            reset.type = 'button';
            reset.className = 'reset-btn';
            reset.textContent = 'send another message';
            reset.addEventListener('click', function () {
                form.reset();
                lockForm(false);
                fields.forEach(function (f) { f.el.classList.remove('is-invalid'); f.el.removeAttribute('aria-invalid'); });
                setStatus('');
                reset.remove();
                submitBtn.textContent = 'send message';
                nameField.focus();
            }, { once: true });
            status.insertAdjacentElement('afterend', reset);
        }

        fields.forEach(function (f) {
            f.el.addEventListener('blur', function () { validateField(f); });
            f.el.addEventListener('input', function () { if (f.el.classList.contains('is-invalid')) validateField(f); });
        });

        form.addEventListener('submit', function (e) {
            e.preventDefault();
            var bad = fields.filter(function (f) { return !validateField(f); });
            if (bad.length) {
                bad[0].el.focus();
                setStatus('Please check the highlighted fields.', 'error');
                return;
            }
            submitBtn.disabled = true;
            submitBtn.textContent = 'sending...';
            setStatus('');
            fetch(form.action, { method: 'POST', body: new FormData(form), headers: { Accept: 'application/json' } })
                .then(function (response) {
                    if (response.ok) {
                        lockForm(true);
                        submitBtn.textContent = 'sent ✓';
                        setStatus('Message sent — I’ll get back to you soon.', 'success');
                        showResetControl();
                        return;
                    }
                    return response.json().then(function (data) {
                        throw new Error((data && data.errors && data.errors[0] && data.errors[0].message) || 'Something went wrong — please try again.');
                    });
                })
                .catch(function (error) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'send message';
                    setStatus(error.message || 'Something went wrong — please try again.', 'error');
                });
        });
    })();

    // ---------------------------------------------------------------------------------------
    navigate(false);
})();

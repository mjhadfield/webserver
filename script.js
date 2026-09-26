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
            '<p class="tagline">' + (list ? live + ' write-up' + (live === 1 ? '' : 's') + (soon ? ' · ' + soon + ' coming soon' : '') + ' — how they work, why they exist, and what I learned'
                : 'couldn’t load the project list — try again in a moment') + '<span class="cursor">_</span></p>' +
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
        views.article.querySelectorAll('.fig__frame').forEach(function (btn) {
            btn.addEventListener('click', function () { openLightbox(p, btn.dataset.fig, btn); });
        });
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

    function paintChrome(route) {
        var segs = route.path.split('/').slice(1), href = '#';
        pathEl.innerHTML = 'visitor@mikehadfield:' + (segs.length ? '<a href="#/">~</a>' : '~') + segs.map(function (seg, i) {
            href += '/' + seg;
            return '/' + (i < segs.length - 1 ? '<a href="' + href + '">' + esc(seg) + '</a>' : esc(decodeURIComponent(seg)));
        }).join('');
        document.title = route.title;
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
    // Image pop-out: the figure large, its caption and numbered notes underneath, ←/→ through
    // the write-up's figures, Esc / backdrop to close. A pin and its note light up together.
    // ---------------------------------------------------------------------------------------
    var lb = document.getElementById('lightbox');
    var lbFrame = document.getElementById('lb-frame');
    var lbNotes = document.getElementById('lb-notes');
    var lbState = null;

    function openLightbox(project, figId, returnTo) {
        var ids = MH.figureIds(project.body, project.figures);
        lbState = { project: project, ids: ids, i: Math.max(0, ids.indexOf(figId)), returnTo: returnTo };
        paintLightbox();
        lb.showModal();
    }

    function paintLightbox() {
        var s = lbState;
        var fig = s.project.figures[s.ids[s.i]];
        document.getElementById('lb-count').textContent = 'fig.' + (s.i + 1) + ' / ' + s.ids.length;
        document.getElementById('lb-title').textContent = fig.title || '';
        document.getElementById('lb-caption').textContent = fig.caption || '';
        lbFrame.innerHTML = '<img src="' + esc(fig.src) + '" alt="' + esc(fig.alt || fig.title) + '" width="' + (+fig.w || 1600) + '" height="' + (+fig.h || 1000) + '">' + MH.pinsHtml(fig.hotspots, true);
        lbNotes.innerHTML = (fig.hotspots || []).map(function (h, i) {
            return '<li data-note="' + i + '" tabindex="0"><span class="num">' + (i + 1) + '</span><span>' + esc(h.note) + '</span></li>';
        }).join('');
        lbNotes.hidden = !(fig.hotspots || []).length;
        document.getElementById('lb-prev').hidden = s.ids.length < 2;
        document.getElementById('lb-next').hidden = s.ids.length < 2;
    }

    function step(d) {
        if (!lbState || lbState.ids.length < 2) return;
        lbState.i = (lbState.i + d + lbState.ids.length) % lbState.ids.length;
        paintLightbox();
    }

    function hot(i, on) {
        lb.querySelectorAll('[data-pin="' + i + '"], [data-note="' + i + '"]').forEach(function (el) { el.classList.toggle('is-hot', on); });
    }
    ['mouseover', 'focusin'].forEach(function (ev) {
        lb.addEventListener(ev, function (e) {
            var t = e.target.closest('[data-pin], [data-note]');
            if (t) hot(t.dataset.pin || t.dataset.note, true);
        });
    });
    ['mouseout', 'focusout'].forEach(function (ev) {
        lb.addEventListener(ev, function (e) {
            var t = e.target.closest('[data-pin], [data-note]');
            if (t) hot(t.dataset.pin || t.dataset.note, false);
        });
    });
    lb.addEventListener('click', function (e) {
        var pin = e.target.closest('[data-pin]');
        if (pin) {
            var note = lbNotes.querySelector('[data-note="' + pin.dataset.pin + '"]');
            if (note) { note.focus(); note.scrollIntoView({ block: 'nearest' }); }
        }
        if (e.target === lb) lb.close(); // click on the backdrop
    });
    document.getElementById('lb-prev').addEventListener('click', function () { step(-1); });
    document.getElementById('lb-next').addEventListener('click', function () { step(1); });
    document.getElementById('lb-close').addEventListener('click', function () { lb.close(); });
    lb.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowLeft') { step(-1); e.preventDefault(); }
        if (e.key === 'ArrowRight') { step(1); e.preventDefault(); }
    });
    lb.addEventListener('close', function () {
        if (lbState && lbState.returnTo) lbState.returnTo.focus();
    });

    // ---------------------------------------------------------------------------------------
    // Contact form (Formspree). Validates on blur, re-checks as you type once flagged.
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

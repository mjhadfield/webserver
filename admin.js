// Admin page: project write-ups (Markdown + figures with numbered pins), the CV section by
// section, and the home-page text. Saving goes through the local admin server
// (tools/admin_server.py); on the public site there's no server, so it opens read-only.
// Needs shared.js first.
(function () {
    'use strict';

    var MH = window.MH;
    var esc = MH.esc;
    var rootEl = document.getElementById('admin-root');
    var pathEl = document.getElementById('terminal-path');
    var chrome = MH.initChrome();

    var S = {
        mode: null,        // 'local' (admin server) | 'readonly' (anywhere else)
        authed: false,
        setup: false,      // no password chosen yet (first run)
        tab: 'projects',   // projects | cv | site
        index: [],         // content/projects/index.json
        editing: null,     // the project open in the editor (a working copy)
        savedSlug: null,   // its slug on disk (null until first saved)
        fig: null,         // figure selected in the figure manager
        cv: null,
        cvSec: 'header',
        site: null,
        dirty: false,
        busy: false,
        note: ''           // last save / error message, shown in the toolbar
    };
    var SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

    // The public copy has no server, so its log-in can only be checked here in the browser: a gate,
    // not security (the public admin is read-only anyway -- nothing can be saved without the local
    // server). Mike's choice: the password is "admin". Kept as a SHA-256 hash so it isn't sitting
    // in the source as plain text; a guessable password is guessable either way, which is the idea.
    var DEMO_PASSWORD_SHA256 = '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918';
    var DEMO_KEY = 'mh-admin-demo'; // sessionStorage: logged in until the tab closes
    function demoSession(on) {
        try {
            if (on === undefined) return sessionStorage.getItem(DEMO_KEY) === '1';
            if (on) sessionStorage.setItem(DEMO_KEY, '1'); else sessionStorage.removeItem(DEMO_KEY);
        } catch (e) { /* storage blocked: just log in again next time */ }
        return !!on;
    }
    function sha256Hex(text) {
        return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
            return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
        });
    }

    // ---------------------------------------------------------------------------------------
    // server + files
    // ---------------------------------------------------------------------------------------
    function getJSON(url) {
        return fetch(url + (url.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now(), { cache: 'no-store' }).then(function (r) {
            if (!r.ok) throw new Error('couldn’t load ' + url + ' (' + r.status + ')');
            return r.json();
        });
    }

    function api(method, url, body, raw) {
        var opts = { method: method, headers: { 'X-MH-Admin': '1' }, credentials: 'same-origin' };
        if (raw) { opts.body = raw; opts.headers['Content-Type'] = 'application/octet-stream'; }
        else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
        return fetch(url, opts).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (data) {
                if (r.status === 401 && url !== '/api/login') { S.authed = false; render(); }
                if (!r.ok) throw new Error(data.message || ('server said ' + r.status));
                return data;
            });
        });
    }

    function boot() {
        fetch('/api/status', { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .catch(function () { return null; })
            .then(function (st) {
                S.mode = st && st.local ? 'local' : 'readonly';
                S.authed = S.mode === 'readonly' ? demoSession() : !!(st && st.authed);
                S.setup = !!(st && st.setup);
                if (S.authed) return loadAll().then(render);
                render();
            });
    }

    function loadAll() {
        return Promise.all([getJSON('content/projects/index.json'), getJSON('content/cv.json'), getJSON('content/site.json')])
            .then(function (r) { S.index = r[0]; S.cv = r[1]; S.site = r[2]; })
            .catch(function (e) { S.note = e.message; });
    }

    // ---------------------------------------------------------------------------------------
    // unsaved changes
    // ---------------------------------------------------------------------------------------
    function markDirty() {
        if (S.dirty) return;
        S.dirty = true;
        var b = rootEl.querySelector('[data-act="save"]');
        if (b) b.textContent = 'save *';
    }
    function leaveOk() {
        return !S.dirty || window.confirm('You have unsaved changes — leave them?');
    }
    window.addEventListener('beforeunload', function (e) {
        if (S.dirty) { e.preventDefault(); e.returnValue = ''; }
    });

    // ---------------------------------------------------------------------------------------
    // shell
    // ---------------------------------------------------------------------------------------
    function render() {
        pathEl.textContent = 'mike@mikehadfield:~/admin' + (S.authed ? '/' + S.tab : '');
        if (!S.authed) return S.mode === 'local' && S.setup ? renderSetup() : renderLogin();
        var logout = '<span class="spacer"></span><button class="btn btn--small" type="button" data-act="logout">log out</button>';
        var banner = S.mode === 'readonly'
            ? '<div class="admin-banner">⚠ read-only demo — look around freely; nothing here can be saved.' + logout + '</div>'
            : '<div class="admin-banner admin-banner--ok">● local admin server — saving writes into this folder; commit &amp; push to publish.' + logout + '</div>';
        var tabs = '<div class="admin-tabs" role="tablist">' +
            [['projects', 'projects'], ['cv', 'cv'], ['site', 'home text']].map(function (t) {
                return '<button type="button" role="tab" data-tab="' + t[0] + '" aria-selected="' + (S.tab === t[0]) + '">' + t[1] + '</button>';
            }).join('') + '</div>';
        var body = S.tab === 'site' ? siteHtml() : S.tab === 'cv' ? cvEditorHtml() : S.editing ? editorHtml(S.editing) : tableHtml();
        rootEl.innerHTML = banner + '<div class="admin">' + tabs + body + '</div>';
        rootEl.querySelectorAll('[data-tab]').forEach(function (b) {
            b.addEventListener('click', function () {
                if (b.dataset.tab === S.tab && !S.editing) return;
                if (!leaveOk()) return;
                S.tab = b.dataset.tab; S.editing = null; S.dirty = false; S.note = '';
                if (S.tab !== 'projects') return reloadThen(render);
                render();
            });
        });
        var lo = rootEl.querySelector('[data-act="logout"]');
        if (lo) lo.addEventListener('click', function () {
            if (!leaveOk()) return;
            var done = function () { S.authed = false; S.dirty = false; S.editing = null; S.note = ''; render(); };
            if (S.mode === 'readonly') { demoSession(false); done(); }
            else api('POST', '/api/logout', {}).then(done);
        });
        if (S.tab === 'site') wireSite();
        else if (S.tab === 'cv') wireCv();
        else if (S.editing) wireEditor(S.editing);
        else wireTable();
        if (S.mode === 'readonly') {
            rootEl.querySelectorAll('[data-act="save"], [data-act="new"], [data-act="delete"], [data-act="up"], [data-act="down"], [data-act="add-fig"]').forEach(function (b) {
                b.disabled = true;
                b.title = 'Saving needs the local admin server';
            });
        }
    }

    // after switching tabs, re-read the files (another save may have changed them)
    function reloadThen(fn) {
        if (S.mode !== 'local' && S.cv) return fn();
        loadAll().then(fn);
    }

    function toolbar(cmd, extra) {
        return '<div class="admin-toolbar"><span class="section-label" style="margin:0"><span class="prompt">$</span> ' + esc(cmd) + '</span>' +
            '<span class="spacer"></span><span class="save-note' + (/^✕/.test(S.note) ? ' save-note--error' : '') + '" role="status">' + esc(S.note) + '</span>' + (extra || '') + '</div>';
    }

    function saving(promise, okNote) {
        S.busy = true;
        var b = rootEl.querySelector('[data-act="save"]');
        if (b) { b.disabled = true; b.textContent = 'saving…'; }
        return promise.then(function (r) {
            S.dirty = false;
            S.note = okNote + ' ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            return r;
        }).catch(function (e) {
            S.note = '✕ ' + e.message;
            throw e;
        }).finally(function () { S.busy = false; render(); });
    }

    // ---------------------------------------------------------------------------------------
    // login: checked by the local server, or -- on the public read-only copy -- in the browser
    // ---------------------------------------------------------------------------------------
    function renderLogin() {
        rootEl.innerHTML =
            '<div class="login">' + MH.cdBtn('index.html', 'cd ~') +
            '<p class="login__line"><span class="prompt">$</span>sudo admin</p>' +
            '<form data-role="login"><p class="login__line">[sudo] password for mike: ' +
            '<input type="password" id="admin-pw" autocomplete="current-password" aria-label="Admin password"></p></form>' +
            '<p class="login__hint" data-role="msg">' + esc(S.note || (S.mode === 'readonly'
                ? 'Read-only demo of the site’s admin area. It’s a demo — try the obvious password.'
                : 'Enter to log in. The password was chosen the first time the admin page opened.')) + '</p></div>';
        var pw = rootEl.querySelector('#admin-pw');
        rootEl.querySelector('[data-role="login"]').addEventListener('submit', function (e) {
            e.preventDefault();
            pw.disabled = true;
            var check = S.mode === 'readonly'
                ? (window.crypto && crypto.subtle ? sha256Hex(pw.value) : Promise.reject(new Error('this browser can’t check the password here')))
                    .then(function (h) {
                        if (h !== DEMO_PASSWORD_SHA256) {
                            return new Promise(function (res) { setTimeout(res, 400); }).then(function () { throw new Error('wrong password'); });
                        }
                        demoSession(true);
                    })
                : api('POST', '/api/login', { password: pw.value });
            check
                .then(function () { S.authed = true; S.note = ''; return loadAll(); })
                .then(render)
                .catch(function (err) {
                    S.note = '✕ ' + err.message;
                    renderLogin();
                });
        });
        pw.focus();
    }

    // first run: no password yet -- choose one here (the server only accepts this PC, and only
    // until a password exists)
    function renderSetup() {
        rootEl.innerHTML =
            '<div class="login">' + MH.cdBtn('index.html', 'cd ~') +
            '<p class="login__line"><span class="prompt">$</span>passwd mike</p>' +
            '<form data-role="setup">' +
            '<p class="login__line">New password: <input type="password" id="pw1" autocomplete="new-password" aria-label="New admin password"></p>' +
            '<p class="login__line">Retype new password: <input type="password" id="pw2" autocomplete="new-password" aria-label="Retype the password"></p>' +
            '<button type="submit" hidden>set</button></form>' +
            '<p class="login__hint" data-role="msg">' + esc(S.note || 'First run: choose the admin password, then Enter. It’s stored hashed in .admin-password, which never gets committed.') + '</p></div>';
        var pw1 = rootEl.querySelector('#pw1'), pw2 = rootEl.querySelector('#pw2');
        pw1.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); pw2.focus(); } });
        rootEl.querySelector('[data-role="setup"]').addEventListener('submit', function (e) {
            e.preventDefault();
            if (!pw1.value) { S.note = '✕ the password can’t be empty'; return renderSetup(); }
            if (pw1.value !== pw2.value) { S.note = '✕ they didn’t match — try again'; return renderSetup(); }
            api('POST', '/api/setup', { password: pw1.value })
                .then(function () { S.setup = false; S.authed = true; S.note = 'password set — you’re logged in'; return loadAll(); })
                .then(render)
                .catch(function (err) {
                    S.note = '✕ ' + err.message;
                    if (/already set/.test(err.message)) S.setup = false;
                    render();
                });
        });
        pw1.focus();
    }

    // ---------------------------------------------------------------------------------------
    // projects: the list
    // ---------------------------------------------------------------------------------------
    function tableHtml() {
        return toolbar('ls content/projects/', '<button class="btn btn--primary" type="button" data-act="new">+ new project</button>') +
            '<table class="admin-table"><thead><tr><th>project</th><th>status</th><th>updated</th><th>order</th><th></th></tr></thead><tbody>' +
            S.index.map(function (p, i) {
                return '<tr><td>' + esc(p.title) + ' <span class="dim">/' + esc(p.slug) + '</span></td>' +
                    '<td><span class="badge' + (p.status === 'draft' ? ' badge--draft' : '') + '">' + esc(p.status) + '</span></td>' +
                    '<td>' + esc(p.updated) + '</td>' +
                    '<td><button class="btn btn--small" type="button" data-act="up" data-i="' + i + '"' + (i === 0 ? ' disabled' : '') + ' aria-label="Move ' + esc(p.title) + ' up">↑</button> ' +
                    '<button class="btn btn--small" type="button" data-act="down" data-i="' + i + '"' + (i === S.index.length - 1 ? ' disabled' : '') + ' aria-label="Move ' + esc(p.title) + ' down">↓</button></td>' +
                    '<td class="row-actions"><button class="btn btn--small" type="button" data-edit="' + esc(p.slug) + '">edit</button> ' +
                    (p.status === 'published' ? '<a class="btn btn--small" href="index.html#/projects/' + esc(p.slug) + '" target="_blank" rel="noopener">view</a> ' : '') +
                    '<button class="btn btn--small btn--danger" type="button" data-act="delete" data-slug="' + esc(p.slug) + '">delete</button></td></tr>';
            }).join('') +
            (S.index.length ? '' : '<tr><td colspan="5" class="dim">No projects yet.</td></tr>') + '</tbody></table>' +
            '<p class="figman__hint" style="margin-top:12px">The order here is the order on the site. Drafts show there as a “coming soon” tile (title, summary and tags) that can’t be opened.</p>';
    }

    function wireTable() {
        rootEl.querySelectorAll('[data-edit]').forEach(function (b) {
            b.addEventListener('click', function () {
                getJSON('content/projects/' + encodeURIComponent(b.dataset.edit) + '.json').then(function (p) {
                    p.figures = p.figures || {};
                    S.editing = p; S.savedSlug = p.slug; S.fig = null; S.dirty = false; S.note = '';
                    render();
                }).catch(function (e) { S.note = '✕ ' + e.message; render(); });
            });
        });
        rootEl.querySelector('[data-act="new"]').addEventListener('click', function () {
            var n = 1;
            while (S.index.some(function (p) { return p.slug === 'untitled-' + n; })) n++;
            S.editing = { slug: 'untitled-' + n, title: 'Untitled project', summary: '', tags: [], repo: '', status: 'draft', started: new Date().toISOString().slice(0, 7), updated: '', figures: {}, body: '## Overview\n\nStart writing…' };
            S.savedSlug = null; S.fig = null; S.dirty = true; S.note = 'new — not saved yet';
            render();
        });
        rootEl.querySelectorAll('[data-act="up"], [data-act="down"]').forEach(function (b) {
            b.addEventListener('click', function () {
                var i = +b.dataset.i, j = b.dataset.act === 'up' ? i - 1 : i + 1;
                var slugs = S.index.map(function (p) { return p.slug; });
                slugs.splice(j, 0, slugs.splice(i, 1)[0]);
                saving(api('PUT', '/api/projects-order', { slugs: slugs }).then(function (r) { S.index = r.index; }), 'order saved');
            });
        });
        rootEl.querySelectorAll('[data-act="delete"]').forEach(function (b) {
            b.addEventListener('click', function () {
                var slug = b.dataset.slug;
                if (!window.confirm('Delete “' + slug + '” and its images (content/img/' + slug + '/)? Only undoable from git history.')) return;
                saving(api('DELETE', '/api/projects/' + encodeURIComponent(slug)).then(function (r) { S.index = r.index; }), 'deleted ' + slug + ' —');
            });
        });
    }

    // ---------------------------------------------------------------------------------------
    // projects: the editor
    // ---------------------------------------------------------------------------------------
    function field(label, name, value, wide, type, hint) {
        return '<label class="field' + (wide ? ' field--wide' : '') + '"><span class="field__label">' + label + '</span>' +
            '<input type="' + (type || 'text') + '" data-meta="' + name + '" value="' + esc(value) + '"' + (hint ? ' placeholder="' + esc(hint) + '"' : '') + '></label>';
    }

    function editorHtml(p) {
        var figIds = Object.keys(p.figures);
        if (!S.fig || !p.figures[S.fig]) S.fig = figIds[0] || null;
        var f = S.fig && p.figures[S.fig];
        var saveBtn = '<button class="btn btn--primary" type="button" data-act="save">save' + (S.dirty ? ' *' : '') + '</button>';
        return toolbar('vim content/projects/' + p.slug + '.json',
                '<button class="btn btn--small" type="button" data-act="back">← all projects</button>' +
                (S.savedSlug && p.status === 'published' ? '<a class="btn btn--small" href="index.html#/projects/' + esc(S.savedSlug) + '" target="_blank" rel="noopener">view</a>' : '') + saveBtn) +
            '<div class="editor"><div>' +
            '<div class="editor__meta">' +
            field('title', 'title', p.title) + field('slug (the address: #/projects/…)', 'slug', p.slug) +
            field('summary (shown on the card)', 'summary', p.summary, true) +
            field('tags (comma separated)', 'tags', (p.tags || []).join(', ')) + field('github repo — a link, or “private”', 'repo', p.repo, false, 'text', 'https://github.com/… or private') +
            '<label class="field"><span class="field__label">status</span><select data-meta="status"><option value="draft"' + (p.status === 'draft' ? ' selected' : '') + '>draft — shown as coming soon</option><option value="published"' + (p.status === 'published' ? ' selected' : '') + '>published</option></select></label>' +
            field('started', 'started', p.started, false, 'text', '2026-03') +
            '</div>' +
            '<label class="field"><span class="field__label">write-up — markdown: ## heading · **bold** · *italic* · `code` · [link](https://…) · - list · ``` code block · ::figure[id] places an image</span>' +
            '<textarea class="md" data-meta="body" spellcheck="true">' + esc(p.body) + '</textarea></label>' +
            '</div><div class="editor__preview"><p class="editor__label">live preview</p><div data-role="preview"></div></div></div>' +
            '<div class="figman"><h3>Figures</h3>' +
            '<p class="figman__hint">' + (S.savedSlug ? 'Add an image, then click on it to drop numbered pins and describe each one. “insert” puts the figure at the cursor in the write-up.'
                : 'Save the project once to start adding images.') + '</p>' +
            '<div class="figman__body"><div class="figman__list">' +
            figIds.map(function (id) {
                var x = p.figures[id];
                return '<button type="button" class="figman__thumb" data-fig="' + esc(id) + '" aria-pressed="' + (id === S.fig) + '"><img src="' + esc(x.src) + '" alt="">::figure[' + esc(id) + ']</button>';
            }).join('') +
            '<button type="button" class="btn btn--small" data-act="add-fig"' + (S.savedSlug ? '' : ' disabled') + '>+ add image</button>' +
            '<input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/svg+xml" data-role="file" hidden></div>' +
            (f ? '<div class="figman__canvas" data-role="canvas"><img src="' + esc(f.src) + '" alt="" draggable="false">' + MH.pinsHtml(f.hotspots, false) + '</div>' +
                '<div class="figman__notes">' +
                '<div class="note-row"><span class="field__label" style="flex:1">::figure[' + esc(S.fig) + ']</span>' +
                '<button class="btn btn--small" type="button" data-act="insert-fig">insert</button>' +
                '<button class="btn btn--small btn--danger" type="button" data-act="del-fig">remove</button></div>' +
                '<label class="field"><span class="field__label">title</span><input type="text" data-figmeta="title" value="' + esc(f.title) + '"></label>' +
                '<label class="field"><span class="field__label">caption</span><input type="text" data-figmeta="caption" value="' + esc(f.caption) + '"></label>' +
                '<label class="field"><span class="field__label">alt text (for screen readers)</span><input type="text" data-figmeta="alt" value="' + esc(f.alt) + '" placeholder="defaults to the title"></label>' +
                '<span class="field__label">pins</span>' +
                (f.hotspots || []).map(function (h, i) {
                    return '<div class="note-row"><span class="num">' + (i + 1) + '</span><input type="text" data-note-i="' + i + '" value="' + esc(h.note) + '" placeholder="what this points at…"><button class="btn btn--small" type="button" data-del-pin="' + i + '" aria-label="Remove pin ' + (i + 1) + '">✕</button></div>';
                }).join('') +
                ((f.hotspots || []).length ? '' : '<p class="figman__hint">No pins yet — click the image.</p>') +
                '</div>'
                : '<p class="figman__hint">No figures yet.</p>') +
            '</div></div>';
    }

    function wireEditor(p) {
        var preview = rootEl.querySelector('[data-role="preview"]');
        var bodyEl = rootEl.querySelector('[data-meta="body"]');
        function paintPreview() { preview.innerHTML = MH.articleHtml(p, null); }
        paintPreview();

        rootEl.querySelector('[data-act="back"]').addEventListener('click', function () {
            if (!leaveOk()) return;
            S.editing = null; S.dirty = false; S.note = '';
            reloadThen(render);
        });
        rootEl.querySelector('[data-act="save"]').addEventListener('click', function () {
            if (!SLUG_RE.test(p.slug)) { S.note = '✕ the slug can only use a-z, 0-9 and dashes'; return render(); }
            var slug = p.slug;
            saving(api('PUT', '/api/projects/' + encodeURIComponent(slug), { project: p, oldSlug: S.savedSlug }).then(function (r) {
                r.project.figures = r.project.figures || {};
                S.editing = r.project; S.savedSlug = r.project.slug; S.index = r.index;
            }), 'saved');
        });
        rootEl.querySelectorAll('[data-meta]').forEach(function (el) {
            el.addEventListener('input', function () {
                var k = el.dataset.meta;
                p[k] = k === 'tags' ? el.value.split(',').map(function (t) { return t.trim(); }).filter(Boolean)
                    : k === 'slug' ? el.value.trim().toLowerCase() : el.value;
                markDirty();
                paintPreview();
            });
        });
        rootEl.querySelectorAll('[data-fig]').forEach(function (b) {
            b.addEventListener('click', function () { S.fig = b.dataset.fig; render(); });
        });

        // images: read the size in the browser, upload into content/img/<slug>/, add a figure
        var fileInput = rootEl.querySelector('[data-role="file"]');
        rootEl.querySelector('[data-act="add-fig"]').addEventListener('click', function () { fileInput.click(); });
        fileInput.addEventListener('change', function () {
            var file = fileInput.files[0];
            if (!file) return;
            var url = URL.createObjectURL(file);
            var img = new Image();
            img.onload = function () {
                var w = img.naturalWidth || 1600, h = img.naturalHeight || 1000;
                URL.revokeObjectURL(url);
                S.note = 'uploading ' + file.name + '…';
                api('POST', '/api/images/' + encodeURIComponent(S.savedSlug) + '?name=' + encodeURIComponent(file.name), undefined, file).then(function (r) {
                    var base = MH.slugify(file.name.replace(/\.[^.]+$/, '')) || 'fig';
                    var id = base, n = 2;
                    while (p.figures[id]) id = base + '-' + n++;
                    p.figures[id] = { src: r.src, w: w, h: h, title: file.name.replace(/\.[^.]+$/, ''), caption: '', alt: '', hotspots: [] };
                    p.body = p.body.replace(/\s*$/, '') + '\n\n::figure[' + id + ']\n';
                    S.fig = id;
                    S.note = 'image uploaded — save to keep the figure';
                    S.dirty = true;
                    render();
                }).catch(function (e) { S.note = '✕ ' + e.message; render(); });
            };
            img.onerror = function () { URL.revokeObjectURL(url); S.note = '✕ that file isn’t an image the browser can read'; render(); };
            img.src = url;
        });

        var f = S.fig && p.figures[S.fig];
        if (!f) return;
        var canvas = rootEl.querySelector('[data-role="canvas"]');
        canvas.addEventListener('click', function (e) {
            if (e.target.closest('.pin')) return;
            var r = canvas.getBoundingClientRect();
            f.hotspots = f.hotspots || [];
            f.hotspots.push({ x: +(((e.clientX - r.left) / r.width) * 100).toFixed(1), y: +(((e.clientY - r.top) / r.height) * 100).toFixed(1), note: '' });
            S.dirty = true;
            render();
            var inputs = rootEl.querySelectorAll('[data-note-i]');
            if (inputs.length) inputs[inputs.length - 1].focus();
        });
        rootEl.querySelectorAll('[data-note-i]').forEach(function (el) {
            el.addEventListener('input', function () { f.hotspots[+el.dataset.noteI].note = el.value; markDirty(); });
            el.addEventListener('focus', function () { canvas.querySelectorAll('.pin').forEach(function (pin, i) { pin.classList.toggle('is-hot', i === +el.dataset.noteI); }); });
            el.addEventListener('blur', paintPreview);
        });
        rootEl.querySelectorAll('[data-del-pin]').forEach(function (b) {
            b.addEventListener('click', function () { f.hotspots.splice(+b.dataset.delPin, 1); S.dirty = true; render(); });
        });
        rootEl.querySelectorAll('[data-figmeta]').forEach(function (el) {
            el.addEventListener('input', function () { f[el.dataset.figmeta] = el.value; markDirty(); paintPreview(); });
        });
        rootEl.querySelector('[data-act="insert-fig"]').addEventListener('click', function () {
            var at = bodyEl.selectionStart || p.body.length;
            var before = p.body.slice(0, at), after = p.body.slice(at);
            p.body = before.replace(/\s*$/, '') + '\n\n::figure[' + S.fig + ']\n\n' + after.replace(/^\s*/, '');
            S.dirty = true;
            render();
        });
        rootEl.querySelector('[data-act="del-fig"]').addEventListener('click', function () {
            if (!window.confirm('Remove figure ' + S.fig + ' from this write-up? (The image file stays in content/img/.)')) return;
            var id = S.fig;
            delete p.figures[id];
            p.body = p.body.split('\n').filter(function (l) { return l.trim() !== '::figure[' + id + ']'; }).join('\n');
            S.fig = null; S.dirty = true;
            render();
        });
    }

    // ---------------------------------------------------------------------------------------
    // CV: file tree of sections | the section's form | live preview of that section. Typing
    // updates the data in place (no re-render, so focus stays); add/remove/reorder re-render.
    // Values bind by path, e.g. data-cv="experience.2.role".
    // ---------------------------------------------------------------------------------------
    function getPath(path) { return path.split('.').reduce(function (o, k) { return o[k]; }, S.cv); }
    function setPath(path, val) {
        var k = path.split('.'), last = k.pop();
        (k.length ? getPath(k.join('.')) : S.cv)[last] = val;
    }
    function cvField(lbl, path, opts) {
        opts = opts || {};
        var val = getPath(path);
        if (opts.lines) val = (val || []).join('\n');
        if (opts.paras) val = (val || []).join('\n\n');
        var attr = opts.lines ? 'data-cv-lines' : opts.paras ? 'data-cv-paras' : 'data-cv';
        var ph = opts.ph ? ' placeholder="' + esc(opts.ph) + '"' : '';
        var control = opts.rows ? '<textarea rows="' + opts.rows + '" ' + attr + '="' + path + '"' + ph + '>' + esc(val) + '</textarea>'
            : '<input type="text" ' + attr + '="' + path + '" value="' + esc(val) + '"' + ph + '>';
        return '<label class="field"><span class="field__label">' + lbl + '</span>' + control + '</label>';
    }
    function cardHead(title, list, i, n) {
        return '<div class="cv-card__head"><span class="grow">' + esc(title || 'untitled') + '</span>' +
            '<button class="btn btn--small" type="button" data-cv-act="up" data-list="' + list + '" data-i="' + i + '"' + (i === 0 ? ' disabled' : '') + ' aria-label="Move up">↑</button>' +
            '<button class="btn btn--small" type="button" data-cv-act="down" data-list="' + list + '" data-i="' + i + '"' + (i === n - 1 ? ' disabled' : '') + ' aria-label="Move down">↓</button>' +
            '<button class="btn btn--small" type="button" data-cv-act="del" data-list="' + list + '" data-i="' + i + '" aria-label="Remove">✕</button></div>';
    }
    var CV_NEW = {
        experience: function () { return { role: 'New role', date: '', org: '', points: [] }; },
        education: function () { return { title: 'New qualification', date: '', org: '', body: '' }; },
        interests: function () { return { title: 'New interest', body: '' }; },
        skills: function () { return { label: 'New group', items: [] }; }
    };
    var cvForms = {
        header: function () {
            var cv = S.cv;
            return cvField('name', 'name') + cvField('title', 'title') + '<span class="editor__label">contact line</span>' +
                cv.contacts.map(function (c, i) {
                    return '<div class="cv-card"><div class="cv-card__head"><span class="grow">' + esc(c.type) + '</span></div><div class="cv-grid2">' +
                        cvField('shown as', 'contacts.' + i + '.text') + cvField('link (blank = none)', 'contacts.' + i + '.href') + '</div></div>';
                }).join('');
        },
        profile: function () {
            return cvField('profile — a blank line starts a new paragraph', 'profile', { paras: true, rows: 14 });
        },
        skills: function () {
            var cv = S.cv;
            return '<p class="figman__hint">A note turns a bubble into a hover pop-up (shown with a dot). Leave it empty for a plain bubble.</p>' +
                cv.skills.map(function (g, gi) {
                    return '<div class="cv-card">' + cardHead(g.label, 'skills', gi, cv.skills.length) + cvField('group', 'skills.' + gi + '.label') +
                        '<div class="skill-row__head"><span>skill</span><span>hover note (optional)</span><span></span></div>' +
                        g.items.map(function (it, ii) {
                            return '<div class="skill-row"><input type="text" data-cv="skills.' + gi + '.items.' + ii + '.name" value="' + esc(it.name) + '" aria-label="Skill">' +
                                '<textarea rows="' + (it.detail ? 2 : 1) + '" data-cv="skills.' + gi + '.items.' + ii + '.detail" placeholder="—" aria-label="Hover note for ' + esc(it.name) + '">' + esc(it.detail) + '</textarea>' +
                                '<button class="btn btn--small" type="button" data-cv-act="del" data-list="skills.' + gi + '.items" data-i="' + ii + '" aria-label="Remove ' + esc(it.name) + '">✕</button></div>';
                        }).join('') +
                        '<button class="btn btn--small" type="button" data-cv-act="add-skill" data-list="skills.' + gi + '.items">+ skill</button></div>';
                }).join('') + '<button class="btn" type="button" data-cv-act="add" data-list="skills">+ skill group</button>';
        },
        experience: function () {
            var cv = S.cv;
            return '<button class="btn" type="button" data-cv-act="add-top" data-list="experience">+ role (goes on top)</button>' +
                cv.experience.map(function (e, i) {
                    return '<div class="cv-card">' + cardHead(e.role + (e.date ? ' · ' + e.date : ''), 'experience', i, cv.experience.length) +
                        '<div class="cv-grid2">' + cvField('role', 'experience.' + i + '.role') + cvField('dates', 'experience.' + i + '.date', { ph: 'Sep 2023 — Present' }) + '</div>' +
                        cvField('organisation', 'experience.' + i + '.org') +
                        cvField('bullet points — one per line', 'experience.' + i + '.points', { lines: true, rows: Math.max(3, e.points.length + 1) }) + '</div>';
                }).join('');
        },
        education: function () {
            var cv = S.cv;
            return cv.education.map(function (e, i) {
                return '<div class="cv-card">' + cardHead(e.title, 'education', i, cv.education.length) +
                    '<div class="cv-grid2">' + cvField('qualification', 'education.' + i + '.title') + cvField('dates', 'education.' + i + '.date') + '</div>' +
                    cvField('where', 'education.' + i + '.org') + cvField('details', 'education.' + i + '.body', { rows: 3 }) + '</div>';
            }).join('') + '<button class="btn" type="button" data-cv-act="add" data-list="education">+ qualification</button>';
        },
        interests: function () {
            var cv = S.cv;
            return cv.interests.map(function (e, i) {
                return '<div class="cv-card">' + cardHead(e.title, 'interests', i, cv.interests.length) + cvField('title', 'interests.' + i + '.title') +
                    cvField('text — [links](https://…) allowed', 'interests.' + i + '.body', { rows: 4 }) + '</div>';
            }).join('') + '<button class="btn" type="button" data-cv-act="add" data-list="interests">+ interest</button>';
        }
    };

    function cvEditorHtml() {
        if (!S.cv) return toolbar('vim content/cv.json');
        var sec = MH.CV_SECTIONS.filter(function (x) { return x.key === S.cvSec; })[0];
        return toolbar('vim cv/' + sec.file, '<a class="btn btn--small" href="index.html#/cv" target="_blank" rel="noopener">view cv</a>' +
                '<button class="btn btn--primary" type="button" data-act="save">save' + (S.dirty ? ' *' : '') + '</button>') +
            '<div class="cvedit"><nav class="cv-tree" aria-label="CV sections"><span class="cv-tree__root">~/cv</span>' +
            MH.CV_SECTIONS.map(function (x, i) {
                return '<button type="button" data-cv-sec="' + x.key + '" aria-current="' + (x.key === S.cvSec) + '"><span class="glyph">' + (i === MH.CV_SECTIONS.length - 1 ? '└─' : '├─') + '</span>' + esc(x.file) + '</button>';
            }).join('') + '</nav>' +
            '<div class="cvedit__form">' + cvForms[sec.key]() + '</div>' +
            '<div class="cvedit__preview"><p class="editor__label">live preview</p><div data-role="cv-preview"></div></div></div>';
    }

    function wireCv() {
        if (!S.cv) return;
        var preview = rootEl.querySelector('[data-role="cv-preview"]');
        function paint() { preview.innerHTML = MH.cvSection[S.cvSec](S.cv, false); }
        paint();
        rootEl.querySelectorAll('[data-cv-sec]').forEach(function (b) {
            b.addEventListener('click', function () { S.cvSec = b.dataset.cvSec; render(); }); // unsaved edits carry over: it's one file
        });
        rootEl.querySelector('[data-act="save"]').addEventListener('click', function () {
            saving(api('PUT', '/api/cv', { cv: S.cv, html: MH.cvHtml(S.cv) }), 'saved (content/cv.json + index.html)');
        });
        rootEl.querySelectorAll('[data-cv], [data-cv-lines], [data-cv-paras]').forEach(function (el) {
            el.addEventListener('input', function () {
                if (el.dataset.cv) setPath(el.dataset.cv, el.value);
                else if (el.dataset.cvLines) setPath(el.dataset.cvLines, el.value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean));
                else setPath(el.dataset.cvParas, el.value.split(/\n\s*\n/).map(function (x) { return x.replace(/\s*\n\s*/g, ' ').trim(); }).filter(Boolean));
                markDirty();
                paint();
            });
        });
        rootEl.querySelectorAll('[data-cv-act]').forEach(function (b) {
            b.addEventListener('click', function () {
                var list = getPath(b.dataset.list), i = +b.dataset.i, act = b.dataset.cvAct, top = b.dataset.list.split('.')[0];
                if (act === 'del') list.splice(i, 1);
                if (act === 'up' && i > 0) list.splice(i - 1, 0, list.splice(i, 1)[0]);
                if (act === 'down' && i < list.length - 1) list.splice(i + 1, 0, list.splice(i, 1)[0]);
                if (act === 'add') list.push(CV_NEW[top]());
                if (act === 'add-top') list.unshift(CV_NEW[top]());
                if (act === 'add-skill') list.push({ name: 'New skill', detail: '' });
                S.dirty = true;
                render();
            });
        });
        if (S.mode === 'readonly') rootEl.querySelectorAll('[data-cv-act]').forEach(function (b) { b.disabled = true; });
    }

    // ---------------------------------------------------------------------------------------
    // home text
    // ---------------------------------------------------------------------------------------
    function siteHtml() {
        if (!S.site) return toolbar('vim content/site.json');
        return toolbar('vim content/site.json', '<button class="btn btn--primary" type="button" data-act="save">save' + (S.dirty ? ' *' : '') + '</button>') +
            '<div class="site-form">' +
            '<label class="field"><span class="field__label">status line — SYSTEM STATUS: …</span><input type="text" data-site-edit="status" value="' + esc(S.site.status) + '"></label>' +
            '<label class="field"><span class="field__label">bio — under “$ whoami -short” on the home page</span><textarea rows="5" data-site-edit="bio">' + esc(S.site.bio) + '</textarea></label>' +
            '<p class="figman__hint">Saving writes content/site.json and the text into index.html.</p></div>';
    }

    function wireSite() {
        if (!S.site) return;
        rootEl.querySelectorAll('[data-site-edit]').forEach(function (el) {
            el.addEventListener('input', function () { S.site[el.dataset.siteEdit] = el.value; markDirty(); });
        });
        rootEl.querySelector('[data-act="save"]').addEventListener('click', function () {
            saving(api('PUT', '/api/site', { site: S.site }).then(function (r) { S.site = r.site; }), 'saved');
        });
    }

    // ---------------------------------------------------------------------------------------
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') chrome.closePopups();
        if ((e.ctrlKey || e.metaKey) && e.key === 's') { // Ctrl+S saves whatever's open
            var b = rootEl.querySelector('[data-act="save"]');
            if (b && !b.disabled) { e.preventDefault(); b.click(); }
        }
    });
    boot();
})();

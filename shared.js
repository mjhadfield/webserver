// Shared by the site (script.js) and the admin page (admin.js): Markdown + figure rendering, the
// project article, the CV (one function per section, so admin can preview just the section
// being edited), and the page chrome -- theme toggle, background picker, skill-note pop-ups.
// Rendering functions are plain string builders with no DOM access, so they also run under Node.
(function (root) {
    'use strict';

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function slugify(s) {
        return String(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    }

    // ---------------------------------------------------------------------------------------
    // Markdown -- a deliberately small subset, no library: ## / ### headings, paragraphs, - and
    // 1. lists, ``` code blocks, > quotes, **bold**, *italic*, `code`, [links](url), and
    // "::figure[id]" on its own line to place one of the project's figures.
    // ---------------------------------------------------------------------------------------
    function inline(s) {
        return esc(s)
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/\*([^*]+)\*/g, '<em>$1</em>')
            .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|#[^)\s]*)\)/g, function (m, text, href) {
                return href.charAt(0) === '#' ? '<a href="' + href + '">' + text + '</a>'
                    : '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + text + '</a>';
            });
    }

    // the figures a body actually shows, in order (so numbering and the pop-out agree)
    function figureIds(body, figures) {
        var ids = [];
        String(body || '').split('\n').forEach(function (line) {
            var m = line.match(/^::figure\[([\w-]+)\]\s*$/);
            if (m && figures && figures[m[1]]) ids.push(m[1]);
        });
        return ids;
    }

    function md(text, figures) {
        var lines = String(text || '').split('\n');
        var out = [];
        var para = [];
        var list = null;
        var figNo = 0;
        function flushPara() {
            if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; }
        }
        function flushList() {
            if (list) { out.push('<' + list.tag + '>' + list.items.map(function (i) { return '<li>' + inline(i) + '</li>'; }).join('') + '</' + list.tag + '>'); list = null; }
        }
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            var m;
            if (/^```/.test(line)) {
                flushPara(); flushList();
                var code = [];
                while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i]);
                out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
            } else if ((m = line.match(/^::figure\[([\w-]+)\]\s*$/))) {
                flushPara(); flushList();
                var fig = figures && figures[m[1]];
                out.push(fig ? figureHtml(m[1], fig, ++figNo) : '<p><code>missing figure: ' + esc(m[1]) + '</code></p>');
            } else if ((m = line.match(/^(#{2,3})\s+(.*)$/))) {
                flushPara(); flushList();
                out.push('<h' + m[1].length + '>' + inline(m[2]) + '</h' + m[1].length + '>');
            } else if ((m = line.match(/^>\s?(.*)$/))) {
                flushPara(); flushList();
                out.push('<blockquote>' + inline(m[1]) + '</blockquote>');
            } else if ((m = line.match(/^(-|\d+\.)\s+(.*)$/))) {
                flushPara();
                var tag = m[1] === '-' ? 'ul' : 'ol';
                if (list && list.tag !== tag) flushList();
                if (!list) list = { tag: tag, items: [] };
                list.items.push(m[2]);
            } else if (!line.trim()) {
                flushPara(); flushList();
            } else {
                flushList();
                para.push(line.trim());
            }
        }
        flushPara(); flushList();
        return out.join('\n');
    }

    function pinsHtml(hotspots, asButtons) {
        return (hotspots || []).map(function (h, i) {
            var tag = asButtons ? 'button' : 'span';
            return '<' + tag + (asButtons ? ' type="button"' : '') + ' class="pin" data-pin="' + i + '" style="left:' + (+h.x) + '%;top:' + (+h.y) + '%"' +
                (asButtons ? ' aria-label="Note ' + (i + 1) + '"' : ' aria-hidden="true"') + '>' + (i + 1) + '</' + tag + '>';
        }).join('');
    }

    function figureHtml(id, fig, n) {
        var w = +fig.w || 1600, h = +fig.h || 1000;
        return '<figure class="fig">' +
            '<button type="button" class="fig__frame" data-fig="' + esc(id) + '" style="aspect-ratio:' + w + '/' + h + '" aria-label="Expand figure ' + n + ': ' + esc(fig.title) + '">' +
            '<img src="' + esc(fig.src) + '" alt="' + esc(fig.alt || fig.title) + '" width="' + w + '" height="' + h + '" loading="lazy" decoding="async">' +
            pinsHtml(fig.hotspots, false) +
            '<span class="fig__zoom">click to expand</span></button>' +
            '<figcaption><b>fig.' + n + '</b><span><strong>' + esc(fig.title) + '</strong>' + (fig.caption ? ' — ' + esc(fig.caption) : '') + '</span></figcaption></figure>';
    }

    // ---------------------------------------------------------------------------------------
    // Pieces of the site's views
    // ---------------------------------------------------------------------------------------
    // "$ cd .." -- the way back up, with its key (Esc works anywhere outside a text field)
    function cdBtn(href, label) {
        return '<a class="cd-btn" href="' + href + '"><span class="prompt">$</span>' + esc(label) + '<kbd>esc</kbd></a>';
    }

    function tagsHtml(tags) {
        return '<ul class="skill-tags skill-tags--sm">' + (tags || []).map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>';
    }

    var GH_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 4.7 18.3 5 18.3 5c.7 1.7.3 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.7-2.8 5.7-5.5 6 .4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .5z"/></svg>';

    // the GitHub button: a link, or -- when the repo field just says "private" -- the same button,
    // greyed out and not clickable
    function repoHtml(repo) {
        repo = String(repo || '').trim();
        if (!repo) return '';
        if (/^private$/i.test(repo)) {
            return '<span class="repo-btn repo-btn--private" role="link" aria-disabled="true" title="This repository isn’t public">' + GH_ICON + 'Private repo</span>';
        }
        return '<a class="repo-btn" href="' + esc(repo) + '" target="_blank" rel="noopener noreferrer">' + GH_ICON + 'view on GitHub</a>';
    }

    // a project write-up; backHref null leaves the "cd .." chip off (the admin preview)
    function articleHtml(p, backHref) {
        var dates = [p.started && 'started ' + p.started, p.updated && 'updated ' + p.updated].filter(Boolean).join(' · ');
        return '<div class="article__head">' +
            (backHref ? cdBtn(backHref, 'cd ..') : '') +
            '<p class="section-label"><span class="prompt">$</span> cat projects/' + esc(p.slug) + '/README.md</p>' +
            '<h1 class="article__title">' + esc(p.title) + '</h1>' +
            (p.summary ? '<p class="article__summary">' + esc(p.summary) + '</p>' : '') +
            '<div class="article__meta">' + tagsHtml(p.tags) +
            (dates ? '<span>' + esc(dates) + '</span>' : '') +
            repoHtml(p.repo) +
            '</div></div>' +
            '<article class="prose">' + md(p.body, p.figures) + '</article>';
    }

    // ---------------------------------------------------------------------------------------
    // CV (content/cv.json). Markup and classes are the ones the old cv.html used.
    // ---------------------------------------------------------------------------------------
    var ICONS = {
        email: '<svg class="contact-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/></svg>',
        phone: '<svg class="contact-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
        location: '<svg class="contact-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
        linkedin: '<svg class="contact-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 1 1 0-4.124 2.062 2.062 0 0 1 0 4.124zM7.114 20.452H3.558V9h3.556v11.452z"/></svg>'
    };

    var CV_SECTIONS = [
        { key: 'header', file: 'whoami' },
        { key: 'profile', file: 'profile.txt' },
        { key: 'skills', file: 'keySkills.json' },
        { key: 'experience', file: 'experience/' },
        { key: 'education', file: 'education.txt' },
        { key: 'interests', file: 'interests.md' }
    ];

    function label(cmd) { return '<p class="section-label"><span class="prompt">$</span> ' + esc(cmd) + '</p>'; }

    var cvSection = {
        header: function (cv, withBack) {
            return '<header class="cv-header">' + (withBack ? cdBtn('#/', 'cd ~') : '') + label('whoami -all') +
                '<h1 class="name">' + esc(cv.name) + '</h1><p class="tagline">' + esc(cv.title) + '</p>' +
                '<ul class="contact-list">' + (cv.contacts || []).map(function (c) {
                    var inner = (ICONS[c.type] || '') + '<span>' + esc(c.text) + '</span>';
                    var ext = /^https?:/.test(c.href || '') ? ' target="_blank" rel="noopener noreferrer"' : '';
                    return c.href ? '<li><a class="contact-link" href="' + esc(c.href) + '"' + ext + (c.title ? ' title="' + esc(c.title) + '"' : '') + '>' + inner + '</a></li>'
                        : '<li class="contact-link">' + inner + '</li>';
                }).join('') + '</ul></header>';
        },
        profile: function (cv) {
            return '<section class="cv-section">' + label('cat profile.txt') + (cv.profile || []).map(function (t) { return '<p class="section-body">' + inline(t) + '</p>'; }).join('') + '</section>';
        },
        skills: function (cv) {
            return '<section class="cv-section">' + label('cat keySkills.json') + (cv.skills || []).map(function (g) {
                return '<div class="skills-group"><p class="skills-group__label">' + esc(g.label) + '</p><ul class="skill-tags">' +
                    (g.items || []).map(function (it) {
                        return it.detail ? '<li class="has-note" tabindex="0" data-note="' + esc(it.detail) + '" data-man="' + esc(slugify(it.name)) + '">' + esc(it.name) + '</li>'
                            : '<li>' + esc(it.name) + '</li>';
                    }).join('') + '</ul></div>';
            }).join('') + '</section>';
        },
        experience: function (cv) {
            return '<section class="cv-section">' + label('ls experience/ --sort=date') + '<ol class="timeline">' + (cv.experience || []).map(function (e) {
                return '<li class="timeline__item"><div class="timeline__head"><h3 class="timeline__role">' + esc(e.role) + '</h3><span class="timeline__date">' + esc(e.date) + '</span></div>' +
                    '<p class="timeline__org">' + esc(e.org) + '</p><ul class="timeline__list">' + (e.points || []).map(function (x) { return '<li>' + inline(x) + '</li>'; }).join('') + '</ul></li>';
            }).join('') + '</ol></section>';
        },
        education: function (cv) {
            return '<section class="cv-section">' + label('cat education.txt') + (cv.education || []).map(function (e) {
                return '<div class="doc-entry"><div class="timeline__head"><h3 class="timeline__role">' + esc(e.title) + '</h3><span class="timeline__date">' + esc(e.date) + '</span></div>' +
                    '<p class="timeline__org">' + esc(e.org) + '</p><p class="section-body">' + inline(e.body) + '</p></div>';
            }).join('') + '</section>';
        },
        interests: function (cv) {
            return '<section class="cv-section">' + label('cat interests.md') + (cv.interests || []).map(function (e) {
                return '<div class="doc-entry"><h3 class="timeline__role">' + esc(e.title) + '</h3><p class="section-body">' + inline(e.body) + '</p></div>';
            }).join('') + '</section>';
        }
    };

    // the whole CV as it goes into index.html (between the cv markers), one section per line
    function cvHtml(cv) {
        return CV_SECTIONS.map(function (s) { return cvSection[s.key](cv, true); }).join('\n');
    }

    // ---------------------------------------------------------------------------------------
    // Page chrome (browser only): theme toggle + background picker in the title bar, and the
    // skill-note pop-up. Both pages carry the same markup for these; settings live in
    // localStorage and are applied before first paint by the inline script in each <head>.
    // ---------------------------------------------------------------------------------------
    function initChrome() {
        var doc = document, html = doc.documentElement;
        function store(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private window: just don't remember */ } }

        var themeBtn = doc.getElementById('theme-btn');
        function paintThemeBtn() {
            var l = html.dataset.theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
            themeBtn.setAttribute('aria-label', l);
            themeBtn.title = l;
        }
        themeBtn.addEventListener('click', function () {
            html.dataset.theme = html.dataset.theme === 'light' ? 'dark' : 'light';
            store('mh-theme', html.dataset.theme);
            paintThemeBtn();
        });
        paintThemeBtn();

        var bgBtn = doc.getElementById('bg-btn');
        var bgMenu = doc.getElementById('bg-menu');
        var scanToggle = doc.getElementById('scan-toggle');
        function options() { return [].slice.call(bgMenu.querySelectorAll('button[data-bg]')); } // not just [data-bg]: <html> carries it too
        function paintBgMenu() {
            options().forEach(function (b) {
                var on = b.dataset.bg === html.dataset.bg;
                b.setAttribute('aria-checked', String(on));
                b.tabIndex = on ? 0 : -1; // one tab stop for the group; arrow keys move within it
            });
            scanToggle.checked = html.dataset.scan !== 'off';
        }
        function setBg(v) {
            html.dataset.bg = v;
            store('mh-bg', v);
            paintBgMenu();
        }
        function openBgMenu() {
            paintBgMenu();
            bgMenu.hidden = false;
            var r = bgBtn.getBoundingClientRect();
            bgMenu.style.top = (r.bottom + 8) + 'px';
            bgMenu.style.left = Math.max(8, Math.min(r.right - bgMenu.offsetWidth, window.innerWidth - bgMenu.offsetWidth - 8)) + 'px';
            bgBtn.setAttribute('aria-expanded', 'true');
            (bgMenu.querySelector('[aria-checked="true"]') || options()[0]).focus();
        }
        function closeBgMenu(refocus) {
            if (bgMenu.hidden) return false;
            bgMenu.hidden = true;
            bgBtn.setAttribute('aria-expanded', 'false');
            if (refocus) bgBtn.focus();
            return true;
        }
        bgBtn.addEventListener('click', function () { if (bgMenu.hidden) openBgMenu(); else closeBgMenu(false); });
        bgMenu.addEventListener('click', function (e) {
            var b = e.target.closest('button[data-bg]');
            if (b) setBg(b.dataset.bg);
        });
        bgMenu.addEventListener('keydown', function (e) {
            var opts = options();
            var i = opts.indexOf(doc.activeElement);
            if (i < 0 || !/^Arrow(Left|Right|Up|Down)$/.test(e.key)) return;
            e.preventDefault();
            var next = opts[(i + (/Left|Up/.test(e.key) ? -1 : 1) + opts.length) % opts.length];
            setBg(next.dataset.bg);
            next.focus();
        });
        scanToggle.addEventListener('change', function () {
            html.dataset.scan = scanToggle.checked ? 'on' : 'off';
            store('mh-scan', html.dataset.scan);
        });
        doc.addEventListener('click', function (e) {
            if (!bgMenu.hidden && !bgMenu.contains(e.target) && !bgBtn.contains(e.target)) closeBgMenu(false);
        });
        window.addEventListener('resize', function () { closeBgMenu(false); });
        paintBgMenu();

        // skill notes: hover / focus / tap a bubble with a dot. One shared pop-up, placed below
        // the bubble (above if there's no room), kept inside the window.
        var tip = doc.getElementById('tip');
        var tipFor = null, tipAt = 0;
        function showTip(li) {
            if (tipFor !== li) tipAt = performance.now();
            if (tipFor && tipFor !== li) tipFor.classList.remove('is-open');
            tipFor = li;
            tip.innerHTML = '<span class="tip__cmd">$ man ' + esc(li.dataset.man) + '</span>' + esc(li.dataset.note);
            tip.hidden = false;
            li.classList.add('is-open');
            li.setAttribute('aria-describedby', 'tip');
            var r = li.getBoundingClientRect(), t = tip.getBoundingClientRect();
            tip.style.left = Math.min(Math.max(8, r.left + r.width / 2 - t.width / 2), window.innerWidth - t.width - 8) + 'px';
            tip.style.top = (r.bottom + 8 + t.height > window.innerHeight - 8 ? r.top - t.height - 8 : r.bottom + 8) + 'px';
        }
        function hideTip() {
            if (!tipFor) return false;
            tipFor.classList.remove('is-open');
            tipFor.removeAttribute('aria-describedby');
            tipFor = null;
            tip.hidden = true;
            return true;
        }
        doc.addEventListener('mouseover', function (e) {
            var li = e.target.closest && e.target.closest('li.has-note');
            if (li && li !== tipFor) showTip(li);
            else if (!li && tipFor && !tipFor.contains(doc.activeElement)) hideTip();
        });
        doc.addEventListener('focusin', function (e) {
            var li = e.target.closest && e.target.closest('li.has-note');
            if (li) showTip(li); else hideTip();
        });
        doc.addEventListener('click', function (e) { // touch: tap to open, tap elsewhere to close
            var li = e.target.closest && e.target.closest('li.has-note');
            // a tap focuses the bubble (which opens it) and then clicks it -- don't let that click close it again
            if (li) { if (tipFor === li && performance.now() - tipAt > 400) hideTip(); else showTip(li); } else hideTip();
        });
        doc.addEventListener('scroll', hideTip, { passive: true, capture: true });

        // Esc handling for the page: returns true if it closed something of ours
        return {
            closePopups: function () { return closeBgMenu(true) || hideTip(); },
            hideTip: hideTip,
            closeBgMenu: closeBgMenu
        };
    }

    root.MH = {
        esc: esc, slugify: slugify, inline: inline, md: md, figureIds: figureIds, pinsHtml: pinsHtml, figureHtml: figureHtml,
        cdBtn: cdBtn, tagsHtml: tagsHtml, articleHtml: articleHtml,
        CV_SECTIONS: CV_SECTIONS, cvSection: cvSection, cvHtml: cvHtml,
        initChrome: initChrome
    };
})(typeof window !== 'undefined' ? window : globalThis);

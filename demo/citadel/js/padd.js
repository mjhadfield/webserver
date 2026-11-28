// PADD (#view-padd): cross-device Dropzone, persistent Markdown Notes & Checklists, and Home Assistant Todo sync.
//
// Everything is .pd* / [data-pd-*]; never reuse [data-act] or [data-date] (app.js and util.js handle those globally).
// Never call window.confirm() or window.prompt() (CitadelAndroid WebView + clean inline armed buttons instead).
import * as api from './api.js';
import { $, $$, esc, ico, safeUrl, bytes, ago, toast } from './util.js';

const API = '/api/owner/padd';
const root = $('#view-padd');
const STORAGE_TAB = 'padd-tab';
const STORAGE_LIST = 'padd-ha-list';

let active = false, started = false, mounted = false;
let tab = loadTab();                                // 'drop' | 'notes' | 'shop'

// Dropzone state
let drops = [], storage = null, deviceInfo = null, zebralabAvailable = false;
let dropFilter = 'all', dropQuery = '', dropMode = 'auto';
let dropLoading = false, dropError = null;
let expandedDrops = new Set();
let clearArmedUntil = 0, clearArmTimer = 0;
let activeUpload = null;                            // { name, loaded, total, xhr }
let dragDepth = 0;
let cliHelpOpen = false;

// Notes state
let notes = [], noteTags = [];
let noteQuery = '', noteTag = '', noteArchived = false;
let selectedNoteId = null;
let noteViewMode = 'edit';                          // 'edit' | 'preview' | 'split'
let mobileNoteOpen = false;
let noteDirty = false, noteSaving = false, noteSaveTimer = 0;
let noteDeleteArmedId = null, noteDeleteTimer = 0;
let noteChecklistRaw = false;

// Shopping / HA Todo state
let haState = null;                                 // { available, error, lists: [...] }
let haLoading = false;
let selectedListId = loadSelectedList();
let completedOpen = false;
let editingTodoKey = null;                          // uid being renamed inline

// Modals
let shareModalState = null;                         // { dropId, ttl, loading, data, error }
let lightboxDropId = null;

function loadTab() {
  try {
    const v = localStorage.getItem(STORAGE_TAB);
    return (v === 'notes' || v === 'shop') ? v : 'drop';
  } catch { return 'drop'; }
}
function saveTab(v) { try { localStorage.setItem(STORAGE_TAB, v); } catch { /* ignore */ } }
function loadSelectedList() { try { return localStorage.getItem(STORAGE_LIST) || ''; } catch { return ''; } }
function saveSelectedList(v) { try { localStorage.setItem(STORAGE_LIST, v); } catch { /* ignore */ } }

// ---- LAN HTTP-safe clipboard copy ---------------------------------------------------------------

async function copyText(text, btn = null) {
  const str = String(text ?? '');
  let ok = false;
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(str); ok = true; } catch { /* fallback below */ }
  }
  if (!ok) {
    const ta = document.createElement('textarea');
    ta.value = str;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
    document.body.append(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, str.length);
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  if (ok) {
    toast('Copied to clipboard');
    if (btn) {
      btn.classList.add('is-copied');
      const label = btn.querySelector('.pd-copy-lbl');
      const prev = label ? label.textContent : null;
      if (label) label.textContent = 'Copied';
      setTimeout(() => {
        btn.classList.remove('is-copied');
        if (label && prev !== null) label.textContent = prev;
      }, 1500);
    }
  } else {
    toast('Could not copy automatically — select the text to copy');
  }
}

// ---- safe Markdown & auto-link renderer (every text node passes through esc() + safeUrl()) ------

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

function inlineFmt(text) {
  // Tokenise inline code first so formatting inside backticks isn't touched.
  const parts = [];
  let i = 0;
  const src = String(text ?? '');
  const codeRe = /`([^`\n]+)`/g;
  let m;
  while ((m = codeRe.exec(src)) !== null) {
    if (m.index > i) parts.push(inlineRich(src.slice(i, m.index)));
    parts.push(`<code>${esc(m[1])}</code>`);
    i = m.index + m[0].length;
  }
  if (i < src.length) parts.push(inlineRich(src.slice(i)));
  return parts.join('');
}

function inlineRich(chunk) {
  // Handle markdown links [label](url) first, then bare URLs, bold, italic.
  const mdLinkRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let out = '', last = 0, m;
  while ((m = mdLinkRe.exec(chunk)) !== null) {
    if (m.index > last) out += linkifyBare(chunk.slice(last, m.index));
    out += `<a href="${esc(safeUrl(m[2]))}" target="_blank" rel="noopener noreferrer">${esc(m[1])}</a>`;
    last = m.index + m[0].length;
  }
  if (last < chunk.length) out += linkifyBare(chunk.slice(last));
  return out;
}

function linkifyBare(chunk) {
  let out = '', last = 0, m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(chunk)) !== null) {
    if (m.index > last) out += emphasis(chunk.slice(last, m.index));
    let url = m[0], trail = '';
    while (/[.,;:!?)]$/.test(url)) { trail = url.slice(-1) + trail; url = url.slice(0, -1); }
    out += `<a href="${esc(safeUrl(url))}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>${esc(trail)}`;
    last = m.index + m[0].length;
  }
  if (last < chunk.length) out += emphasis(chunk.slice(last));
  return out;
}

function emphasis(chunk) {
  let s = esc(chunk);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  return s;
}

function renderMarkdown(body, noteId = null) {
  const lines = String(body || '').split('\n');
  const html = [];
  let inCode = false, codeLines = [], inUl = false, inOl = false, codeBlockIdx = 0;

  const closeLists = () => {
    if (inUl) { html.push('</ul>'); inUl = false; }
    if (inOl) { html.push('</ol>'); inOl = false; }
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const ln = lines[idx];
    if (ln.trim().startsWith('```')) {
      closeLists();
      if (inCode) {
        const raw = codeLines.join('\n');
        html.push(
          `<div class="pd-md-code"><button class="pd-md-copy" type="button" data-pd-copy-code="${codeBlockIdx}" title="Copy code">${ico('copy')}<span>Copy</span></button>` +
          `<pre data-pd-code-block="${codeBlockIdx}"><code>${esc(raw)}</code></pre></div>`
        );
        codeBlockIdx++;
        codeLines = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeLines.push(ln); continue; }

    const trimmed = ln.trim();
    if (!trimmed) { closeLists(); continue; }

    const cb = ln.match(/^(\s*)[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (cb) {
      if (inOl) { html.push('</ol>'); inOl = false; }
      if (!inUl) { html.push('<ul class="pd-md-checks">'); inUl = true; }
      const checked = cb[2].toLowerCase() === 'x';
      const attr = noteId ? `data-pd-toggle-check="${idx}"` : '';
      html.push(
        `<li class="pd-md-check${checked ? ' is-done' : ''}">` +
        `<button type="button" class="pd-chk" ${attr} aria-pressed="${checked}" aria-label="Toggle item">${checked ? ico('check') : ''}</button>` +
        `<span>${inlineFmt(cb[3])}</span></li>`
      );
      continue;
    }

    const h = ln.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      closeLists();
      const lvl = h[1].length + 1; // h2..h4 inside section
      html.push(`<h${lvl}>${inlineFmt(h[2])}</h${lvl}>`);
      continue;
    }

    if (/^[-*_]{3,}$/.test(trimmed)) { closeLists(); html.push('<hr>'); continue; }

    const bq = ln.match(/^>\s?(.*)$/);
    if (bq) { closeLists(); html.push(`<blockquote>${inlineFmt(bq[1])}</blockquote>`); continue; }

    const ul = ln.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      if (inOl) { html.push('</ol>'); inOl = false; }
      if (!inUl) { html.push('<ul>'); inUl = true; }
      html.push(`<li>${inlineFmt(ul[1])}</li>`);
      continue;
    }

    const ol = ln.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      if (inUl) { html.push('</ul>'); inUl = false; }
      if (!inOl) { html.push('<ol>'); inOl = true; }
      html.push(`<li>${inlineFmt(ol[1])}</li>`);
      continue;
    }

    closeLists();
    html.push(`<p>${inlineFmt(ln)}</p>`);
  }
  if (inCode) {
    html.push(`<div class="pd-md-code"><pre><code>${esc(codeLines.join('\n'))}</code></pre></div>`);
  }
  closeLists();
  return html.join('') || '<p class="pd-empty-note">Nothing written yet.</p>';
}

function fmtExactTime(epoch) {
  if (!epoch) return '';
  return new Date(epoch * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function fileExtBadge(name) {
  const m = String(name || '').match(/\.([a-z0-9]{1,6})$/i);
  return (m ? m[1] : 'FILE').toUpperCase();
}

// ---- lifecycle & data loading -------------------------------------------------------------------

export function onView(v) {
  const was = active;
  active = v === 'padd';
  if (active && !started) {
    started = true;
    mountShell();
    bindEvents();
    api.subscribe(() => {
      if (!active) return;
      loadDrops({ quiet: true });
      loadNotes({ quiet: true });
      if (tab === 'shop') loadLists({ quiet: true });
    }, ok => {
      if (ok && active) {
        loadDrops({ quiet: true });
        loadNotes({ quiet: true });
        if (tab === 'shop') loadLists({ quiet: true });
      }
    }, '/api/owner/events', ['padd', 'config']);
  }
  if (active && !was) {
    loadDrops();
    loadNotes({ quiet: true });
    loadLists({ quiet: true });
  }
}

async function loadDrops({ quiet = false } = {}) {
  if (!quiet) { dropLoading = true; dropError = null; renderDropFeed(); }
  try {
    const res = await api.get(`${API}/drops?limit=200`);
    drops = res.drops || [];
    storage = res.storage || null;
    deviceInfo = res.device || null;
    zebralabAvailable = !!res.zebralab_available;
    dropError = null;
  } catch (err) {
    dropError = err.message;
  } finally {
    dropLoading = false;
    updateTabCounts();
    renderDropStorage();
    renderDropFeed();
  }
}

async function loadNotes({ quiet = false } = {}) {
  try {
    const qs = new URLSearchParams({ archived: noteArchived ? '1' : '0' });
    const res = await api.get(`${API}/notes?${qs}`);
    notes = res.notes || [];
    noteTags = res.tags || [];
    if (selectedNoteId && !notes.some(n => n.id === selectedNoteId)) {
      selectedNoteId = notes[0]?.id || null;
      mobileNoteOpen = false;
    } else if (!selectedNoteId && notes.length && window.innerWidth > 860) {
      selectedNoteId = notes[0].id;
    }
    updateTabCounts();
    renderNotesList();
    // Never overwrite the note editor while the user has unsaved local keystrokes.
    if (!noteDirty && !noteSaving) renderNotePane();
  } catch (err) {
    if (!quiet) toast(`Couldn't load notes: ${err.message}`);
  }
}

async function loadLists({ quiet = false } = {}) {
  if (!quiet) { haLoading = true; renderShop(); }
  try {
    haState = await api.get(`${API}/lists`);
    const lists = haState?.lists || [];
    if (lists.length && !lists.some(l => l.entity_id === selectedListId)) {
      selectedListId = lists[0].entity_id;
      saveSelectedList(selectedListId);
    }
  } catch (err) {
    haState = { available: false, error: err.message, lists: [] };
  } finally {
    haLoading = false;
    updateTabCounts();
    renderShop();
  }
}

// ---- shell mount (rendered once so typing inputs never lose focus on SSE refreshes) -------------

function mountShell() {
  if (mounted) return;
  mounted = true;
  root.innerHTML = `
    <div class="pd" data-pd-tab="${esc(tab)}">
      <div class="pd-bar">
        <div class="pd-tabs" role="tablist" aria-label="PADD sections">
          <button class="pd-tab" type="button" role="tab" data-pd-switch="drop" aria-selected="${tab === 'drop'}">${ico('dock')}<span>Dropzone</span><em class="pd-cnt" data-pd-cnt="drop">0</em></button>
          <button class="pd-tab" type="button" role="tab" data-pd-switch="notes" aria-selected="${tab === 'notes'}">${ico('note')}<span>Notes</span><em class="pd-cnt" data-pd-cnt="notes">0</em></button>
          <button class="pd-tab" type="button" role="tab" data-pd-switch="shop" aria-selected="${tab === 'shop'}">${ico('list')}<span>Shopping</span><em class="pd-cnt" data-pd-cnt="shop" hidden>0</em></button>
        </div>
        <div class="pd-bar__meta" data-pd-bar-meta></div>
      </div>

      <div class="pd-body">
        <!-- DROPZONE -->
        <section class="pd-panel pd-drop" data-pd-panel="drop" ${tab === 'drop' ? '' : 'hidden'}>
          <aside class="pd-capture">
            <div class="card pd-cap-card">
              <div class="card__in">
                <div class="card__head">
                  <h2 class="card__title">Quick drop</h2>
                  <div class="pd-kinds" role="group" aria-label="Drop type">
                    <button type="button" class="pd-kind is-on" data-pd-mode="auto">Auto</button>
                    <button type="button" class="pd-kind" data-pd-mode="text">Text</button>
                    <button type="button" class="pd-kind" data-pd-mode="code">Code</button>
                  </div>
                </div>
                <div class="card__body pd-cap-body">
                  <form class="pd-cap-form" data-pd-drop-form>
                    <textarea class="pd-textarea" data-pd-input rows="3" placeholder="Paste a link, text, or snippet…"></textarea>
                    <div class="pd-cap-extra">
                      <input class="pd-input pd-input--sm" type="text" data-pd-title maxlength="160" placeholder="Optional label">
                      <button class="btn btn--solid pd-send-btn" type="submit" data-pd-submit>${ico('send')}<span>Drop</span></button>
                    </div>
                  </form>

                  <div class="pd-file-zone" data-pd-dropzone tabindex="0" role="button" aria-label="Upload files">
                    ${ico('upload', 'pd-file-zone__ico')}
                    <div class="pd-file-zone__txt">
                      <strong>Drop files here or tap to pick</strong>
                      <span>Up to 500 MB per file · Ctrl+V pastes screenshots</span>
                    </div>
                    <div class="pd-file-btns">
                      <button type="button" class="btn pd-pick-btn" data-pd-pick-any>${ico('file')}<span>Files</span></button>
                      <button type="button" class="btn pd-pick-btn" data-pd-pick-img>${ico('image')}<span>Photo</span></button>
                    </div>
                    <input type="file" multiple hidden data-pd-file-any>
                    <input type="file" accept="image/*" multiple hidden data-pd-file-img>
                  </div>

                  <div class="pd-progress" data-pd-progress hidden></div>
                </div>
              </div>
            </div>

            <div class="card pd-storage-card">
              <div class="card__in">
                <div class="card__body pd-storage-body" data-pd-storage></div>
              </div>
            </div>
          </aside>

          <div class="pd-stream">
            <div class="pd-toolbar">
              <div class="pd-chips" role="group" aria-label="Filter drops">
                <button type="button" class="pd-chip is-on" data-pd-filter="all">All</button>
                <button type="button" class="pd-chip" data-pd-filter="link">Links</button>
                <button type="button" class="pd-chip" data-pd-filter="text">Text &amp; code</button>
                <button type="button" class="pd-chip" data-pd-filter="image">Images</button>
                <button type="button" class="pd-chip" data-pd-filter="file">Files</button>
                <button type="button" class="pd-chip" data-pd-filter="pinned">Pinned</button>
              </div>
              <div class="pd-search-wrap">
                <input class="pd-input pd-search" type="search" data-pd-drop-search placeholder="Search drops…" aria-label="Search drops">
              </div>
            </div>
            <div class="pd-feed" data-pd-feed></div>
          </div>

          <div class="pd-drag-overlay" data-pd-drag-overlay hidden>
            <div class="pd-drag-overlay__box">${ico('upload')}<span>Release to drop into PADD</span></div>
          </div>
        </section>

        <!-- NOTES & CHECKLISTS -->
        <section class="pd-panel pd-notes" data-pd-panel="notes" ${tab === 'notes' ? '' : 'hidden'}>
          <aside class="pd-notes-rail" data-pd-notes-rail>
            <div class="pd-notes-head">
              <button type="button" class="btn btn--solid pd-new-btn" data-pd-new-note="note">${ico('plus')}<span>Note</span></button>
              <button type="button" class="btn pd-new-btn" data-pd-new-note="checklist">${ico('check')}<span>Checklist</span></button>
            </div>
            <div class="pd-notes-filters">
              <input class="pd-input pd-search" type="search" data-pd-note-search placeholder="Search notes…" aria-label="Search notes">
              <div class="pd-notes-tags" data-pd-note-tags></div>
            </div>
            <div class="pd-notes-list" data-pd-notes-list></div>
          </aside>
          <div class="pd-note-pane" data-pd-note-pane></div>
        </section>

        <!-- SHOPPING / HA TODO -->
        <section class="pd-panel pd-shop" data-pd-panel="shop" ${tab === 'shop' ? '' : 'hidden'}>
          <div class="pd-shop-wrap" data-pd-shop></div>
        </section>
      </div>

      <dialog class="pd-dlg" data-pd-share-dlg aria-label="Share drop"></dialog>
      <dialog class="pd-dlg pd-dlg--img" data-pd-img-dlg aria-label="Image preview"></dialog>
    </div>
  `;
  renderDropStorage();
  renderDropFeed();
  renderNotesList();
  renderNotePane();
  renderShop();
  updateBarMeta();
}

function switchTab(next) {
  if (tab === next) return;
  if (tab === 'notes' && noteDirty) flushNoteSave();
  tab = next;
  saveTab(tab);
  const wrap = $('.pd', root);
  if (wrap) wrap.dataset.pdTab = tab;
  $$('[data-pd-switch]', root).forEach(b => b.setAttribute('aria-selected', String(b.dataset.pdSwitch === tab)));
  $$('[data-pd-panel]', root).forEach(p => { p.hidden = p.dataset.pdPanel !== tab; });
  updateBarMeta();
  if (tab === 'notes') { renderNotesList(); renderNotePane(); }
  if (tab === 'shop') { loadLists({ quiet: !!haState }); }
}

function updateTabCounts() {
  const dc = $('[data-pd-cnt="drop"]', root);
  if (dc) dc.textContent = String(drops.length);
  const nc = $('[data-pd-cnt="notes"]', root);
  if (nc) nc.textContent = String(notes.length);
  const sc = $('[data-pd-cnt="shop"]', root);
  if (sc) {
    const open = (haState?.lists || []).reduce((acc, l) => acc + (l.open_count || 0), 0);
    sc.hidden = !haState?.available || !(haState?.lists || []).length;
    sc.textContent = String(open);
  }
  updateBarMeta();
}

function updateBarMeta() {
  const el = $('[data-pd-bar-meta]', root);
  if (!el) return;
  if (tab === 'drop' && storage) {
    el.innerHTML = `<span class="pd-meta-pill">${esc(bytes(storage.used_bytes))} / ${esc(bytes(storage.cap_bytes))}</span>`;
  } else if (tab === 'notes') {
    el.innerHTML = `<button type="button" class="pd-meta-btn${noteArchived ? ' is-on' : ''}" data-pd-toggle-archived>${ico('archive')}<span>${noteArchived ? 'Showing archived' : 'Archived'}</span></button>`;
  } else if (tab === 'shop') {
    el.innerHTML = `<button type="button" class="pd-meta-btn" data-pd-shop-refresh>${ico('refresh')}<span>Refresh</span></button>`;
  } else {
    el.innerHTML = '';
  }
}

// ---- Dropzone rendering -------------------------------------------------------------------------

function renderDropStorage() {
  const el = $('[data-pd-storage]', root);
  if (!el) return;
  const used = storage?.used_bytes || 0;
  const cap = storage?.cap_bytes || (5 * 1024 * 1024 * 1024);
  const pct = Math.min(100, Math.round((used / cap) * 1000) / 10);
  const unpinnedCount = drops.filter(d => !d.pinned).length;
  const armed = Date.now() < clearArmedUntil;
  const origin = `${location.protocol}//${location.host}`;

  el.innerHTML = `
    <div class="pd-st-row">
      <span class="pd-st-label">Dropzone storage</span>
      <span class="pd-st-val">${esc(bytes(used))} / ${esc(bytes(cap))}</span>
    </div>
    <div class="pd-st-bar"><span class="pd-st-fill" style="width:${pct}%"></span></div>
    <div class="pd-st-foot">
      <span class="pd-st-meta">${drops.length} item${drops.length === 1 ? '' : 's'}${storage?.pinned_count ? ` · ${storage.pinned_count} pinned` : ''}</span>
      <div class="pd-st-acts">
        <button type="button" class="pd-link-btn" data-pd-toggle-cli>${ico('term')}<span>CLI</span></button>
        <button type="button" class="pd-clear-btn${armed ? ' is-armed' : ''}" data-pd-clear-unpinned ${unpinnedCount ? '' : 'disabled'}>
          ${armed ? `Confirm clear (${unpinnedCount})` : 'Clear unpinned'}
        </button>
      </div>
    </div>
    ${cliHelpOpen ? `
      <div class="pd-cli-box">
        <p class="pd-cli-title">Terminal CLI (Linux machines)</p>
        <pre class="pd-cli-code"><code>ln -sf ~/Projects/Citadel/tools/padd_cli.py ~/.local/bin/padd
padd login &lt;enrol-link-from-Settings-Screens&gt;
padd "https://example.com"
journalctl -n 20 | padd --code
padd photo.png
padd get | wl-copy</code></pre>
        <div class="pd-cli-acts">
          <button type="button" class="btn" data-pd-copy-cli>${ico('copy')}<span class="pd-copy-lbl">Copy setup</span></button>
          <span class="pd-cli-host">${esc(origin)}</span>
        </div>
      </div>
    ` : ''}
  `;
}

function renderUploadProgress() {
  const el = $('[data-pd-progress]', root);
  if (!el) return;
  if (!activeUpload) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  const pct = activeUpload.total ? Math.min(100, Math.round((activeUpload.loaded / activeUpload.total) * 100)) : 0;
  el.innerHTML = `
    <div class="pd-prog-row">
      <span class="pd-prog-name">${esc(activeUpload.name)}</span>
      <span class="pd-prog-pct">${pct}% · ${esc(bytes(activeUpload.loaded))} / ${esc(bytes(activeUpload.total))}</span>
      <button type="button" class="pd-icon-btn" data-pd-cancel-upload title="Cancel upload" aria-label="Cancel upload">${ico('x')}</button>
    </div>
    <div class="pd-st-bar"><span class="pd-st-fill" style="width:${pct}%"></span></div>
  `;
}

function filteredDrops() {
  const needle = dropQuery.trim().toLowerCase();
  return drops.filter(d => {
    if (dropFilter === 'pinned' && !d.pinned) return false;
    if (dropFilter === 'link' && d.kind !== 'link') return false;
    if (dropFilter === 'text' && d.kind !== 'text' && d.kind !== 'code') return false;
    if (dropFilter === 'image' && d.kind !== 'image') return false;
    if (dropFilter === 'file' && d.kind !== 'file') return false;
    if (needle) {
      const hay = `${d.title} ${d.body} ${d.url || ''} ${d.url_description || ''} ${d.file_name || ''} ${d.device_name || ''}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

function dropIcon(kind) {
  return { link: 'link', code: 'code', image: 'image', file: 'file', text: 'note' }[kind] || 'note';
}

function renderDropCard(d) {
  const id = esc(d.id);
  const isLong = (d.kind === 'text' || d.kind === 'code') && (d.body.length > 420 || d.body.split('\n').length > 8);
  const expanded = expandedDrops.has(d.id);
  const devBadge = d.device_name ? `<span class="pd-dev">${esc(d.device_name)}</span>` : '';

  let bodyHtml = '';
  let primaryBtn = '';

  if (d.kind === 'link' && d.url) {
    const href = esc(safeUrl(d.url));
    bodyHtml = `
      <div class="pd-link-card">
        <a class="pd-link-title" href="${href}" target="_blank" rel="noopener noreferrer">${esc(d.title || d.url_host || d.url)}</a>
        ${d.url_description ? `<p class="pd-link-desc">${esc(d.url_description)}</p>` : ''}
        <div class="pd-link-meta">
          ${d.url_host ? `<span class="pd-host">${esc(d.url_host)}</span>` : ''}
          <span class="pd-link-url">${esc(d.url)}</span>
        </div>
      </div>`;
    primaryBtn = `
      <button type="button" class="btn btn--solid pd-act-main" data-pd-copy-drop="${id}">${ico('copy')}<span class="pd-copy-lbl">Copy</span></button>
      <a class="btn pd-act-open" href="${href}" target="_blank" rel="noopener noreferrer">${ico('ext')}<span>Open</span></a>`;
  } else if (d.kind === 'code') {
    const shown = isLong && !expanded ? d.body.split('\n').slice(0, 8).join('\n') : d.body;
    const lineCount = d.body.split('\n').length;
    bodyHtml = `
      ${d.title ? `<div class="pd-drop-title">${esc(d.title)}</div>` : ''}
      <pre class="pd-code-box"><code>${esc(shown)}</code></pre>
      ${isLong ? `<button type="button" class="pd-more-btn" data-pd-expand="${id}">${expanded ? 'Show less' : `Show all ${lineCount} lines`}</button>` : ''}`;
    primaryBtn = `<button type="button" class="btn btn--solid pd-act-main" data-pd-copy-drop="${id}">${ico('copy')}<span class="pd-copy-lbl">Copy</span></button>`;
  } else if (d.kind === 'image') {
    const src = `${API}/files/${encodeURIComponent(d.id)}?inline=1`;
    bodyHtml = `
      <div class="pd-img-row">
        <button type="button" class="pd-thumb-btn" data-pd-lightbox="${id}" aria-label="View full image">
          <img class="pd-thumb" src="${esc(src)}" alt="${esc(d.file_name || 'Dropped image')}" loading="lazy">
        </button>
        <div class="pd-file-info">
          <div class="pd-drop-title">${esc(d.file_name || d.title || 'Image')}</div>
          <div class="pd-file-sub">${esc(bytes(d.size_bytes))}${d.mime_type ? ` · ${esc(d.mime_type.replace('image/', '').toUpperCase())}` : ''}</div>
          ${d.body ? `<p class="pd-caption">${esc(d.body)}</p>` : ''}
        </div>
      </div>`;
    primaryBtn = `<button type="button" class="btn btn--solid pd-act-main" data-pd-download="${id}">${ico('download')}<span>Download</span></button>`;
  } else if (d.kind === 'file') {
    bodyHtml = `
      <div class="pd-file-row">
        <span class="pd-ext-badge">${esc(fileExtBadge(d.file_name))}</span>
        <div class="pd-file-info">
          <div class="pd-drop-title">${esc(d.file_name || d.title || 'File')}</div>
          <div class="pd-file-sub">${esc(bytes(d.size_bytes))}${d.mime_type && d.mime_type !== 'application/octet-stream' ? ` · ${esc(d.mime_type)}` : ''}</div>
          ${d.body ? `<p class="pd-caption">${esc(d.body)}</p>` : ''}
        </div>
      </div>`;
    primaryBtn = `<button type="button" class="btn btn--solid pd-act-main" data-pd-download="${id}">${ico('download')}<span>Download</span></button>`;
  } else {
    const shown = isLong && !expanded ? d.body.slice(0, 420) + '…' : d.body;
    bodyHtml = `
      ${d.title ? `<div class="pd-drop-title">${esc(d.title)}</div>` : ''}
      <div class="pd-text-body">${linkifyBare(shown).replace(/\n/g, '<br>')}</div>
      ${isLong ? `<button type="button" class="pd-more-btn" data-pd-expand="${id}">${expanded ? 'Show less' : 'Show more'}</button>` : ''}`;
    primaryBtn = `<button type="button" class="btn btn--solid pd-act-main" data-pd-copy-drop="${id}">${ico('copy')}<span class="pd-copy-lbl">Copy</span></button>`;
  }

  const zebraBtn = zebralabAvailable && d.can_zebralab_doc
    ? `<button type="button" class="pd-act-sub" data-pd-zebra="${id}" title="Send to ZebraLab">${ico('printer')}<span>ZebraLab</span></button>`
    : '';
  const promoteBtn = (d.kind === 'text' || d.kind === 'link' || d.kind === 'code')
    ? `<button type="button" class="pd-act-sub" data-pd-promote="${id}" title="Save as Note">${ico('note')}<span>Save note</span></button>`
    : '';

  return `
    <article class="card pd-card pd-card--${esc(d.kind)}${d.pinned ? ' is-pinned' : ''}" data-pd-drop-id="${id}">
      <div class="card__in">
        <div class="pd-card__head">
          <span class="pd-card__kind">${ico(dropIcon(d.kind))}<span>${esc(d.kind)}</span></span>
          ${devBadge}
          <span class="pd-time" title="${esc(fmtExactTime(d.created_at))}">${esc(ago(d.created_at))}</span>
          <button type="button" class="pd-pin-btn${d.pinned ? ' is-on' : ''}" data-pd-pin-drop="${id}" aria-pressed="${d.pinned}" title="${d.pinned ? 'Unpin' : 'Pin'}">${ico('pin')}</button>
        </div>
        <div class="pd-card__body">${bodyHtml}</div>
        <div class="pd-card__acts">
          <div class="pd-card__primary">${primaryBtn}</div>
          <div class="pd-card__secondary">
            <button type="button" class="pd-act-sub" data-pd-share="${id}" title="QR code & temporary share link">${ico('qr')}<span>Share</span></button>
            ${promoteBtn}
            ${zebraBtn}
            <button type="button" class="pd-act-sub pd-act-sub--bad" data-pd-del-drop="${id}" title="Delete drop" aria-label="Delete drop">${ico('bin')}</button>
          </div>
        </div>
      </div>
    </article>
  `;
}

function renderDropFeed() {
  const el = $('[data-pd-feed]', root);
  if (!el) return;
  if (dropLoading && !drops.length) {
    el.innerHTML = '<div class="pd-empty">Loading Dropzone…</div>';
    return;
  }
  if (dropError && !drops.length) {
    el.innerHTML = `<div class="pd-empty pd-empty--err">${esc(dropError)}</div>`;
    return;
  }
  const items = filteredDrops();
  if (!items.length) {
    el.innerHTML = drops.length
      ? '<div class="pd-empty">No drops match that filter.</div>'
      : '<div class="pd-empty">Dropzone is clear. Paste a link, drop a file, or pipe from any machine with <code>padd</code>.</div>';
    return;
  }
  el.innerHTML = items.map(renderDropCard).join('');
}

// ---- Notes & Checklists rendering ---------------------------------------------------------------

function filteredNotes() {
  const needle = noteQuery.trim().toLowerCase();
  return notes.filter(n => {
    if (noteTag && !(n.tags || []).includes(noteTag)) return false;
    if (needle) {
      const hay = `${n.title} ${n.body} ${(n.tags || []).join(' ')}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

function renderNotesList() {
  const panel = $('[data-pd-panel="notes"]', root);
  if (panel) panel.classList.toggle('is-reading', mobileNoteOpen && !!selectedNoteId);

  const tagsEl = $('[data-pd-note-tags]', root);
  if (tagsEl) {
    if (!noteTags.length) {
      tagsEl.innerHTML = '';
    } else {
      tagsEl.innerHTML = [
        `<button type="button" class="pd-tag-chip${!noteTag ? ' is-on' : ''}" data-pd-filter-tag="">All</button>`,
        ...noteTags.map(t => `<button type="button" class="pd-tag-chip${noteTag === t.name ? ' is-on' : ''}" data-pd-filter-tag="${esc(t.name)}">#${esc(t.name)} <span>${t.count}</span></button>`),
      ].join('');
    }
  }

  const listEl = $('[data-pd-notes-list]', root);
  if (!listEl) return;
  const items = filteredNotes();
  if (!items.length) {
    listEl.innerHTML = `<div class="pd-empty">${noteArchived ? 'No archived notes.' : 'No notes yet. Create a note or checklist above.'}</div>`;
    return;
  }
  listEl.innerHTML = items.map(n => {
    const sel = n.id === selectedNoteId;
    const preview = n.kind === 'checklist'
      ? (n.check_total ? `${n.check_done} of ${n.check_total} done` : 'Empty checklist')
      : (n.body || '').replace(/[#*`>\-[\]]/g, '').trim().slice(0, 88) || 'Empty note';
    return `
      <button type="button" class="pd-note-row${sel ? ' is-selected' : ''}${n.pinned ? ' is-pinned' : ''}" data-pd-open-note="${esc(n.id)}">
        <div class="pd-note-row__top">
          <span class="pd-note-row__ico">${ico(n.kind === 'checklist' ? 'check' : 'note')}</span>
          <strong class="pd-note-row__title">${esc(n.title)}</strong>
          ${n.pinned ? `<span class="pd-note-row__pin">${ico('pin')}</span>` : ''}
        </div>
        <p class="pd-note-row__prev">${esc(preview)}</p>
        <div class="pd-note-row__meta">
          <span>${esc(ago(n.updated_at))}</span>
          ${(n.tags || []).slice(0, 3).map(t => `<span class="pd-mini-tag">#${esc(t)}</span>`).join('')}
        </div>
      </button>
    `;
  }).join('');
}

function parseChecklistItems(body) {
  const items = [];
  const lines = String(body || '').split('\n');
  lines.forEach((ln, idx) => {
    const m = ln.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (m) items.push({ lineIndex: idx, done: m[1].toLowerCase() === 'x', text: m[2] });
  });
  return items;
}

function renderNotePane() {
  const pane = $('[data-pd-note-pane]', root);
  if (!pane) return;
  const n = notes.find(x => x.id === selectedNoteId);
  if (!n) {
    pane.innerHTML = `
      <div class="card pd-note-empty-card"><div class="card__in"><div class="pd-empty">
        Select a note or create a new one.
      </div></div></div>`;
    return;
  }

  const id = esc(n.id);
  const armedDel = noteDeleteArmedId === n.id;
  const saveLabel = noteSaving ? 'Saving…' : noteDirty ? 'Unsaved' : `Saved · ${ago(n.updated_at)}`;
  const tagsHtml = (n.tags || []).map(t =>
    `<span class="pd-tag-pill">#${esc(t)}<button type="button" data-pd-rm-tag="${esc(t)}" aria-label="Remove tag ${esc(t)}">${ico('x')}</button></span>`
  ).join('');

  let bodyArea = '';
  if (n.kind === 'checklist' && !noteChecklistRaw) {
    const items = parseChecklistItems(n.body);
    const done = items.filter(i => i.done).length;
    bodyArea = `
      <div class="pd-cl-wrap">
        <form class="pd-cl-add" data-pd-cl-add-form>
          <input class="pd-input" type="text" data-pd-cl-new placeholder="Add checklist item…" maxlength="200">
          <button type="submit" class="btn btn--solid">${ico('plus')}<span>Add</span></button>
        </form>
        <div class="pd-cl-bar">
          <span class="pd-cl-stat">${done} / ${items.length} completed</span>
          <div class="pd-cl-acts">
            <button type="button" class="pd-link-btn" data-pd-cl-act="reset" ${done ? '' : 'disabled'}>Reset all</button>
            <button type="button" class="pd-link-btn" data-pd-cl-act="clear_done" ${done ? '' : 'disabled'}>Clear done</button>
            <button type="button" class="pd-link-btn" data-pd-cl-raw>Edit text</button>
          </div>
        </div>
        <div class="pd-cl-list">
          ${items.length ? items.map(it => `
            <div class="pd-cl-item${it.done ? ' is-done' : ''}">
              <button type="button" class="pd-chk" data-pd-toggle-check="${it.lineIndex}" aria-pressed="${it.done}" aria-label="Toggle item">${it.done ? ico('check') : ''}</button>
              <span class="pd-cl-text">${inlineFmt(it.text)}</span>
              <button type="button" class="pd-icon-btn" data-pd-cl-del-line="${it.lineIndex}" title="Remove item" aria-label="Remove item">${ico('x')}</button>
            </div>
          `).join('') : '<div class="pd-empty">No items yet — add one above.</div>'}
        </div>
      </div>`;
  } else {
    const mode = n.kind === 'checklist' ? 'edit' : noteViewMode;
    bodyArea = `
      <div class="pd-ed-modes">
        ${n.kind === 'checklist' ? `
          <button type="button" class="pd-link-btn" data-pd-cl-raw>Back to checklist</button>
        ` : `
          <div class="pd-kinds" role="group" aria-label="Editor view">
            <button type="button" class="pd-kind${mode === 'edit' ? ' is-on' : ''}" data-pd-note-mode="edit">Edit</button>
            <button type="button" class="pd-kind${mode === 'preview' ? ' is-on' : ''}" data-pd-note-mode="preview">Preview</button>
            <button type="button" class="pd-kind pd-kind--wide${mode === 'split' ? ' is-on' : ''}" data-pd-note-mode="split">Split</button>
          </div>
        `}
        <span class="pd-save-state" data-pd-save-state>${esc(saveLabel)}</span>
      </div>
      <div class="pd-ed-stage pd-ed-stage--${esc(mode)}">
        ${mode !== 'preview' ? `<textarea class="pd-ed-area" data-pd-note-body placeholder="Write in Markdown… (- [ ] adds a checkbox)">${esc(n.body)}</textarea>` : ''}
        ${mode !== 'edit' ? `<div class="pd-md-preview" data-pd-md-preview>${renderMarkdown(n.body, n.id)}</div>` : ''}
      </div>`;
  }

  pane.innerHTML = `
    <div class="card pd-note-card">
      <div class="card__in">
        <div class="pd-note-top">
          <button type="button" class="btn pd-back-btn" data-pd-note-back>${ico('back')}<span>Notes</span></button>
          <input class="pd-note-title-in" type="text" data-pd-note-title value="${esc(n.title)}" maxlength="120" aria-label="Note title">
          <div class="pd-note-acts">
            <button type="button" class="pd-icon-btn${n.pinned ? ' is-on' : ''}" data-pd-note-pin aria-pressed="${n.pinned}" title="${n.pinned ? 'Unpin' : 'Pin'}">${ico('pin')}</button>
            <button type="button" class="pd-icon-btn" data-pd-note-copy title="Copy note">${ico('copy')}</button>
            <button type="button" class="pd-icon-btn" data-pd-note-todrop title="Send to Dropzone">${ico('send')}</button>
            <button type="button" class="pd-icon-btn${n.archived ? ' is-on' : ''}" data-pd-note-archive title="${n.archived ? 'Restore from archive' : 'Archive'}">${ico('archive')}</button>
            <button type="button" class="pd-icon-btn pd-icon-btn--bad${armedDel ? ' is-armed' : ''}" data-pd-note-del title="${armedDel ? 'Tap again to delete' : 'Delete note'}">${armedDel ? 'Confirm' : ico('bin')}</button>
          </div>
        </div>
        <div class="pd-note-tags-bar">
          ${tagsHtml}
          <input class="pd-tag-in" type="text" data-pd-add-tag placeholder="+ tag" maxlength="24" aria-label="Add tag">
        </div>
        <div class="pd-note-content">${bodyArea}</div>
      </div>
    </div>
  `;
}

// ---- Shopping / Home Assistant Todo rendering ---------------------------------------------------

function renderShop() {
  const wrap = $('[data-pd-shop]', root);
  if (!wrap) return;
  if (haLoading && !haState) {
    wrap.innerHTML = '<div class="card"><div class="card__in"><div class="pd-empty">Loading Home Assistant lists…</div></div></div>';
    return;
  }
  if (!haState?.available) {
    wrap.innerHTML = `
      <div class="card pd-shop-card"><div class="card__in"><div class="card__body pd-shop-empty">
        <h3>Home Assistant lists unavailable</h3>
        <p>${esc(haState?.error || 'Could not reach Home Assistant on Probe-1.')}</p>
        <button type="button" class="btn btn--solid" data-pd-shop-refresh>${ico('refresh')}<span>Try again</span></button>
      </div></div></div>`;
    return;
  }
  const lists = haState.lists || [];
  if (!lists.length) {
    wrap.innerHTML = `
      <div class="card pd-shop-card"><div class="card__in"><div class="card__body pd-shop-empty">
        <h3>No Home Assistant lists found</h3>
        <p>Add a Local To-do or Shopping List integration in Home Assistant (Probe-1), then refresh here.</p>
        <button type="button" class="btn btn--solid" data-pd-shop-refresh>${ico('refresh')}<span>Refresh</span></button>
      </div></div></div>`;
    return;
  }

  const cur = lists.find(l => l.entity_id === selectedListId) || lists[0];
  selectedListId = cur.entity_id;
  const openItems = cur.items.filter(i => i.status !== 'completed');
  const doneItems = cur.items.filter(i => i.status === 'completed');

  const switcher = lists.length > 1
    ? `<div class="pd-chips pd-shop-lists" role="group" aria-label="Home Assistant lists">
        ${lists.map(l => `<button type="button" class="pd-chip${l.entity_id === cur.entity_id ? ' is-on' : ''}" data-pd-shop-list="${esc(l.entity_id)}">${esc(l.name)} <span>${l.open_count}</span></button>`).join('')}
       </div>`
    : '';

  const renderRow = (it, done) => {
    const key = esc(it.uid || it.summary);
    if (editingTodoKey === (it.uid || it.summary)) {
      return `
        <form class="pd-shop-row is-editing" data-pd-todo-rename-form data-pd-todo-key="${key}">
          <input class="pd-input" type="text" data-pd-todo-rename-in value="${esc(it.summary)}" maxlength="200">
          <button type="submit" class="btn btn--solid">Save</button>
          <button type="button" class="btn" data-pd-todo-rename-cancel>Cancel</button>
        </form>`;
    }
    return `
      <div class="pd-shop-row${done ? ' is-done' : ''}">
        <button type="button" class="pd-chk" data-pd-todo-toggle="${key}" data-pd-todo-status="${done ? 'needs_action' : 'completed'}" aria-pressed="${done}" aria-label="Toggle ${esc(it.summary)}">${done ? ico('check') : ''}</button>
        <span class="pd-shop-txt">${esc(it.summary)}</span>
        <div class="pd-shop-row-acts">
          <button type="button" class="pd-icon-btn" data-pd-todo-edit="${key}" title="Rename" aria-label="Rename">${ico('edit')}</button>
          <button type="button" class="pd-icon-btn pd-icon-btn--bad" data-pd-todo-del="${key}" title="Remove" aria-label="Remove">${ico('x')}</button>
        </div>
      </div>`;
  };

  wrap.innerHTML = `
    ${switcher}
    <div class="card pd-shop-card">
      <div class="card__in">
        <div class="card__head">
          <h2 class="card__title">${esc(cur.name)}</h2>
          <span class="pd-st-meta">${openItems.length} to buy${doneItems.length ? ` · ${doneItems.length} done` : ''}</span>
        </div>
        <div class="card__body pd-shop-body">
          <form class="pd-shop-add" data-pd-todo-add-form>
            <input class="pd-input" type="text" data-pd-todo-add-in placeholder="Add to ${esc(cur.name)}…" maxlength="200" autocomplete="off">
            <button type="submit" class="btn btn--solid">${ico('plus')}<span>Add</span></button>
          </form>

          <div class="pd-shop-items">
            ${openItems.length ? openItems.map(i => renderRow(i, false)).join('') : '<div class="pd-empty">All clear — nothing on the list.</div>'}
          </div>

          ${doneItems.length ? `
            <div class="pd-shop-done">
              <div class="pd-shop-done__head">
                <button type="button" class="pd-link-btn" data-pd-shop-toggle-done aria-expanded="${completedOpen}">
                  ${completedOpen ? 'Hide' : 'Show'} completed (${doneItems.length})
                </button>
                <button type="button" class="pd-link-btn pd-link-btn--bad" data-pd-todo-clear>Clear completed</button>
              </div>
              ${completedOpen ? `<div class="pd-shop-items">${doneItems.map(i => renderRow(i, true)).join('')}</div>` : ''}
            </div>
          ` : ''}
        </div>
      </div>
    </div>
  `;
}

// ---- Modals (QR Share & Image Lightbox) ---------------------------------------------------------

async function openShareModal(dropId, ttl = 900) {
  const dlg = $('[data-pd-share-dlg]', root);
  if (!dlg) return;
  shareModalState = { dropId, ttl, loading: true, data: null, error: null };
  renderShareModal();
  if (!dlg.open) dlg.showModal();
  try {
    const data = await api.post(`${API}/drops/${encodeURIComponent(dropId)}/ticket`, { ttl, qr: true });
    if (shareModalState?.dropId === dropId) {
      shareModalState = { dropId, ttl, loading: false, data, error: null };
      renderShareModal();
    }
  } catch (err) {
    if (shareModalState?.dropId === dropId) {
      shareModalState = { dropId, ttl, loading: false, data: null, error: err.message };
      renderShareModal();
    }
  }
}

function renderShareModal() {
  const dlg = $('[data-pd-share-dlg]', root);
  if (!dlg || !shareModalState) return;
  const s = shareModalState;
  const d = drops.find(x => x.id === s.dropId);
  const label = d ? (d.title || d.file_name || d.url_host || 'Shared drop') : 'Shared drop';
  const ttls = [[300, '5 min'], [900, '15 min'], [3600, '1 hour']];

  let body = '';
  if (s.loading) {
    body = '<div class="pd-empty">Generating link &amp; QR code…</div>';
  } else if (s.error) {
    body = `<div class="pd-empty pd-empty--err">${esc(s.error)}</div>`;
  } else if (s.data) {
    body = `
      <div class="pd-qr-plate">${s.data.qr_svg || ''}</div>
      <div class="pd-share-url-row">
        <input class="pd-input pd-share-url" type="text" readonly value="${esc(s.data.share_url)}">
        <button type="button" class="btn btn--solid" data-pd-copy-share>${ico('copy')}<span class="pd-copy-lbl">Copy</span></button>
      </div>
      <div class="pd-share-ttl">
        <span>Expires in</span>
        <div class="pd-kinds">
          ${ttls.map(([sec, lbl]) => `<button type="button" class="pd-kind${s.ttl === sec ? ' is-on' : ''}" data-pd-share-ttl="${sec}">${lbl}</button>`).join('')}
        </div>
      </div>`;
  }

  dlg.innerHTML = `
    <div class="pd-dlg__head">
      <h3>Share · ${esc(label)}</h3>
      <button type="button" class="pd-icon-btn" data-pd-close-dlg aria-label="Close">${ico('x')}</button>
    </div>
    <div class="pd-dlg__body">${body}</div>
    <div class="pd-dlg__foot">
      <button type="button" class="btn pd-btn-bad" data-pd-revoke-share="${esc(s.dropId)}">Revoke link</button>
      <button type="button" class="btn" data-pd-close-dlg>Close</button>
    </div>
  `;
}

function openLightbox(dropId) {
  const dlg = $('[data-pd-img-dlg]', root);
  const d = drops.find(x => x.id === dropId);
  if (!dlg || !d) return;
  lightboxDropId = dropId;
  const src = `${API}/files/${encodeURIComponent(d.id)}?inline=1`;
  dlg.innerHTML = `
    <div class="pd-dlg__head">
      <h3>${esc(d.file_name || d.title || 'Image')} <small>${esc(bytes(d.size_bytes))}</small></h3>
      <button type="button" class="pd-icon-btn" data-pd-close-dlg aria-label="Close">${ico('x')}</button>
    </div>
    <div class="pd-img-stage"><img src="${esc(src)}" alt="${esc(d.file_name || 'Image')}"></div>
    <div class="pd-dlg__foot">
      <button type="button" class="btn btn--solid" data-pd-download="${esc(d.id)}">${ico('download')}<span>Download</span></button>
      <button type="button" class="btn" data-pd-share="${esc(d.id)}">${ico('qr')}<span>Share</span></button>
      ${zebralabAvailable && d.can_zebralab_asset ? `<button type="button" class="btn" data-pd-zebra="${esc(d.id)}" data-pd-zebra-target="asset">${ico('printer')}<span>ZebraLab asset</span></button>` : ''}
      <button type="button" class="btn" data-pd-close-dlg>Close</button>
    </div>
  `;
  if (!dlg.open) dlg.showModal();
}

// ---- Actions & API mutations --------------------------------------------------------------------

async function submitTextDrop() {
  const input = $('[data-pd-input]', root);
  const titleEl = $('[data-pd-title]', root);
  const text = input?.value || '';
  if (!text.trim()) { input?.focus(); return; }
  const btn = $('[data-pd-submit]', root);
  if (btn) btn.disabled = true;
  try {
    const res = await api.post(`${API}/drops`, {
      text,
      title: titleEl?.value || '',
      kind: dropMode,
      fetch_preview: true,
    });
    if (input) { input.value = ''; autoGrow(input); }
    if (titleEl) titleEl.value = '';
    if (res.drop) {
      drops = [res.drop, ...drops.filter(x => x.id !== res.drop.id)];
      storage = res.storage || storage;
      updateTabCounts();
      renderDropStorage();
      renderDropFeed();
    }
    toast('Dropped');
  } catch (err) {
    toast(err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function uploadFiles(fileList) {
  const files = [...(fileList || [])].filter(Boolean);
  if (!files.length) return;
  const caption = ($('[data-pd-title]', root)?.value || '').trim();
  for (const file of files) {
    await uploadOneFile(file, caption);
  }
  const titleEl = $('[data-pd-title]', root);
  if (titleEl && caption) titleEl.value = '';
}

function uploadOneFile(file, caption = '') {
  return new Promise(resolve => {
    const xhr = new XMLHttpRequest();
    activeUpload = { name: file.name || 'clipboard.png', loaded: 0, total: file.size || 0, xhr };
    renderUploadProgress();

    xhr.open('POST', `${API}/drops/file`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('X-Hub', '1');
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name || 'clipboard.png'));
    if (caption) xhr.setRequestHeader('X-Caption', encodeURIComponent(caption));
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');

    xhr.upload.onprogress = ev => {
      if (!activeUpload) return;
      activeUpload.loaded = ev.loaded;
      if (ev.lengthComputable) activeUpload.total = ev.total;
      renderUploadProgress();
    };
    xhr.onload = () => {
      activeUpload = null;
      renderUploadProgress();
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const res = JSON.parse(xhr.responseText);
          if (res.drop) {
            drops = [res.drop, ...drops.filter(x => x.id !== res.drop.id)];
            storage = res.storage || storage;
            updateTabCounts();
            renderDropStorage();
            renderDropFeed();
          }
          toast(`Uploaded ${file.name || 'file'}`);
        } catch { loadDrops({ quiet: true }); }
      } else {
        let msg = `Upload failed (${xhr.status})`;
        try { msg = JSON.parse(xhr.responseText).detail || msg; } catch { /* ignore */ }
        toast(msg);
      }
      resolve();
    };
    xhr.onerror = () => {
      activeUpload = null;
      renderUploadProgress();
      toast(`Upload failed for ${file.name || 'file'}`);
      resolve();
    };
    xhr.onabort = () => {
      activeUpload = null;
      renderUploadProgress();
      toast('Upload cancelled');
      resolve();
    };
    xhr.send(file);
  });
}

async function downloadDrop(dropId) {
  try {
    // Mints a short-lived signed /padd/dl/... URL so both desktop browsers and CitadelAndroid's external DownloadListener work seamlessly.
    const t = await api.post(`${API}/drops/${encodeURIComponent(dropId)}/ticket`, { ttl: 120, qr: false });
    if (!t.download_path) { toast('No file attached'); return; }
    const a = document.createElement('a');
    a.href = t.download_path;
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
  } catch (err) {
    toast(err.message);
  }
}

async function sendToZebraLab(dropId, target = 'document') {
  try {
    await api.post(`${API}/drops/${encodeURIComponent(dropId)}/send-zebralab`, { target });
    toast(target === 'asset' ? 'Saved image to ZebraLab assets' : 'Sent to ZebraLab — open Labels to print');
  } catch (err) {
    toast(err.message);
  }
}

// Note auto-save helpers
function scheduleNoteSave() {
  noteDirty = true;
  const st = $('[data-pd-save-state]', root);
  if (st) st.textContent = 'Unsaved';
  clearTimeout(noteSaveTimer);
  noteSaveTimer = setTimeout(flushNoteSave, 600);
}

async function flushNoteSave() {
  clearTimeout(noteSaveTimer);
  const n = notes.find(x => x.id === selectedNoteId);
  if (!n || !noteDirty) return;
  const titleEl = $('[data-pd-note-title]', root);
  const bodyEl = $('[data-pd-note-body]', root);
  const title = titleEl ? titleEl.value : n.title;
  const body = bodyEl ? bodyEl.value : n.body;
  noteSaving = true;
  noteDirty = false;
  const st = $('[data-pd-save-state]', root);
  if (st) st.textContent = 'Saving…';
  try {
    const res = await api.patch(`${API}/notes/${encodeURIComponent(n.id)}`, { title, body });
    if (res.note) {
      notes = notes.map(x => x.id === res.note.id ? res.note : x);
      renderNotesList();
      if (st) st.textContent = `Saved · ${ago(res.note.updated_at)}`;
    }
  } catch (err) {
    noteDirty = true;
    toast(`Couldn't save note: ${err.message}`);
  } finally {
    noteSaving = false;
  }
}

function autoGrow(ta) {
  if (!ta) return;
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
}

// ---- event binding ------------------------------------------------------------------------------

function bindEvents() {
  root.addEventListener('click', async e => {
    // Sub-tabs
    const sw = e.target.closest('[data-pd-switch]');
    if (sw) { switchTab(sw.dataset.pdSwitch); return; }

    // Drop kind selector
    const modeBtn = e.target.closest('[data-pd-mode]');
    if (modeBtn) {
      dropMode = modeBtn.dataset.pdMode;
      $$('[data-pd-mode]', root).forEach(b => b.classList.toggle('is-on', b.dataset.pdMode === dropMode));
      return;
    }

    // File pickers
    if (e.target.closest('[data-pd-pick-any]')) { $('[data-pd-file-any]', root)?.click(); return; }
    if (e.target.closest('[data-pd-pick-img]')) { $('[data-pd-file-img]', root)?.click(); return; }
    if (e.target.closest('[data-pd-dropzone]') && !e.target.closest('button')) {
      $('[data-pd-file-any]', root)?.click();
      return;
    }
    if (e.target.closest('[data-pd-cancel-upload]')) { activeUpload?.xhr?.abort(); return; }

    // Drop filter chips
    const flt = e.target.closest('[data-pd-filter]');
    if (flt) {
      dropFilter = flt.dataset.pdFilter;
      $$('[data-pd-filter]', root).forEach(b => b.classList.toggle('is-on', b.dataset.pdFilter === dropFilter));
      renderDropFeed();
      return;
    }

    // Drop actions
    const copyBtn = e.target.closest('[data-pd-copy-drop]');
    if (copyBtn) {
      const d = drops.find(x => x.id === copyBtn.dataset.pdCopyDrop);
      if (d) await copyText(d.kind === 'link' && d.url ? d.url : d.body, copyBtn);
      return;
    }

    const dlBtn = e.target.closest('[data-pd-download]');
    if (dlBtn) { await downloadDrop(dlBtn.dataset.pdDownload); return; }

    const lbBtn = e.target.closest('[data-pd-lightbox]');
    if (lbBtn) { openLightbox(lbBtn.dataset.pdLightbox); return; }

    const expBtn = e.target.closest('[data-pd-expand]');
    if (expBtn) {
      const id = expBtn.dataset.pdExpand;
      if (expandedDrops.has(id)) expandedDrops.delete(id); else expandedDrops.add(id);
      renderDropFeed();
      return;
    }

    const pinBtn = e.target.closest('[data-pd-pin-drop]');
    if (pinBtn) {
      const id = pinBtn.dataset.pdPinDrop;
      const d = drops.find(x => x.id === id);
      if (!d) return;
      try {
        await api.patch(`${API}/drops/${encodeURIComponent(id)}`, { pinned: !d.pinned });
        await loadDrops({ quiet: true });
      } catch (err) { toast(err.message); }
      return;
    }

    const delBtn = e.target.closest('[data-pd-del-drop]');
    if (delBtn) {
      const id = delBtn.dataset.pdDelDrop;
      try {
        await api.del(`${API}/drops/${encodeURIComponent(id)}`);
        drops = drops.filter(x => x.id !== id);
        await loadDrops({ quiet: true });
        toast('Drop deleted');
      } catch (err) { toast(err.message); }
      return;
    }

    const promBtn = e.target.closest('[data-pd-promote]');
    if (promBtn) {
      try {
        const res = await api.post(`${API}/drops/${encodeURIComponent(promBtn.dataset.pdPromote)}/promote`, {});
        toast('Saved to Notes');
        if (res.note) { selectedNoteId = res.note.id; await loadNotes({ quiet: true }); }
      } catch (err) { toast(err.message); }
      return;
    }

    const zBtn = e.target.closest('[data-pd-zebra]');
    if (zBtn) {
      zBtn.disabled = true;
      await sendToZebraLab(zBtn.dataset.pdZebra, zBtn.dataset.pdZebraTarget || 'document');
      zBtn.disabled = false;
      return;
    }

    const shareBtn = e.target.closest('[data-pd-share]');
    if (shareBtn) {
      const imgDlg = $('[data-pd-img-dlg]', root);
      if (imgDlg?.open) imgDlg.close();
      await openShareModal(shareBtn.dataset.pdShare);
      return;
    }

    const ttlBtn = e.target.closest('[data-pd-share-ttl]');
    if (ttlBtn && shareModalState) {
      await openShareModal(shareModalState.dropId, Number(ttlBtn.dataset.pdShareTtl));
      return;
    }

    if (e.target.closest('[data-pd-copy-share]') && shareModalState?.data?.share_url) {
      await copyText(shareModalState.data.share_url, e.target.closest('[data-pd-copy-share]'));
      return;
    }

    const revBtn = e.target.closest('[data-pd-revoke-share]');
    if (revBtn) {
      try {
        await api.post(`${API}/drops/${encodeURIComponent(revBtn.dataset.pdRevokeShare)}/revoke-share`, {});
        toast('Share links revoked');
        $('[data-pd-share-dlg]', root)?.close();
      } catch (err) { toast(err.message); }
      return;
    }

    if (e.target.closest('[data-pd-close-dlg]')) {
      e.target.closest('dialog')?.close();
      return;
    }

    if (e.target.closest('[data-pd-toggle-cli]')) {
      cliHelpOpen = !cliHelpOpen;
      renderDropStorage();
      return;
    }

    if (e.target.closest('[data-pd-copy-cli]')) {
      await copyText('ln -sf ~/Projects/Citadel/tools/padd_cli.py ~/.local/bin/padd', e.target.closest('[data-pd-copy-cli]'));
      return;
    }

    if (e.target.closest('[data-pd-clear-unpinned]')) {
      if (Date.now() < clearArmedUntil) {
        clearArmedUntil = 0;
        clearTimeout(clearArmTimer);
        try {
          const res = await api.post(`${API}/drops/clear`, { include_pinned: false });
          toast(`Cleared ${res.removed || 0} unpinned drop${res.removed === 1 ? '' : 's'}`);
          await loadDrops({ quiet: true });
        } catch (err) { toast(err.message); }
      } else {
        clearArmedUntil = Date.now() + 4500;
        clearTimeout(clearArmTimer);
        clearArmTimer = setTimeout(() => { clearArmedUntil = 0; renderDropStorage(); }, 4600);
        renderDropStorage();
      }
      return;
    }

    // ---- Notes actions ----
    const newNoteBtn = e.target.closest('[data-pd-new-note]');
    if (newNoteBtn) {
      if (noteDirty) await flushNoteSave();
      const kind = newNoteBtn.dataset.pdNewNote;
      try {
        const res = await api.post(`${API}/notes`, {
          title: kind === 'checklist' ? 'New checklist' : 'Untitled note',
          body: '',
          kind,
          tags: noteTag ? [noteTag] : [],
        });
        if (res.note) {
          noteArchived = false;
          selectedNoteId = res.note.id;
          mobileNoteOpen = true;
          noteChecklistRaw = false;
          noteViewMode = 'edit';
          await loadNotes({ quiet: true });
          renderNotePane();
          const target = kind === 'checklist' ? $('[data-pd-cl-new]', root) : $('[data-pd-note-title]', root);
          target?.focus();
          if (target && kind !== 'checklist') target.select();
        }
      } catch (err) { toast(err.message); }
      return;
    }

    const openNoteBtn = e.target.closest('[data-pd-open-note]');
    if (openNoteBtn) {
      if (noteDirty) await flushNoteSave();
      selectedNoteId = openNoteBtn.dataset.pdOpenNote;
      mobileNoteOpen = true;
      noteChecklistRaw = false;
      noteDeleteArmedId = null;
      renderNotesList();
      renderNotePane();
      return;
    }

    if (e.target.closest('[data-pd-note-back]')) {
      if (noteDirty) await flushNoteSave();
      mobileNoteOpen = false;
      renderNotesList();
      return;
    }

    const filterTagBtn = e.target.closest('[data-pd-filter-tag]');
    if (filterTagBtn) {
      noteTag = filterTagBtn.dataset.pdFilterTag;
      renderNotesList();
      return;
    }

    if (e.target.closest('[data-pd-toggle-archived]')) {
      if (noteDirty) await flushNoteSave();
      noteArchived = !noteArchived;
      noteTag = '';
      selectedNoteId = null;
      mobileNoteOpen = false;
      updateBarMeta();
      await loadNotes();
      return;
    }

    const noteModeBtn = e.target.closest('[data-pd-note-mode]');
    if (noteModeBtn) {
      if (noteDirty) await flushNoteSave();
      noteViewMode = noteModeBtn.dataset.pdNoteMode;
      renderNotePane();
      return;
    }

    if (e.target.closest('[data-pd-cl-raw]')) {
      if (noteDirty) await flushNoteSave();
      noteChecklistRaw = !noteChecklistRaw;
      renderNotePane();
      return;
    }

    const toggleCheckBtn = e.target.closest('[data-pd-toggle-check]');
    if (toggleCheckBtn && selectedNoteId) {
      if (noteDirty) await flushNoteSave();
      const idx = Number(toggleCheckBtn.dataset.pdToggleCheck);
      try {
        const res = await api.post(`${API}/notes/${encodeURIComponent(selectedNoteId)}/toggle-check`, { line_index: idx });
        if (res.note) {
          notes = notes.map(x => x.id === res.note.id ? res.note : x);
          renderNotesList();
          renderNotePane();
        }
      } catch (err) { toast(err.message); }
      return;
    }

    const clActBtn = e.target.closest('[data-pd-cl-act]');
    if (clActBtn && selectedNoteId) {
      try {
        const res = await api.post(`${API}/notes/${encodeURIComponent(selectedNoteId)}/checklist-action`, { action: clActBtn.dataset.pdClAct });
        if (res.note) {
          notes = notes.map(x => x.id === res.note.id ? res.note : x);
          renderNotesList();
          renderNotePane();
        }
      } catch (err) { toast(err.message); }
      return;
    }

    const clDelBtn = e.target.closest('[data-pd-cl-del-line]');
    if (clDelBtn && selectedNoteId) {
      const n = notes.find(x => x.id === selectedNoteId);
      if (!n) return;
      const idx = Number(clDelBtn.dataset.pdClDelLine);
      const lines = (n.body || '').split('\n');
      lines.splice(idx, 1);
      try {
        const res = await api.patch(`${API}/notes/${encodeURIComponent(n.id)}`, { body: lines.join('\n') });
        if (res.note) {
          notes = notes.map(x => x.id === res.note.id ? res.note : x);
          renderNotesList();
          renderNotePane();
        }
      } catch (err) { toast(err.message); }
      return;
    }

    const rmTagBtn = e.target.closest('[data-pd-rm-tag]');
    if (rmTagBtn && selectedNoteId) {
      const n = notes.find(x => x.id === selectedNoteId);
      if (!n) return;
      const nextTags = (n.tags || []).filter(t => t !== rmTagBtn.dataset.pdRmTag);
      try {
        const res = await api.patch(`${API}/notes/${encodeURIComponent(n.id)}`, { tags: nextTags });
        if (res.note) { notes = notes.map(x => x.id === res.note.id ? res.note : x); await loadNotes({ quiet: true }); renderNotePane(); }
      } catch (err) { toast(err.message); }
      return;
    }

    if (e.target.closest('[data-pd-note-pin]') && selectedNoteId) {
      const n = notes.find(x => x.id === selectedNoteId);
      if (!n) return;
      try {
        await api.patch(`${API}/notes/${encodeURIComponent(n.id)}`, { pinned: !n.pinned });
        await loadNotes({ quiet: true });
        renderNotePane();
      } catch (err) { toast(err.message); }
      return;
    }

    if (e.target.closest('[data-pd-note-copy]') && selectedNoteId) {
      const n = notes.find(x => x.id === selectedNoteId);
      if (n) await copyText(`${n.title}\n\n${n.body}`.trim(), e.target.closest('[data-pd-note-copy]'));
      return;
    }

    if (e.target.closest('[data-pd-note-todrop]') && selectedNoteId) {
      if (noteDirty) await flushNoteSave();
      const n = notes.find(x => x.id === selectedNoteId);
      if (!n) return;
      try {
        await api.post(`${API}/drops`, { title: n.title, text: n.body || n.title, kind: 'text', fetch_preview: false });
        toast('Sent to Dropzone');
        await loadDrops({ quiet: true });
      } catch (err) { toast(err.message); }
      return;
    }

    if (e.target.closest('[data-pd-note-archive]') && selectedNoteId) {
      if (noteDirty) await flushNoteSave();
      const n = notes.find(x => x.id === selectedNoteId);
      if (!n) return;
      try {
        await api.patch(`${API}/notes/${encodeURIComponent(n.id)}`, { archived: !n.archived });
        toast(n.archived ? 'Restored note' : 'Note archived');
        selectedNoteId = null;
        mobileNoteOpen = false;
        await loadNotes({ quiet: true });
        renderNotePane();
      } catch (err) { toast(err.message); }
      return;
    }

    if (e.target.closest('[data-pd-note-del]') && selectedNoteId) {
      if (noteDeleteArmedId === selectedNoteId) {
        clearTimeout(noteDeleteTimer);
        const delId = selectedNoteId;
        noteDeleteArmedId = null;
        try {
          await api.del(`${API}/notes/${encodeURIComponent(delId)}`);
          selectedNoteId = null;
          mobileNoteOpen = false;
          noteDirty = false;
          await loadNotes({ quiet: true });
          renderNotePane();
          toast('Note deleted');
        } catch (err) { toast(err.message); }
      } else {
        noteDeleteArmedId = selectedNoteId;
        clearTimeout(noteDeleteTimer);
        noteDeleteTimer = setTimeout(() => { noteDeleteArmedId = null; renderNotePane(); }, 4500);
        renderNotePane();
      }
      return;
    }

    const copyCodeBtn = e.target.closest('[data-pd-copy-code]');
    if (copyCodeBtn) {
      const pre = $(`[data-pd-code-block="${copyCodeBtn.dataset.pdCopyCode}"]`, root);
      if (pre) await copyText(pre.textContent || '', copyCodeBtn);
      return;
    }

    // ---- Shopping / HA Todo actions ----
    if (e.target.closest('[data-pd-shop-refresh]')) { await loadLists(); return; }

    const listBtn = e.target.closest('[data-pd-shop-list]');
    if (listBtn) {
      selectedListId = listBtn.dataset.pdShopList;
      saveSelectedList(selectedListId);
      editingTodoKey = null;
      renderShop();
      return;
    }

    if (e.target.closest('[data-pd-shop-toggle-done]')) {
      completedOpen = !completedOpen;
      renderShop();
      return;
    }

    const todoTog = e.target.closest('[data-pd-todo-toggle]');
    if (todoTog && selectedListId) {
      const itemKey = todoTog.dataset.pdTodoToggle;
      const nextStatus = todoTog.dataset.pdTodoStatus;
      // Optimistic local flip for snappy supermarket tapping
      const curList = (haState?.lists || []).find(l => l.entity_id === selectedListId);
      const localItem = curList?.items.find(i => (i.uid || i.summary) === itemKey);
      if (localItem) {
        localItem.status = nextStatus;
        curList.open_count = curList.items.filter(i => i.status !== 'completed').length;
        updateTabCounts();
        renderShop();
      }
      try {
        haState = await api.patch(`${API}/lists/${encodeURIComponent(selectedListId)}/items`, { item: itemKey, status: nextStatus });
        updateTabCounts();
        renderShop();
      } catch (err) {
        toast(err.message);
        await loadLists({ quiet: true });
      }
      return;
    }

    const todoEdit = e.target.closest('[data-pd-todo-edit]');
    if (todoEdit) {
      editingTodoKey = todoEdit.dataset.pdTodoEdit;
      renderShop();
      const inp = $('[data-pd-todo-rename-in]', root);
      inp?.focus();
      inp?.select();
      return;
    }

    if (e.target.closest('[data-pd-todo-rename-cancel]')) {
      editingTodoKey = null;
      renderShop();
      return;
    }

    const todoDel = e.target.closest('[data-pd-todo-del]');
    if (todoDel && selectedListId) {
      try {
        haState = await api.post(`${API}/lists/${encodeURIComponent(selectedListId)}/items/remove`, { item: todoDel.dataset.pdTodoDel });
        updateTabCounts();
        renderShop();
      } catch (err) { toast(err.message); }
      return;
    }

    if (e.target.closest('[data-pd-todo-clear]') && selectedListId) {
      try {
        haState = await api.post(`${API}/lists/${encodeURIComponent(selectedListId)}/clear-completed`, {});
        completedOpen = false;
        updateTabCounts();
        renderShop();
        toast('Cleared completed items');
      } catch (err) { toast(err.message); }
      return;
    }
  });

  // Form submissions
  root.addEventListener('submit', async e => {
    if (e.target.matches('[data-pd-drop-form]')) {
      e.preventDefault();
      await submitTextDrop();
      return;
    }
    if (e.target.matches('[data-pd-cl-add-form]') && selectedNoteId) {
      e.preventDefault();
      const inp = $('[data-pd-cl-new]', e.target);
      const val = (inp?.value || '').trim();
      if (!val) return;
      const n = notes.find(x => x.id === selectedNoteId);
      if (!n) return;
      const nextBody = n.body ? `${n.body.replace(/\s+$/, '')}\n- [ ] ${val}` : `- [ ] ${val}`;
      try {
        const res = await api.patch(`${API}/notes/${encodeURIComponent(n.id)}`, { body: nextBody });
        if (res.note) {
          notes = notes.map(x => x.id === res.note.id ? res.note : x);
          renderNotesList();
          renderNotePane();
          $('[data-pd-cl-new]', root)?.focus();
        }
      } catch (err) { toast(err.message); }
      return;
    }
    if (e.target.matches('[data-pd-todo-add-form]') && selectedListId) {
      e.preventDefault();
      const inp = $('[data-pd-todo-add-in]', e.target);
      const summary = (inp?.value || '').trim();
      if (!summary) return;
      inp.disabled = true;
      try {
        haState = await api.post(`${API}/lists/${encodeURIComponent(selectedListId)}/items`, { summary });
        updateTabCounts();
        renderShop();
        $('[data-pd-todo-add-in]', root)?.focus();
      } catch (err) {
        inp.disabled = false;
        toast(err.message);
      }
      return;
    }
    if (e.target.matches('[data-pd-todo-rename-form]') && selectedListId) {
      e.preventDefault();
      const key = e.target.dataset.pdTodoKey;
      const val = ($('[data-pd-todo-rename-in]', e.target)?.value || '').trim();
      if (!val) return;
      try {
        haState = await api.patch(`${API}/lists/${encodeURIComponent(selectedListId)}/items`, { item: key, rename: val });
        editingTodoKey = null;
        renderShop();
      } catch (err) { toast(err.message); }
      return;
    }
  });

  // Inputs & live search / auto-save
  root.addEventListener('input', e => {
    if (e.target.matches('[data-pd-input]')) { autoGrow(e.target); return; }
    if (e.target.matches('[data-pd-drop-search]')) { dropQuery = e.target.value; renderDropFeed(); return; }
    if (e.target.matches('[data-pd-note-search]')) { noteQuery = e.target.value; renderNotesList(); return; }
    if (e.target.matches('[data-pd-note-title], [data-pd-note-body]')) {
      scheduleNoteSave();
      if (e.target.matches('[data-pd-note-body]') && noteViewMode === 'split') {
        const pv = $('[data-pd-md-preview]', root);
        if (pv) pv.innerHTML = renderMarkdown(e.target.value, selectedNoteId);
      }
    }
  });

  // File input change
  root.addEventListener('change', e => {
    if (e.target.matches('[data-pd-file-any], [data-pd-file-img]')) {
      const files = [...(e.target.files || [])];
      e.target.value = '';
      if (files.length) uploadFiles(files);
    }
  });

  // Keyboard shortcuts inside PADD
  root.addEventListener('keydown', async e => {
    if (e.target.matches('[data-pd-input]') && (e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      await submitTextDrop();
      return;
    }
    if (e.target.matches('[data-pd-add-tag]') && (e.key === 'Enter' || e.key === ',')) {
      e.preventDefault();
      const raw = e.target.value.trim().replace(/,+$/, '');
      if (!raw || !selectedNoteId) return;
      const n = notes.find(x => x.id === selectedNoteId);
      if (!n) return;
      const nextTags = [...(n.tags || []), raw];
      e.target.value = '';
      try {
        const res = await api.patch(`${API}/notes/${encodeURIComponent(n.id)}`, { tags: nextTags });
        if (res.note) {
          notes = notes.map(x => x.id === res.note.id ? res.note : x);
          await loadNotes({ quiet: true });
          renderNotePane();
          $('[data-pd-add-tag]', root)?.focus();
        }
      } catch (err) { toast(err.message); }
    }
  });

  // Close dialogs on backdrop click
  root.addEventListener('click', e => {
    if (e.target.matches('dialog.pd-dlg')) e.target.close();
  });

  // Global desktop Ctrl+V paste (captures pasted screenshots/files or quick text when on Dropzone)
  document.addEventListener('paste', async e => {
    if (!active || tab !== 'drop') return;
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      await uploadFiles(files);
      return;
    }
    // If not already focused inside an input/textarea, pasting text drops it straight into the composer (or immediately if URL)
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const txt = e.clipboardData?.getData('text/plain') || '';
    if (!txt.trim()) return;
    e.preventDefault();
    const box = $('[data-pd-input]', root);
    if (box) { box.value = txt; autoGrow(box); box.focus(); }
  });

  // Drag & drop files anywhere on the Dropzone view
  const setOverlay = on => { const ov = $('[data-pd-drag-overlay]', root); if (ov) ov.hidden = !on; };
  window.addEventListener('dragenter', e => {
    if (!active || tab !== 'drop') return;
    if (!e.dataTransfer?.types?.includes('Files')) return;
    dragDepth++;
    setOverlay(true);
  });
  window.addEventListener('dragover', e => {
    if (!active || tab !== 'drop') return;
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    if (!active || tab !== 'drop') return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setOverlay(false);
  });
  window.addEventListener('drop', async e => {
    if (!active || tab !== 'drop') return;
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    dragDepth = 0;
    setOverlay(false);
    await uploadFiles(e.dataTransfer.files);
  });
}

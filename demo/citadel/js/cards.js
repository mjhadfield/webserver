// Card definitions. Each card has: id, grid area, label, and render(state, ctx) -> { meta, body }.
// Markup and class names follow the approved mockup (web/mock/), so the CSS is shared.
//
// Anything marked class="more" (with `hidden`) is expanded-view-only; the shell reveals it when the card opens.
import { esc, ico, safeUrl, hostUrl, fmtDay, relDays, hhmm, bytes, duration, uptimeText, isoOf, parseDate } from './util.js';
import { contentCards } from './content-cards.js';

/** UI state that lives in the browser rather than the server (in-flight start/stop, selected log, open hourly weather day). */
export const ui = { pending: {}, selected: null, logText: '', wxDay: null };

const COLOURS = { violet: 'var(--accent-hi)', silver: 'var(--silver)', indigo: '#6d5bd0' };
const diaryColour = c => (/^#[0-9a-f]{3,8}$/i.test(c || '') ? c : (COLOURS[c] || COLOURS.violet));
const staleChip = w => (w.error ? ' <span class="chip chip--warn">stale</span>' : '');
const empty = (icon, title, text, chip = '') =>
  `<div class="empty">${ico(icon)}<div class="empty__title">${esc(title)}</div><p>${esc(text)}</p>${chip ? `<span class="chip">${esc(chip)}</span>` : ''}</div>`;
/** Owner-only pin toggle: shows on hover, and stays visible once pinned. */
export const pinButton = (kind, id, pinned) =>
  `<button class="pinbtn${pinned ? ' is-on' : ''}" data-pin="${kind}" data-id="${esc(id)}" data-to="${!pinned}" aria-label="${pinned ? 'Unpin' : 'Pin to top'}" title="${pinned ? 'Unpin' : 'Pin to top'}">${ico('pin')}</button>`;

// ---- Now: clock, 5-day weather forecast, and the next bin collections in one row -----------------------

const WX_DOW = new Intl.DateTimeFormat('en-GB', { weekday: 'short' });

function binRow(item, streams, hour) {
  if (!item) return '<li class="note">No upcoming collection found.</li>';
  const s = streams[item.stream] || { title: item.stream, sub: '', colour: '#6b7280' };
  const chip = item.in_days === 0 ? '<span class="chip chip--today">Today</span>'
    : item.in_days === 1 && hour >= 17 ? '<span class="chip chip--today">Tonight</span>' : '';
  const when = `${fmtDay(item.date)} · ${relDays(item.in_days)}`;
  return `<li class="bin" style="--sw:${esc(s.colour)}" title="${esc(s.title)}${s.sub ? ` (${s.sub})` : ''} — ${esc(when)}"><span class="bin__swatch"></span>
    <div class="bin__main"><div class="bin__name"><span>${esc(s.title)}</span>${chip}</div><div class="bin__when">${esc(when)}</div></div></li>`;
}

function weatherHourly(day, hours, today, nowHour) {
  const dayLabel = day.date === today ? `Today · ${fmtDay(day.date)}` : fmtDay(day.date);
  const summary = [
    day.label,
    day.max != null && day.min != null ? `${day.max}° / ${day.min}°` : '',
    day.wind != null ? `wind up to ${day.wind} mph` : '',
  ].filter(Boolean).join(' · ');
  const cells = hours.map(h => {
    const hr = Number((h.time || '').slice(0, 2));
    const isNow = day.date === today && hr === nowHour;
    const isPast = day.date === today && hr < nowHour;
    const rain = h.rain_pct != null && h.rain_pct >= 10 ? `${h.rain_pct}%` : '';
    const tip = `${h.time}: ${h.label}, ${h.temp != null ? `${h.temp}°C` : '—'}${h.rain_pct != null ? `, ${h.rain_pct}% rain` : ''}${h.wind != null ? `, wind ${h.wind} mph` : ''}`;
    return `<div class="wx__hr${isNow ? ' is-now' : ''}${isPast ? ' is-past' : ''}" title="${esc(tip)}">
      <span class="wx__ht">${esc(h.time)}</span>
      ${ico(h.icon)}
      <b class="wx__htemp">${h.temp != null ? `${esc(h.temp)}°` : '—'}</b>
      <span class="wx__hrain">${esc(rain)}</span>
    </div>`;
  }).join('');
  return `<div class="wx__hourly" role="region" aria-label="Hourly forecast for ${esc(dayLabel)}">
    <div class="wx__hhead">
      <div class="wx__htitle"><span>Hourly · ${esc(dayLabel)}</span>${summary ? `<small>${esc(summary)}</small>` : ''}</div>
      <button type="button" class="btn btn--icon wx__hclose" data-wx-close aria-label="Close hourly forecast" title="Close hourly forecast">${ico('x')}</button>
    </div>
    <div class="wx__hours">${cells}</div>
  </div>`;
}

function weatherBlock(w, today, nowHour, expanded) {
  if (!w) return '';
  if (!w.configured) {
    return `<div class="now__label now__label--wx hud"><span>Weather</span></div>
      <div class="note">Add a location in Settings → Widgets to see the forecast.</div>`;
  }
  const d = w.data;
  if (!d?.days?.length) {
    return `<div class="now__label now__label--wx hud"><span>Weather</span></div>
      <div class="note">${w.error ? `Couldn't read the forecast: ${esc(w.error)}` : 'Fetching forecast…'}</div>`;
  }
  const cur = d.current;
  const heading = d.place ? `Weather · ${d.place}` : 'Weather';
  const curTip = cur ? [cur.feels != null ? `Feels like ${cur.feels}°C` : '', cur.wind != null ? `Wind ${cur.wind} mph` : ''].filter(Boolean).join(' · ') : '';
  const curExtra = expanded && curTip ? `<span class="wx__extra"> · ${esc(curTip)}</span>` : '';
  const curHtml = cur
    ? `<span class="wx__now" title="${esc(curTip)}">${ico(cur.icon)}<b>${esc(cur.temp)}°</b><span>${esc(cur.label)}</span>${curExtra}</span>`
    : '';
  const list = expanded && d.extended?.length ? d.extended : d.days.slice(0, 5);
  const hourlyMap = d.hourly || {};
  const cells = list.map((day, i) => {
    const isToday = day.date === today || (i === 0 && !list.some(x => x.date === today));
    const dow = isToday ? 'Today' : WX_DOW.format(parseDate(day.date));
    const hi = day.max != null ? `${day.max}°` : '—';
    const lo = day.min != null ? `${day.min}°` : '—';
    const rain = day.rain_pct != null && day.rain_pct >= 10 ? `${day.rain_pct}%` : '';
    const hasHourly = Array.isArray(hourlyMap[day.date]) && hourlyMap[day.date].length > 0;
    const isSelected = expanded && hasHourly && ui.wxDay === day.date;
    const tip = `${fmtDay(day.date)}: ${day.label}, ${hi} / ${lo}${day.rain_pct != null ? `, ${day.rain_pct}% rain` : ''}${day.wind != null ? `, wind ${day.wind} mph` : ''}${hasHourly ? ' — click for hourly forecast' : ''}`;
    const inner = `<span class="wx__dow">${esc(dow)}</span>
      ${ico(day.icon)}
      <span class="wx__temps"><b class="wx__hi">${esc(hi)}</b><span class="wx__lo">${esc(lo)}</span></span>
      ${expanded ? `<span class="wx__cond">${esc(day.label)}</span><span class="wx__rain">${day.rain_pct != null ? `${esc(day.rain_pct)}% rain` : ''}${day.wind != null ? `${day.rain_pct != null ? ' · ' : ''}${esc(day.wind)} mph` : ''}</span>`
        : `<span class="wx__rain">${esc(rain)}</span>`}`;
    const cls = `wx__day${hasHourly ? ' wx__day--btn' : ''}${isToday ? ' is-today' : ''}${isSelected ? ' is-selected' : ''}`;
    if (hasHourly) {
      return `<button type="button" class="${cls}" data-wx-day="${esc(day.date)}" aria-pressed="${isSelected}" title="${esc(tip)}">${inner}</button>`;
    }
    return `<div class="${cls}" title="${esc(tip)}">${inner}</div>`;
  }).join('');
  const selDay = expanded && ui.wxDay ? list.find(x => x.date === ui.wxDay) : null;
  const selHours = selDay ? hourlyMap[selDay.date] : null;
  const hourlyHtml = selDay && selHours?.length ? weatherHourly(selDay, selHours, today, nowHour) : '';
  return `<div class="now__label now__label--wx hud"><span>${esc(heading)}</span>${curHtml}</div>
    <div class="wx__days${expanded ? ' wx__days--full' : ''}">${cells}</div>${hourlyHtml}`;
}

// Full screen lists each collection day once (the two "next" rows above are hidden there), so the first domestic, blue
// and brown collection is picked out in its bin's colour; a day that's the first of two splits its colour between them.
// Food & garden goes every week, so it's never singled out.
const HIGHLIGHT = ['domestic', 'blue', 'brown'];
const firstCollections = upcoming => Object.fromEntries(HIGHLIGHT.map(k => [k, upcoming.find(u => u.streams.includes(k))?.date]));

function schedRow(u, d, firsts, hour) {
  const colour = k => d.streams[k]?.colour || '#6b7280';
  const hl = u.streams.filter(k => firsts[k] === u.date).map(colour);
  const split = dir => hl.length === 1 ? hl[0] : `linear-gradient(${dir}, ${hl.map((c, i) => `${c} ${i / hl.length * 100}% ${(i + 1) / hl.length * 100}%`).join(', ')})`;
  const style = hl.length ? ` style="--hc:${esc(hl[0])};--hl:${esc(split('90deg'))};--hlv:${esc(split('180deg'))}"` : '';
  const when = !hl.length ? '' : u.in_days === 0 ? '<span class="chip chip--today">Today</span>'
    : u.in_days === 1 && hour >= 17 ? '<span class="chip chip--today">Tonight</span>' : `<span class="sched__in">${esc(relDays(u.in_days))}</span>`;
  return `<li class="sched more${hl.length ? ' sched--next' : ''}"${style} hidden><span class="sched__d">${esc(fmtDay(u.date))}</span><span class="sched__b">${
    u.streams.map(k => `<span style="--sw:${esc(colour(k))}"><i></i>${esc(d.streams[k]?.title || k)}</span>`).join('')}</span>${when}</li>`;
}

// One month as a Monday-first grid. day(iso, col) gives a day's extra classes/attributes and what goes under its number.
function monthGrid(first, todayIso, day) {
  const y = first.getFullYear(), m0 = first.getMonth();
  const lead = (first.getDay() + 6) % 7, days = new Date(y, m0 + 1, 0).getDate();
  let cells = [...'MTWTFSS'].map(d => `<span class="cal__dow">${d}</span>`).join('') + '<span class="cd cd--out"></span>'.repeat(lead);
  for (let d = 1; d <= days; d++) {
    const iso = isoOf(y, m0, d), x = day(iso, (lead + d - 1) % 7);
    cells += `<span class="cd${iso === todayIso ? ' cd--today' : ''}${iso < todayIso ? ' cd--past' : ''}${x.cls || ''}"${x.attrs || ''}><b>${d}</b>${x.html || ''}</span>`;
  }
  return `<div class="cal"><div class="cal__h">${esc(first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }))}</div><div class="cal__g">${cells}</div></div>`;
}

function collectionCalendars(data, todayIso) {
  const marks = Object.fromEntries(data.upcoming.map(u => [u.date, u.streams]));
  const t = parseDate(todayIso);
  const bars = iso => ({ html: (marks[iso] || []).map(k => `<i style="--sw:${esc(data.streams[k]?.colour || '#6b7280')}"></i>`).join('') });
  const months = [0, 1, 2].map(i => monthGrid(new Date(t.getFullYear(), t.getMonth() + i, 1), todayIso, bars)).join('');
  const legend = Object.values(data.streams)
    .map(s => `<span style="--sw:${esc(s.colour)}"><i></i>${esc(s.title)} <span class="dim">— ${esc(s.sub)}</span></span>`).join('');
  return `<div class="calm more" hidden>${months}<div class="cal__legend">${legend}</div></div>`;
}

function now(s, ctx) {
  const w = s.widgets.bins;
  const wx = s.widgets.weather;
  const hour = new Date(s.now).getHours();
  const today = s.now.slice(0, 10);
  const expanded = !!ctx?.expanded;
  let list, extra = '';
  if (!w.configured) {
    list = '<li class="note">Add your council property reference in settings to see bin days.</li>';
  } else if (!w.data?.next) {                                               // nothing synced yet (the widget's view is {} until the first fetch)
    list = `<li class="note">${w.error ? `Couldn't read the council page: ${esc(w.error)}` : 'Fetching bin days…'}</li>`;
  } else {
    const d = w.data;
    const firsts = firstCollections(d.upcoming);
    list = binRow(d.next.recycling, d.streams, hour) + binRow(d.next.domestic, d.streams, hour)
      + d.upcoming.slice(0, 14).map(u => schedRow(u, d, firsts, hour)).join('');
    extra = collectionCalendars(d, today);
  }
  const metaParts = [];
  if (wx?.fetched_at) metaParts.push(`weather ${esc(hhmm(wx.fetched_at))}${staleChip(wx)}`);
  if (w.fetched_at) metaParts.push(`bins ${esc(hhmm(w.fetched_at))}${staleChip(w)}`);
  return {
    meta: metaParts.join(' · ') || 'bins',
    body: `<div class="now__clock"><div class="clock__time" data-clock></div>
      <div class="clock__date"><span data-dow></span><span data-dmy></span></div></div>
      ${weatherBlock(wx, today, hour, expanded)}
      <div class="now__label hud">Next collections</div><ul class="rows rows--bins">${list}</ul>${extra}`,
  };
}

// ---- Diary ------------------------------------------------------------------------------------------------

function addDays(iso, n) { const d = parseDate(iso); d.setDate(d.getDate() + n); return isoOf(d.getFullYear(), d.getMonth(), d.getDate()); }

function diary(s, ctx) {
  const w = s.widgets.diary;
  if (!w.configured) return { meta: 'not set up', body: empty('cal', 'Connect a calendar', 'Connect Google Calendar or add an iCal address in settings.') };
  if (w.data?.google_expired && !w.data?.events?.length) {
    return { meta: 'sign-in expired', body: empty('cal', 'Google Calendar sign-in expired', 'Reconnect Google Calendar in Settings → Widgets.') };
  }
  if (!w.data?.events) return { meta: w.error ? 'error' : 'loading', body: empty('cal', w.error ? "Couldn't read the calendar" : 'Loading…', w.error || '') };

  const today = s.now.slice(0, 10), tomorrow = addDays(today, 1);
  if (ctx.expanded) return calendarFull(s, ctx, w, today, tomorrow);
  const range = 14;
  const cutoff = addDays(today, range);
  const groups = new Map();
  for (const e of w.data.events) {
    if (e.date > cutoff) continue;
    if (!groups.has(e.date)) groups.set(e.date, []);
    groups.get(e.date).push(e);
  }
  let shown = 0, idx = 0;
  const html = [...groups].map(([date, evs]) => {
    const compact = idx < 4 && shown + evs.length <= 6;         // what fits in the small card; the rest is expanded-only
    idx++; shown += evs.length;
    const label = date === today ? `Today<span> · ${esc(fmtDay(date))}</span>` : date === tomorrow ? `Tomorrow<span> · ${esc(fmtDay(date))}</span>` : esc(fmtDay(date));
    const rows = evs.map(e => {
      const sub = [e.until ? `until ${fmtDay(e.until)}` : '', e.location].filter(Boolean).join(' · ');
      const titleHtml = e.href ? `<a href="${esc(safeUrl(e.href))}" target="_blank" rel="noopener">${esc(e.title)}</a>` : esc(e.title);
      return `<li class="ev" style="--cal:${esc(diaryColour(e.colour))}"><span class="ev__t">${e.all_day ? 'All day' : esc(e.time)}</span><span class="ev__bar"></span>
        <div class="ev__main"><div class="ev__title">${titleHtml}</div>${sub ? `<div class="ev__sub">${esc(sub)}</div>` : ''}</div></li>`;
    }).join('');
    return `<div class="dg${compact ? '' : ' more'}"${compact ? '' : ' hidden'}><div class="day${date <= tomorrow ? ' day--next' : ''}">${label}</div><ul class="rows">${rows}</ul></div>`;
  }).join('');
  const expChip = w.data.google_expired ? ' <span class="chip chip--warn">reconnect</span>' : '';
  return {
    meta: `${esc(w.data.calendars[0]?.name || 'calendar')} · ${esc(hhmm(w.fetched_at))}${staleChip(w)}${expChip}`,
    body: html ? `<div class="cols">${html}</div>` : empty('cal', 'Nothing planned', `No events in the next ${range} days.`),
  };
}

// Full screen: this month and the next two as calendars (a day's events show on hover or focus), then every day with
// something on in the chosen range, in date order, reading across then down.
function calendarFull(s, ctx, w, today, tomorrow) {
  const range = Number(ctx.filter || 14), cutoff = addDays(today, range);
  const t = parseDate(today), calEnd = isoOf(t.getFullYear(), t.getMonth() + 3, 0);
  const byDay = new Map();
  for (const e of w.data.events) {                                  // an event over several days marks each of them
    for (let d = e.date, n = 0; d <= (e.until || e.date) && d <= calEnd && n < 93; d = addDays(d, 1), n++) {
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(e);
    }
  }
  const colour = e => diaryColour(e.colour);
  const when = e => (e.all_day ? 'All day' : esc(e.time));
  const label = d => (d === today ? 'Today' : d === tomorrow ? 'Tomorrow' : esc(fmtDay(d)));
  const day = (iso, col) => {
    const evs = byDay.get(iso);
    if (!evs) return {};
    const pop = `<span class="cd__pop" role="tooltip"><span class="cd__ph">${label(iso)}</span>${evs.map(e => `<span class="cd__pe" style="--cal:${esc(colour(e))}">
      <span class="cd__pt">${when(e)}</span><span class="cd__pm"><span class="cd__pn">${esc(e.title)}</span>${e.location ? `<span class="cd__pl">${esc(e.location)}</span>` : ''}</span></span>`).join('')}</span>`;
    return { cls: ` cd--ev${col >= 4 ? ' cd--r' : ''}`, attrs: ` tabindex="0" aria-label="${esc(fmtDay(iso))}: ${evs.length} event${evs.length === 1 ? '' : 's'}"`,
      html: `${evs.slice(0, 3).map(e => `<i style="--sw:${esc(colour(e))}"></i>`).join('')}${pop}` };
  };
  const months = [0, 1, 2].map(i => monthGrid(new Date(t.getFullYear(), t.getMonth() + i, 1), today, day)).join('');
  const cals = w.data.calendars || [];
  const legend = cals.length > 1 ? `<div class="cal__legend">${cals.map(c => `<span style="--sw:${esc(diaryColour(c.colour))}"><i></i>${esc(c.name)}</span>`).join('')}</div>` : '';
  const days = [...byDay].filter(([d]) => d <= cutoff).sort(([a], [b]) => (a < b ? -1 : 1));
  const rows = days.map(([d, evs]) => `<li class="crow${d === today ? ' crow--today' : ''}"><span class="crow__d">${label(d)}</span><div class="crow__evs">${evs.map(e => {
    const sub = [e.until && e.until !== d ? `until ${fmtDay(e.until)}` : '', e.location].filter(Boolean).join(' · ');
    const titleHtml = e.href ? `<a href="${esc(safeUrl(e.href))}" target="_blank" rel="noopener">${esc(e.title)}</a>` : esc(e.title);
    return `<div class="crow__e" style="--cal:${esc(colour(e))}"><span class="crow__t">${when(e)}</span><div class="crow__m"><div class="crow__n">${titleHtml}</div>${sub ? `<div class="crow__s">${esc(sub)}</div>` : ''}</div></div>`;
  }).join('')}</div></li>`).join('');
  const expChip = w.data.google_expired ? ' <span class="chip chip--warn">reconnect</span>' : '';
  return {
    meta: `${esc(cals[0]?.name || 'calendar')} · ${esc(hhmm(w.fetched_at))}${staleChip(w)}${expChip}`,
    // phones put the days coming up first and the calendars under them (dashboard.css .calx)
    body: `<div class="calx"><div class="calm calm--diary">${months}${legend}</div><div class="now__label hud">Coming up</div>
      ${rows ? `<ul class="crows">${rows}</ul>` : `<p class="note crows__none">Nothing planned in the next ${range} days.</p>`}</div>`,
  };
}

// ---- Projects ---------------------------------------------------------------------------------------------

export function selectedSlug(state) {
  const list = state.projects.filter(p => p.show_projects);   // only ever a project with a visible row to select
  if (ui.selected && list.some(p => p.slug === ui.selected)) return ui.selected;
  return (list.find(p => p.managed) || list[0])?.slug || null;
}

const ms = n => (n < 1 ? '<1 ms' : `${n} ms`);
const STATE_TEXT = { running: 'running', starting: 'starting…', unhealthy: 'not responding', external: 'running (external)', stopped: 'stopped' };

function projects(s, ctx) {
  const up = p => p.state === 'running' || p.state === 'external';
  const now = new Date(s.now).getTime() / 1000;
  // A project can opt out of the Services card (Settings → "Show in Services") once it's launched from the
  // Launchpad instead — a standalone app with nothing to stop doesn't need a row here at all.
  let list = s.projects.filter(p => p.show_projects);
  if (ctx.expanded && ctx.filter === 'running') list = list.filter(p => up(p) || p.state === 'starting');
  if (ctx.expanded && ctx.filter === 'stopped') list = list.filter(p => p.state === 'stopped');
  const sel = selectedSlug(s);
  const rows = list.map(p => {
    const busy = ui.pending[p.slug];
    const dot = { running: 'dot--ok', external: 'dot--ok', starting: 'dot--warn', unhealthy: 'dot--bad' }[p.state] || '';
    const name = p.url && up(p)
      ? `<a class="proj__name" href="${esc(hostUrl(p.url))}" target="_blank" rel="noopener">${esc(p.name)} ${ico('ext', 'xi')}</a>`
      : `<span class="proj__name">${esc(p.name)}</span>`;
    // Once running, a live-ticking uptime (from systemd's own record of when the unit started) replaces the
    // health check's latency reading — more useful at a glance, and it keeps counting through page refreshes.
    const uptime = p.state === 'running' && p.since != null
      ? `<span data-since="${Number(p.since)}">${esc(uptimeText(now - p.since))}</span>` : esc(STATE_TEXT[p.state]);
    const detail = p.kind === 'web' ? `:${esc(String(p.port))} · ${uptime}` : `desktop app · ${uptime}`;
    const act = busy ? `<button class="btn" disabled>${busy === 'start' ? 'Starting…' : 'Stopping…'}</button>`
      : p.managed ? `<button class="btn btn--stop" data-act="stop" data-slug="${esc(p.slug)}">${ico('stop')}Stop</button>`
      : p.state === 'external' ? '<span class="chip">External</span>'
      : `<button class="btn btn--go" data-act="start" data-slug="${esc(p.slug)}">${ico('play')}Start</button>`;
    return `<li class="proj${ctx.expanded && p.slug === sel ? ' is-selected' : ''}" data-select data-slug="${esc(p.slug)}"><span class="dot ${dot}"></span>
      <div>${name}<div class="proj__desc">${detail}${p.lan_visible ? '' : ' · <span class="chip chip--warn">this pc only</span>'}</div></div>
      <div class="proj__act">${pinButton('project', p.slug, p.pinned)}${act}</div></li>`;
  }).join('');
  const visible = s.projects.filter(p => p.show_projects);
  const selected = visible.find(p => p.slug === sel);
  const log = selected
    ? `<div class="logwrap more" hidden><div class="hud">Log · ${esc(selected.name)} · live</div><pre class="log" data-log>${esc(ui.logText || 'No output yet — start the project to see its log.')}</pre></div>` : '';
  return {
    meta: `${visible.filter(up).length} / ${visible.length} running`,
    body: `<ul class="rows">${rows || '<li class="note">No projects match.</li>'}</ul>${log}`,
  };
}

// ---- Launchpad --------------------------------------------------------------------------------------------

// A project can opt in (Settings → Projects → "Show in Launchpad") to also appear here — the primary place for
// launching things. A web project's tile is a plain clickthrough link, same as any other (it still start/stops from
// the Services card); a desktop project has no page to link to, so its tile *is* the start button.
function projectTile(p) {
  const running = p.state === 'running' || p.state === 'external';
  if (p.kind === 'web') {
    const dot = running ? '<span class="dot dot--ok"></span>' : p.managed ? '<span class="dot dot--warn"></span>' : '<span class="dot dot--bad"></span>';
    return `<a class="tile${p.pinned ? ' tile--pinned' : ''}" href="${esc(hostUrl(p.url))}" target="_blank" rel="noopener">
      ${ico(p.icon)}<div><b>${esc(p.name)}</b><small>${p.port ? `:${p.port}` : esc(STATE_TEXT[p.state])}</small></div>${dot}</a>`;
  }
  const busy = ui.pending[p.slug];
  const dot = running ? '<span class="dot dot--ok"></span>' : '';
  return `<button class="tile${p.pinned ? ' tile--pinned' : ''}" type="button" data-act="start" data-slug="${esc(p.slug)}" ${busy ? 'disabled' : ''}>
    ${ico(p.icon)}<div><b>${esc(p.name)}</b><small>${busy ? 'Launching…' : (running ? 'running' : 'desktop app')}</small></div>${dot}</button>`;
}

function launchpad(s, ctx) {
  const q = ctx.expanded ? ctx.search : '';
  const items = [
    ...s.links.map(l => ({ key: `link:${l.id}`, pinned: l.pinned, pin_order: l.pin_order, main: l.tier === 'main', search: `${l.name} ${l.subtitle}`,
      html: `<a class="tile${l.primary ? ' tile--primary' : ''}${l.pinned ? ' tile--pinned' : ''}" href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener">
        ${ico(l.icon)}<div><b>${esc(l.name)}</b><small>${esc(l.subtitle)}</small></div>${l.up === true ? '<span class="dot dot--ok"></span>' : l.up === false ? '<span class="dot dot--bad"></span>' : ''}</a>`,
      pin: pinButton('link', l.id, l.pinned) })),
    ...s.projects.filter(p => p.show_launchpad).map(p => ({ key: `project:${p.slug}`, pinned: p.pinned, pin_order: p.pin_order, main: true, search: `${p.name} ${p.description || ''}`,
      html: projectTile(p), pin: pinButton('project', p.slug, p.pinned) })),
  ];
  const list = q ? items.filter(i => i.search.toLowerCase().includes(q)) : items;
  // Pinned/main-tier tiles render in the compact card too — 9 (3x3) show without scrolling, the rest reveal by
  // scrolling the card itself (like the other cards' compact view), no need to expand. Only "more"-tier, unpinned
  // links (the deliberately lower-priority ones) stay archive-only, same as before. pin_order is one sequence
  // shared by links and projects server-side, so sorting by it gives the real pin order across both — the item
  // pinned first shows first, regardless of which kind of thing it is or when its source array was sorted.
  const sorted = [...list].sort((a, b) => (a.pin_order ?? Infinity) - (b.pin_order ?? Infinity));
  const tiles = sorted.map(i => {
    const more = !(i.pinned || i.main);
    return `<div class="tilewrap${more ? ' more' : ''}"${more ? ' hidden' : ''}>${i.html}${i.pin}</div>`;
  }).join('');
  return { meta: '', body: tiles ? `<div class="tiles">${tiles}</div>` : empty('globe', 'No links', 'Nothing matches.') };
}

// ---- Remote Access ----------------------------------------------------------------------------------------

// Each device (Settings → Remote access) is one tile that opens a VNC viewer on this PC's own screen, whichever device
// was used to click it. The dot is whether it answers a ping; ✕ closes a viewer that's open.
function remote(s) {
  const list = s.remote || [];
  if (!list.length) return { meta: '', body: empty('desk', 'No devices', 'Add one in Settings → Remote access.') };
  const tiles = list.map(r => {
    const busy = ui.pending[`vnc:${r.id}`];
    const dot = r.up === true ? '<span class="dot dot--ok"></span>' : r.up === false ? '<span class="dot dot--bad"></span>' : '';
    // a device reached by name (probe-2.local) shows the LAN address that name last resolved to
    // asleep or off, with a MAC address: the tile wakes it (Wake-on-LAN) instead of opening a viewer that can't connect
    const wake = r.wake && r.up === false && !r.open;
    const sub = busy === 'open' ? 'Opening…' : busy === 'close' ? 'Closing…' : busy === 'wake' ? 'Waking…' : r.open ? 'Viewer open' : wake ? 'Asleep · wake' : r.lan_ip || r.address;
    const close = r.open ? `<button class="pinbtn is-on" data-vnc-close="${r.id}" aria-label="Close the viewer" title="Close the viewer">${ico('x')}</button>` : '';
    return `<div class="tilewrap"><button class="tile${r.open ? ' tile--primary' : ''}" type="button" ${wake || busy === 'wake' ? `data-wake="${r.id}" title="Wake ${esc(r.name)}"` : `data-vnc="${r.id}"`} ${busy ? 'disabled' : ''}>
      ${ico('desk')}<div><b>${esc(r.name)}</b><small>${esc(sub)}</small></div>${dot}</button>${close}</div>`;
  }).join('');
  return { meta: `${list.filter(r => r.up).length} / ${list.length} on`, body: `<div class="tiles">${tiles}</div>` };
}

// ---- Storage (card id kept as "system": the widget still feeds uptime to Monitoring) ---------------------

/** Every status check on the dashboard: web projects (their port) and links with a status address. */
export function serviceChecks(s) {
  return [
    ...s.projects.filter(p => p.kind === 'web').map(p => ({ name: p.name, ok: p.state === 'running' || p.state === 'external', detail: `:${p.port} · ${p.latency_ms != null ? ms(p.latency_ms) : STATE_TEXT[p.state]}` })),
    ...s.links.filter(l => l.up !== null).map(l => ({ name: l.name, ok: l.up, detail: l.subtitle })),
  ];
}

// nvidia-smi says [N/A] for a reading it can't take (monitor._num -> null): show a dash rather than throw and stop every later card.
const fx = (v, unit = '', d = 0) => v != null ? `${v.toFixed(d)}${unit}` : '—';
const pctOf = (a, b) => a != null && b ? a / b * 100 : null;

function bar(label, sub, value, pct, hot = false) {
  const v = Math.max(0, Math.min(100, Number(pct) || 0));
  return `<div class="bar"><div class="bar__top"><span>${esc(label)}${sub ? ` <span class="dim">${esc(sub)}</span>` : ''}</span><b>${esc(value)}</b></div>
    <div class="bar__track"><div class="bar__fill${hot ? ' bar__fill--hot' : ''}" style="--v:${v}%"></div></div></div>`;
}

function system(s) {
  const w = s.widgets.system;
  if (!w.data?.disks) return { meta: '', body: empty('chip', 'Reading host…', w.error || '') };
  const d = w.data;
  const disks = d.disks.map(k => bar(k.name, k.mount, `${bytes(k.used)} / ${bytes(k.size)}`, k.percent, k.percent >= 85)).join('');
  return {
    meta: `${esc(d.host)} · ${esc(s.ip)}${staleChip(w)}`,
    body: disks,
  };
}

// ---- Monitoring ---------------------------------------------------------------------------------------------

const tempClass = t => (t == null ? '' : t >= 85 ? ' mon-temp--hot' : t >= 70 ? ' mon-temp--warm' : '');
// A column's heading carries its temperature, so the card stays short enough for the 1440p grid even in a browser window.
const monHead = (label, temp, withTemp = true) =>
  `<div class="mon-head"><span class="mon-col__label">${esc(label)}</span>${withTemp
    ? `<span class="mon-temp${tempClass(temp)}" title="${esc(label)} temperature"><small>temp</small>${temp != null ? `${temp.toFixed(1)}°` : '—'}</span>` : ''}</div>`;
// A full-view section's heading: its name, then its temperatures on the right like a machine panel's (main one last).
const secHead = (label, temps) =>
  `<div class="mon-head mon-head--sec"><span class="hud">${esc(label)}</span><span class="mon-temps">${temps.map(([k, t, main]) =>
    `<span class="mon-temp${main ? '' : ' mon-temp--sub'}${tempClass(t)}" title="${esc(label.split(' ·')[0])} ${esc(k)}"><small>${esc(k)}</small>${t != null ? `${t.toFixed(1)}°` : '—'}</span>`).join('')}</span></div>`;
const busiestCore = cores => cores.reduce((max, p) => (p != null && (max == null || p > max) ? p : max), null);

// The other machines on the estate (app/machines.py): one panel each, in Remote Access order.
function machinePanel(m) {
  const st = m.stats, asleep = m.up === false;
  const dot = asleep ? (m.always_on ? '<span class="dot dot--bad"></span>' : '<span class="dot"></span>') : m.error && !st ? '<span class="dot dot--bad"></span>' : m.up ? '<span class="dot dot--ok"></span>' : '<span class="dot"></span>';
  const temp = st?.cpu?.temp ?? null;
  const stale = m.at && Date.now() / 1000 - m.at > 90;
  const sub = asleep ? (m.at ? `Asleep · last seen ${hhmm(m.at)}` : 'Asleep')
    : st ? [st.os, st.uptime_s != null ? `up ${duration(st.uptime_s)}` : '', stale ? `as of ${hhmm(m.at)}` : ''].filter(Boolean).join(' · ') : '';
  let body = '';
  if (st) {
    const cpu = st.cpu?.percent, memPct = st.mem?.total ? st.mem.used / st.mem.total * 100 : null;
    const disks = st.disks || [];
    const full = disks.reduce((a, d) => (!a || (d.total - d.free) / d.total > (a.total - a.free) / a.total ? d : a), null);
    const fullPct = full ? (full.total - full.free) / full.total * 100 : 0;
    const extra = [];
    if (st.gpu?.temp != null) extra.push(['GPU temp', `${st.gpu.temp.toFixed(0)}°C`]);
    if (st.battery) extra.push(['battery', `${st.battery.percent}% · ${st.battery.status}`]);
    if (st.pi) extra.push(['power', st.pi.under_voltage_now ? 'Low now' : st.pi.under_voltage_seen ? 'Low since boot' : 'OK']);
    if (st.drive_temps?.length) extra.push(['drives', `up to ${Math.max(...st.drive_temps.map(d => d.temp)).toFixed(0)}°C`]);
    if (st.raid) extra.push(['RAID', `${st.raid.health || '—'}${st.raid.events_24h ? ` · ${st.raid.events_24h} warnings today` : ''}`]);
    body = `${bar('CPU', '', cpu != null ? `${cpu}%` : '—', cpu ?? 0, (cpu ?? 0) >= 85)}
      ${memPct != null ? bar('RAM', '', `${bytes(st.mem.used)} / ${bytes(st.mem.total)}`, memPct, memPct >= 85) : ''}
      ${full ? `<div title="${esc(disks.map(d => `${d.mount}: ${bytes(d.free)} free of ${bytes(d.total)}`).join('\n'))}">${bar('Disk', full.mount, `${bytes(full.free)} free`, fullPct, fullPct >= 90)}</div>` : ''}
      ${st.gpu && st.gpu.percent != null ? bar('GPU', '', `${st.gpu.percent}%`, st.gpu.percent, st.gpu.percent >= 85) : ''}
      ${extra.length ? `<dl class="kv">${extra.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}`;
  }
  return `<div class="mach${asleep ? ' mach--asleep' : ''}">
    <div class="mon-head"><span class="mach__name">${dot}<span class="mon-col__label">${esc(m.name)}</span><a class="mach__hist" href="#stats" data-rs-machine="rh${esc(m.id)}" title="${esc(m.name)}’s history">${ico('chart')}</a></span>${temp != null && !asleep
      ? `<span class="mon-temp${tempClass(temp)}" title="CPU temperature"><small>temp</small>${temp.toFixed(1)}°</span>` : ''}</div>
    ${sub ? `<div class="mach__sub">${esc(sub)}</div>` : ''}
    ${m.error && !asleep ? `<div class="mach__err">${esc(m.error)}</div>` : ''}
    ${asleep ? '' : body}</div>`;
}

const machinesSection = list => list?.length
  ? `<div class="mon-section mon-machines"><span class="hud">Machines</span><div class="mach-grid">${list.map(machinePanel).join('')}</div></div>` : '';

function monitoring(s, ctx) {
  const m = s.monitoring;
  if (!m) return { meta: '', body: empty('chip', 'Reading sensors…', '') };
  const cpuTemp = m.cpu.temp.package;
  const gpuTemp = m.gpu?.temp ?? null;
  const cpuPct = m.cpu.percent ?? 0;
  const memPct = m.mem.used / m.mem.total * 100;

  if (!ctx.expanded) {
    const busiest = busiestCore(m.cpu.per_core);
    const vramPct = m.gpu ? pctOf(m.gpu.mem_used_mb, m.gpu.mem_total_mb) : null;
    const powerPct = m.gpu ? pctOf(m.gpu.power_w, m.gpu.power_limit_w) : null;
    const gpuBars = m.gpu
      ? `${bar('Usage', '', m.gpu.percent != null ? `${m.gpu.percent}%` : '—', m.gpu.percent, m.gpu.percent >= 85)}
         ${bar('VRAM', '', vramPct != null ? `${Math.round(vramPct)}%` : '—', vramPct, vramPct >= 85)}
         ${m.gpu.power_limit_w ? bar('Power', '', fx(m.gpu.power_w, ' W'), powerPct, powerPct >= 90) : ''}`
      : '<p class="dim">No GPU detected.</p>';
    const ms = s.machines || [];
    return {
      meta: ms.length ? `machines ${ms.filter(m => m.up).length} / ${ms.length} on` : '',
      body: `<div class="mon-split">
        <div class="mon-col">
          ${monHead('CPU', cpuTemp)}
          <div class="mon-bars">
            ${bar('Usage', '', m.cpu.percent != null ? `${m.cpu.percent}%` : '—', cpuPct, cpuPct >= 85)}
            ${bar('Busiest core', '', busiest != null ? `${busiest}%` : '—', busiest ?? 0, (busiest ?? 0) >= 85)}
            ${bar('RAM', '', `${Math.round(memPct)}%`, memPct, memPct >= 85)}
          </div>
        </div>
        <div class="mon-col">
          ${monHead('GPU', gpuTemp, !!m.gpu)}
          <div class="mon-bars">${gpuBars}</div>
        </div>
      </div>`,
    };
  }

  const cores = m.cpu.per_core.map((p, i) => bar(`core ${i}`, '', p != null ? `${p}%` : '—', p ?? 0, (p ?? 0) >= 85)).join('');
  const mem = m.mem, swapPct = mem.swap_total ? mem.swap_used / mem.swap_total * 100 : 0;
  const gpuSection = m.gpu
    ? `<div class="mon-section">${secHead(`GPU · ${m.gpu.name}`, [['temp', m.gpu.temp, true]])}
        ${bar('Usage', '', m.gpu.percent != null ? `${m.gpu.percent}%` : '—', m.gpu.percent, m.gpu.percent >= 85)}
        ${bar('VRAM', '', m.gpu.mem_used_mb != null && m.gpu.mem_total_mb != null ? `${bytes(m.gpu.mem_used_mb * 1024 * 1024)} / ${bytes(m.gpu.mem_total_mb * 1024 * 1024)}` : '—', pctOf(m.gpu.mem_used_mb, m.gpu.mem_total_mb))}
        ${m.gpu.power_limit_w ? bar('Power', '', `${fx(m.gpu.power_w, ' W')} / ${fx(m.gpu.power_limit_w, ' W')}`, pctOf(m.gpu.power_w, m.gpu.power_limit_w)) : ''}
      </div>`
    : `<div class="mon-section"><span class="hud">GPU</span><p class="dim">No NVIDIA GPU detected.</p></div>`;

  // The header readout (which opens this) keeps the temperatures, usage and uptime; the rest of the old readout is here,
  // with the GPU's clocks and fan. Temperatures sit in the CPU and GPU headings; the services are on the System tile.
  const checks = serviceChecks(s), up = s.widgets?.system?.data?.uptime_s;
  const pc = `<div class="mon-section"><span class="hud">This PC</span>
      <dl class="kv"><dt>name</dt><dd>${esc(s.host)}</dd><dt>LAN address</dt><dd>${esc(s.ip || '—')}</dd>
        ${up != null ? `<dt>uptime</dt><dd>${esc(duration(up))}</dd>` : ''}
        <dt>services</dt><dd>${checks.filter(c => c.ok).length} / ${checks.length} up</dd>
        <dt>load (1/5/15m)</dt><dd>${m.load.map(x => x.toFixed(2)).join(' · ')}</dd>
        ${m.gpu ? `<dt>GPU core clock</dt><dd>${fx(m.gpu.clock_sm_mhz, ' MHz')}</dd>
          <dt>GPU memory clock</dt><dd>${fx(m.gpu.clock_mem_mhz, ' MHz')}</dd>
          <dt>buffers + cached</dt><dd>${bytes(m.mem.buffers + m.mem.cached)}</dd>
          ${m.gpu.fan_percent != null ? `<dt>GPU fan</dt><dd>${m.gpu.fan_percent.toFixed(0)}%</dd>` : ''}` : ''}
        ${m.gpu ? '' : `<dt>buffers + cached</dt><dd>${bytes(m.mem.buffers + m.mem.cached)}</dd>`}</dl>
    </div>`;
  return {
    meta: '',
    body: `<div class="mon-cols"><div><div class="mon-section">${secHead('CPU', [...m.cpu.temp.chiplets.map(c => [c.label, c.temp]), ['temp', cpuTemp, true]])}
        ${bar('Overall', '', m.cpu.percent != null ? `${m.cpu.percent}%` : '—', cpuPct, cpuPct >= 85)}
        <div class="mon-cores">${cores}</div>
      </div></div>
      <div>${gpuSection}
      <div class="mon-section"><span class="hud">Memory</span>
        ${bar('Used', '', `${bytes(mem.used)} / ${bytes(mem.total)}`, memPct, memPct >= 85)}
        ${mem.swap_total ? bar('Swap', '', `${bytes(mem.swap_used)} / ${bytes(mem.swap_total)}`, swapPct) : ''}
      </div></div>
      <div>${pc}</div></div>${machinesSection(s.machines)}`,
  };
}

// ---- Registry (order = order in the flowing grid on small screens) -----------------------------------------

const content = Object.fromEntries(contentCards.map(c => [c.id, c]));

export const cards = [
  { id: 'now', area: 'now', cls: 'now', label: 'Now', flush: true, render: now },
  content.gigs,
  { id: 'diary', area: 'diary', label: 'Calendar', flush: true, render: diary,
    filters: [{ label: 'Next 7 days', value: '7' }, { label: 'Next 14 days', value: '14' }, { label: 'Next 30 days', value: '30' }, { label: 'Next 60 days', value: '60' }], defaultFilter: '14', phoneFilter: '30' },
  { id: 'remote', area: 'remote', label: 'Remote Access', render: remote,
    headerAction: { icon: 'plus', label: 'Add a device', href: '/settings?add=remote#remote' } },
  content.releases,
  content.vinyl,
  content.radar,
  // The projects Citadel starts and stops (id kept as "projects": its log view and Settings use it)
  { id: 'projects', area: 'proj', label: 'Services', flush: true, render: projects,
    filters: [{ label: 'All', value: 'all' }, { label: 'Running', value: 'running' }, { label: 'Stopped', value: 'stopped' }] },
  { id: 'launchpad', area: 'launch', label: 'Launchpad', render: launchpad, search: true },
  // Disk usage only (id kept as "system": the widget still feeds uptime to Monitoring and Settings)
  { id: 'system', area: 'sys', label: 'Storage', render: system },
  // No tile of its own on wide screens: the header readout opens it (dashboard.css .card--popout). Last, so it doesn't
  // take a number from the tiles.
  { id: 'monitoring', area: 'mon', cls: 'card--popout', label: 'Monitoring', render: monitoring },
];

/* McQueen Hub — app.js
   Session 1.5: calendar picker, pull-to-refresh, real week navigation. */
"use strict";

const CONFIG = {
  CLIENT_ID: "508766830058-i6fta7vh37vu0o167vvsm74d2vr674dd.apps.googleusercontent.com",
  SCOPES: "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/userinfo.email",
  TZ: "America/Los_Angeles",
  BRIEF_TITLE: "🌙 Daily Brief",
};

const $ = (id) => document.getElementById(id);
const state = {
  token: null, tokenExp: 0,
  email: localStorage.getItem("hub.email") || "",
  tokenClient: null,
  cals: [],                 // calendarList entries (all selected-in-Google)
  calsOff: new Set(JSON.parse(localStorage.getItem("hub.calsOff") || "[]")),
  ranges: {},               // "startISO:days" -> [{ev, cal}]
  weekOffset: 0,
};

/* ---------- date helpers (family TZ) ---------- */
const fmt = (d, opts) => new Intl.DateTimeFormat("en-US", { timeZone: CONFIG.TZ, ...opts }).format(d);
function todayISO() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: CONFIG.TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function isoPlus(yyyy_mm_dd, days) {
  const d = new Date(yyyy_mm_dd + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function mondayOf(yyyy_mm_dd) {
  const d = new Date(yyyy_mm_dd + "T12:00:00Z");
  return isoPlus(yyyy_mm_dd, -((d.getUTCDay() + 6) % 7));
}
const labelFor = (iso) => fmt(new Date(iso + "T12:00:00"), { weekday: "long", month: "short", day: "numeric" });

/* ---------- auth ---------- */
function initAuth() {
  state.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: CONFIG.SCOPES,
    callback: onToken,
    error_callback: () => { showSignin(); },
  });
  const cachedTok = localStorage.getItem("hub.tok");
  const cachedExp = Number(localStorage.getItem("hub.tokExp") || 0);
  if (cachedTok && Date.now() < cachedExp - 60000) {
    state.token = cachedTok; state.tokenExp = cachedExp;
    showMain(); boot();
    return;
  }
  if (localStorage.getItem("hub.authed") === "1") requestToken(); else showSignin();
}
function requestToken() {
  // prompt:"" — Google shows UI only when actually needed (no forced re-consent).
  state.tokenClient.requestAccessToken({ prompt: "" });
}
async function onToken(resp) {
  if (resp.error) { showSignin(); return; }
  state.token = resp.access_token;
  state.tokenExp = Date.now() + (resp.expires_in - 60) * 1000;
  localStorage.setItem("hub.authed", "1");
  localStorage.setItem("hub.tok", state.token);
  localStorage.setItem("hub.tokExp", String(state.tokenExp));
  if (!state.email) {
    try {
      const r = await gapiFetch("https://www.googleapis.com/oauth2/v2/userinfo");
      state.email = r.email || "";
      localStorage.setItem("hub.email", state.email);
    } catch (_) {}
  }
  showMain(); boot();
}
function ensureToken() {
  if (state.token && Date.now() < state.tokenExp) return true;
  requestToken();
  return false;
}

/* ---------- google calendar ---------- */
async function gapiFetch(url) {
  const r = await fetch(url, { headers: { Authorization: "Bearer " + state.token } });
  if (r.status === 401) { state.token = null; localStorage.removeItem("hub.tok"); requestToken(); throw new Error("auth"); }
  if (!r.ok) throw new Error("http " + r.status);
  return r.json();
}
async function boot() {
  try {
    const data = await gapiFetch("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250");
    state.cals = (data.items || []).filter((c) => c.selected !== false || c.primary);
    await refreshAll();
  } catch (e) { if (String(e.message) !== "auth") toast("Couldn't load calendars"); }
}
async function fetchRange(startISO, days) {
  const key = startISO + ":" + days;
  if (state.ranges[key]) return state.ranges[key];
  const timeMin = isoPlus(startISO, -1) + "T00:00:00Z";
  const timeMax = isoPlus(startISO, days + 1) + "T00:00:00Z";
  const all = [];
  await Promise.all(state.cals.map(async (cal) => {
    try {
      const url = "https://www.googleapis.com/calendar/v3/calendars/" + encodeURIComponent(cal.id) +
        "/events?singleEvents=true&orderBy=startTime&maxResults=250" +
        "&timeZone=" + encodeURIComponent(CONFIG.TZ) +
        "&timeMin=" + encodeURIComponent(timeMin) + "&timeMax=" + encodeURIComponent(timeMax);
      const data = await gapiFetch(url);
      (data.items || []).forEach((ev) => { if (ev.status !== "cancelled") all.push({ ev, cal }); });
    } catch (_) {}
  }));
  const seen = new Set();
  state.ranges[key] = all.filter(({ ev }) => {
    const k = (ev.iCalUID || ev.id) + "|" + JSON.stringify(ev.start);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  return state.ranges[key];
}
async function refreshAll() {
  state.ranges = {};
  await renderToday();
  await renderWeek();
}

/* ---------- rendering ---------- */
const calOn = (cal) => !state.calsOff.has(cal.id);
const evDate = (ev) => ev.start.date || ev.start.dateTime.slice(0, 10);
function evTime(ev) {
  if (ev.start.date) return "all day";
  return fmt(new Date(ev.start.dateTime), { hour: "numeric", minute: "2-digit" }).toLowerCase();
}
function eventRow({ ev, cal }) {
  const row = document.createElement("div"); row.className = "event";
  const t = document.createElement("div"); t.className = "time" + (ev.start.date ? " allday" : "");
  t.textContent = evTime(ev);
  const w = document.createElement("div"); w.className = "what";
  const ti = document.createElement("div"); ti.className = "title"; ti.textContent = ev.summary || "(no title)";
  const c = document.createElement("div"); c.className = "cal"; c.textContent = cal.summaryOverride || cal.summary || "";
  w.append(ti, c); row.append(t, w);
  return row;
}
function visible(events) {
  return events.filter((x) => calOn(x.cal) && (x.ev.summary || "").trim() !== CONFIG.BRIEF_TITLE);
}
async function renderToday() {
  const today = todayISO();
  const events = await fetchRange(today, 2);
  $("hdr-date").textContent = fmt(new Date(), { weekday: "long", month: "long", day: "numeric" });
  $("hdr-user").textContent = state.email;

  const brief = events.find(({ ev, cal }) => calOn(cal) && (ev.summary || "").trim() === CONFIG.BRIEF_TITLE && evDate(ev) === today);
  if (brief && brief.ev.description) { $("brief").hidden = false; $("brief-body").textContent = brief.ev.description; }
  else $("brief").hidden = true;

  const vis = visible(events);
  fillList($("today-list"), vis.filter((x) => evDate(x.ev) === today), "Nothing scheduled — open day.");
  fillList($("tomorrow-list"), vis.filter((x) => evDate(x.ev) === isoPlus(today, 1)), "Nothing yet.");
}
async function renderWeek() {
  const monday = isoPlus(mondayOf(todayISO()), state.weekOffset * 7);
  const sunday = isoPlus(monday, 6);
  $("week-label").textContent =
    fmt(new Date(monday + "T12:00:00"), { month: "short", day: "numeric" }) + " – " +
    fmt(new Date(sunday + "T12:00:00"), { month: "short", day: "numeric" }) +
    (state.weekOffset === 0 ? "" : state.weekOffset > 0 ? `  (+${state.weekOffset}w)` : `  (${state.weekOffset}w)`);
  const wk = $("week-list");
  wk.innerHTML = "<div class='empty'>Loading…</div>";
  const events = visible(await fetchRange(monday, 7));
  wk.innerHTML = "";
  const today = todayISO();
  for (let i = 0; i < 7; i++) {
    const dISO = isoPlus(monday, i);
    const dayEvents = events.filter((x) => evDate(x.ev) === dISO);
    const g = document.createElement("div"); g.className = "day-group" + (dISO < today ? " past" : "");
    const h = document.createElement("div"); h.className = "day-head";
    h.textContent = (dISO === today ? "Today · " : "") + labelFor(dISO);
    g.append(h);
    if (dayEvents.length === 0) { const e = document.createElement("div"); e.className = "empty"; e.textContent = "—"; g.append(e); }
    else { const l = document.createElement("div"); l.className = "event-list compact"; dayEvents.forEach((x) => l.append(eventRow(x))); g.append(l); }
    wk.append(g);
  }
}
function fillList(el, items, emptyMsg) {
  el.innerHTML = "";
  if (items.length === 0) { const e = document.createElement("div"); e.className = "empty"; e.textContent = emptyMsg; el.append(e); return; }
  items.forEach((x) => el.append(eventRow(x)));
}

/* ---------- calendar picker ---------- */
function openSettings() {
  const list = $("cal-list"); list.innerHTML = "";
  [...state.cals]
    .sort((a, b) => (a.summaryOverride || a.summary || "").localeCompare(b.summaryOverride || b.summary || ""))
    .forEach((cal) => {
      const row = document.createElement("label"); row.className = "cal-row";
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = calOn(cal);
      cb.addEventListener("change", () => {
        cb.checked ? state.calsOff.delete(cal.id) : state.calsOff.add(cal.id);
        localStorage.setItem("hub.calsOff", JSON.stringify([...state.calsOff]));
        renderToday(); renderWeek();
      });
      const name = document.createElement("span"); name.textContent = cal.summaryOverride || cal.summary || cal.id;
      row.append(cb, name); list.append(row);
    });
  $("settings").hidden = false;
}

/* ---------- pull to refresh ---------- */
function wirePullToRefresh() {
  let startY = null, pulling = false;
  const ptr = $("ptr");
  document.addEventListener("touchstart", (e) => {
    if (window.scrollY <= 0 && $("screen-main").hidden === false) { startY = e.touches[0].clientY; pulling = false; }
    else startY = null;
  }, { passive: true });
  document.addEventListener("touchmove", (e) => {
    if (startY === null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 12 && window.scrollY <= 0) {
      pulling = dy > 70;
      ptr.hidden = false;
      ptr.textContent = pulling ? "Release to refresh" : "Pull to refresh";
      ptr.style.height = Math.min(dy * 0.45, 52) + "px";
    }
  }, { passive: true });
  document.addEventListener("touchend", async () => {
    if (startY !== null && pulling) {
      ptr.textContent = "Refreshing…"; ptr.style.height = "40px";
      if (ensureToken()) await refreshAll();
    }
    ptr.hidden = true; ptr.style.height = "0px"; startY = null; pulling = false;
  });
}

/* ---------- UI plumbing ---------- */
function showSignin() { $("screen-signin").hidden = false; $("screen-main").hidden = true; }
function showMain() { $("screen-signin").hidden = true; $("screen-main").hidden = false; }
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => { t.hidden = true; }, 3500);
}
function wireUI() {
  $("btn-signin").addEventListener("click", requestToken);
  $("btn-settings").addEventListener("click", openSettings);
  $("settings-close").addEventListener("click", () => { $("settings").hidden = true; });
  $("settings").addEventListener("click", (e) => { if (e.target === $("settings")) $("settings").hidden = true; });
  $("brief-toggle").addEventListener("click", () => {
    const b = $("brief-body"); b.hidden = !b.hidden;
    $("brief-chevron").textContent = b.hidden ? "▾" : "▴";
  });
  $("week-prev").addEventListener("click", () => { state.weekOffset--; renderWeek(); });
  $("week-next").addEventListener("click", () => { state.weekOffset++; renderWeek(); });
  $("week-today").addEventListener("click", () => { state.weekOffset = 0; renderWeek(); });
  document.querySelectorAll(".tabbar button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tabbar button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      ["today", "week", "lists", "capture"].forEach((t) => { $("tab-" + t).hidden = t !== btn.dataset.tab; });
    });
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && localStorage.getItem("hub.authed") === "1" && ensureToken()) refreshAll();
  });
  wirePullToRefresh();
}
window.addEventListener("load", () => {
  wireUI();
  const start = () => (window.google && google.accounts ? initAuth() : setTimeout(start, 150));
  start();
});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

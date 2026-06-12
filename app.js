/* McQueen Hub — app.js (Session 1: auth + Today/Week + brief banner) */
"use strict";

const CONFIG = {
  // Paste the OAuth client ID once created (Google Cloud console → Credentials).
  CLIENT_ID: "__OAUTH_CLIENT_ID__",
  SCOPES: "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/userinfo.email",
  TZ: "America/Los_Angeles",
  BRIEF_TITLE: "🌙 Daily Brief",
  WEEK_DAYS: 7,
};

const $ = (id) => document.getElementById(id);
const state = { token: null, tokenExp: 0, email: localStorage.getItem("hub.email") || "", tokenClient: null, events: [], calsById: {} };

/* ---------- date helpers (all in family TZ) ---------- */
const fmt = (d, opts) => new Intl.DateTimeFormat("en-US", { timeZone: CONFIG.TZ, ...opts }).format(d);
const dayKey = (d) => fmt(d, { year: "numeric", month: "2-digit", day: "2-digit" }); // MM/DD/YYYY-ish stable key
function startOfTodayISO() {
  // Midnight today in family TZ, expressed as ISO with offset handled by Date math
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: CONFIG.TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now); // YYYY-MM-DD
  return parts;
}
function isoDatePlus(yyyy_mm_dd, days) {
  const d = new Date(yyyy_mm_dd + "T12:00:00Z"); // noon UTC avoids DST edges
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ---------- auth ---------- */
function initAuth() {
  state.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: CONFIG.SCOPES,
    callback: onToken,
    error_callback: (e) => { toast("Sign-in didn't complete" + (e && e.type ? ` (${e.type})` : "")); showSignin(); },
  });
  const hasAuthed = localStorage.getItem("hub.authed") === "1";
  if (hasAuthed) requestToken(false); else showSignin();
}
function requestToken(interactive) {
  state.tokenClient.requestAccessToken({ prompt: interactive ? "consent" : "" });
}
async function onToken(resp) {
  if (resp.error) { showSignin(); return; }
  state.token = resp.access_token;
  state.tokenExp = Date.now() + (resp.expires_in - 60) * 1000;
  localStorage.setItem("hub.authed", "1");
  if (!state.email) {
    try {
      const r = await gapiFetch("https://www.googleapis.com/oauth2/v2/userinfo");
      state.email = r.email || "";
      localStorage.setItem("hub.email", state.email);
    } catch (_) {}
  }
  showMain();
  loadCalendars();
}
function ensureToken() {
  if (state.token && Date.now() < state.tokenExp) return true;
  requestToken(false); // silent refresh via existing grant
  return false;
}

/* ---------- google calendar ---------- */
async function gapiFetch(url) {
  const r = await fetch(url, { headers: { Authorization: "Bearer " + state.token } });
  if (r.status === 401) { state.token = null; throw new Error("auth"); }
  if (!r.ok) throw new Error("http " + r.status);
  return r.json();
}
async function loadCalendars() {
  try {
    const data = await gapiFetch("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250");
    const cals = (data.items || []).filter((c) => c.selected !== false || c.primary);
    state.calsById = Object.fromEntries(cals.map((c) => [c.id, c]));
    await loadEvents(cals);
  } catch (e) {
    if (String(e.message) === "auth") return; // token refresh will re-trigger
    toast("Couldn't load calendars");
  }
}
async function loadEvents(cals) {
  // Fetch a generous UTC window (±1 day); rendering filters precisely by family-TZ date.
  const startDate = startOfTodayISO();
  const timeMin = isoDatePlus(startDate, -1) + "T00:00:00Z";
  const timeMax = isoDatePlus(startDate, CONFIG.WEEK_DAYS + 2) + "T00:00:00Z";
  const all = [];
  await Promise.all(cals.map(async (cal) => {
    try {
      const url = "https://www.googleapis.com/calendar/v3/calendars/" + encodeURIComponent(cal.id) +
        "/events?singleEvents=true&orderBy=startTime&maxResults=250" +
        "&timeZone=" + encodeURIComponent(CONFIG.TZ) +
        "&timeMin=" + encodeURIComponent(timeMin) +
        "&timeMax=" + encodeURIComponent(timeMax);
      const data = await gapiFetch(url);
      (data.items || []).forEach((ev) => { if (ev.status !== "cancelled") all.push({ ev, cal }); });
    } catch (_) { /* per-calendar failures are non-fatal */ }
  }));
  // Dedupe shared events that appear on multiple calendars
  const seen = new Set();
  state.events = all.filter(({ ev }) => {
    const k = (ev.iCalUID || ev.id) + "|" + JSON.stringify(ev.start);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  render();
}

/* ---------- rendering ---------- */
function evStartDate(ev) { return ev.start.date || ev.start.dateTime.slice(0, 10); }
function evTimeLabel(ev) {
  if (ev.start.date) return "all day";
  return fmt(new Date(ev.start.dateTime), { hour: "numeric", minute: "2-digit" }).toLowerCase();
}
function eventRow({ ev, cal }) {
  const row = document.createElement("div"); row.className = "event";
  const t = document.createElement("div"); t.className = "time" + (ev.start.date ? " allday" : "");
  t.textContent = evTimeLabel(ev);
  const w = document.createElement("div"); w.className = "what";
  const ti = document.createElement("div"); ti.className = "title"; ti.textContent = ev.summary || "(no title)";
  const c = document.createElement("div"); c.className = "cal"; c.textContent = cal.summaryOverride || cal.summary || "";
  w.append(ti, c); row.append(t, w);
  return row;
}
function render() {
  const today = startOfTodayISO();
  const tomorrow = isoDatePlus(today, 1);

  // Brief: today's "🌙 Daily Brief" event
  const brief = state.events.find(({ ev }) => (ev.summary || "").trim() === CONFIG.BRIEF_TITLE && evStartDate(ev) === today);
  if (brief && brief.ev.description) {
    $("brief").hidden = false;
    $("brief-body").textContent = brief.ev.description;
  } else { $("brief").hidden = true; }

  const visible = state.events.filter(({ ev }) => (ev.summary || "").trim() !== CONFIG.BRIEF_TITLE);

  // Header
  $("hdr-date").textContent = fmt(new Date(), { weekday: "long", month: "long", day: "numeric" });
  $("hdr-user").textContent = state.email;

  // Today + tomorrow
  $("today-title").textContent = "Today";
  $("tomorrow-title").textContent = "Tomorrow";
  fillList($("today-list"), visible.filter((x) => evStartDate(x.ev) === today), "Nothing scheduled — open day.");
  fillList($("tomorrow-list"), visible.filter((x) => evStartDate(x.ev) === tomorrow), "Nothing yet.");

  // Week
  const wk = $("week-list"); wk.innerHTML = "";
  for (let i = 0; i < CONFIG.WEEK_DAYS; i++) {
    const dISO = isoDatePlus(today, i);
    const dayEvents = visible.filter((x) => evStartDate(x.ev) === dISO);
    const g = document.createElement("div"); g.className = "day-group";
    const h = document.createElement("div"); h.className = "day-head";
    const labelDate = new Date(dISO + "T12:00:00");
    h.textContent = i === 0 ? "Today" : i === 1 ? "Tomorrow" : fmt(labelDate, { weekday: "long", month: "short", day: "numeric" });
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

/* ---------- UI plumbing ---------- */
function showSignin() { $("screen-signin").hidden = false; $("screen-main").hidden = true; }
function showMain() { $("screen-signin").hidden = true; $("screen-main").hidden = false; }
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => { t.hidden = true; }, 3500);
}
function wireUI() {
  $("btn-signin").addEventListener("click", () => requestToken(true));
  $("btn-refresh").addEventListener("click", () => { if (ensureToken()) loadCalendars(); });
  $("brief-toggle").addEventListener("click", () => {
    const b = $("brief-body"); b.hidden = !b.hidden;
    $("brief-chevron").textContent = b.hidden ? "▾" : "▴";
  });
  document.querySelectorAll(".tabbar button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tabbar button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      ["today", "week", "lists", "capture"].forEach((t) => { $("tab-" + t).hidden = t !== btn.dataset.tab; });
    });
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && localStorage.getItem("hub.authed") === "1" && !ensureToken()) { /* refresh in flight */ }
    else if (!document.hidden && state.token) loadCalendars();
  });
}
window.addEventListener("load", () => {
  wireUI();
  const boot = () => (window.google && google.accounts ? initAuth() : setTimeout(boot, 150));
  boot();
});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

/* McQueen Hub — app.js
   Session 2: Todoist lists + check-off, FAB capture flyout. */
"use strict";

const CONFIG = {
  CLIENT_ID: "508766830058-i6fta7vh37vu0o167vvsm74d2vr674dd.apps.googleusercontent.com",
  SCOPES: "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/userinfo.email",
  TZ: "America/Los_Angeles",
  BRIEF_TITLE: "🌙 Daily Brief",
  TODOIST: "https://api.todoist.com/rest/v2",
};

const $ = (id) => document.getElementById(id);

const state = {
  token: null, tokenExp: 0,
  email: localStorage.getItem("hub.email") || "",
  tokenClient: null,
  cals: [],
  calsOff: new Set(JSON.parse(localStorage.getItem("hub.calsOff") || "[]")),
  ranges: {},
  weekOffset: 0,
  activeTab: "today",
  todoistProjects: [],
  activeListId: localStorage.getItem("hub.activeList") || null,
  fabOpen: false,
};

/* ---------- date helpers ---------- */
const fmt = (d, opts) => new Intl.DateTimeFormat("en-US", { timeZone: CONFIG.TZ, ...opts }).format(d);
function todayISO() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: CONFIG.TZ,
    year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function isoPlus(iso, days) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function mondayOf(iso) {
  const d = new Date(iso + "T12:00:00Z");
  return isoPlus(iso, -((d.getUTCDay() + 6) % 7));
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
    showMain(); boot(); return;
  }
  if (localStorage.getItem("hub.authed") === "1") requestToken(); else showSignin();
}
function requestToken() {
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
  requestToken(); return false;
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
      const url = "https://www.googleapis.com/calendar/v3/calendars/" +
        encodeURIComponent(cal.id) +
        "/events?singleEvents=true&orderBy=startTime&maxResults=250" +
        "&timeZone=" + encodeURIComponent(CONFIG.TZ) +
        "&timeMin=" + encodeURIComponent(timeMin) +
        "&timeMax=" + encodeURIComponent(timeMax);
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

/* ---------- todoist ---------- */
const getTodoistToken = () => localStorage.getItem("hub.todoistToken") || "";

async function todoistFetch(path, method = "GET", body = null) {
  const tok = getTodoistToken();
  if (!tok) throw new Error("no-token");
  const opts = {
    method,
    headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(CONFIG.TODOIST + path, opts);
  if (!r.ok) throw new Error("todoist-" + r.status);
  if (r.status === 204) return null;
  return r.json();
}

async function renderLists() {
  const bar = $("lists-project-bar");
  const tasksEl = $("lists-tasks");

  if (!getTodoistToken()) {
    bar.innerHTML = "";
    tasksEl.innerHTML = `<div class="lists-setup">
      <p>Connect Todoist to see your lists.</p>
      <button class="btn-primary" onclick="openSettings()">Open Settings</button>
    </div>`;
    return;
  }

  bar.innerHTML = `<div class="empty" style="font-size:0.8rem;">Loading…</div>`;
  tasksEl.innerHTML = "";

  try {
    const projects = await todoistFetch("/projects");
    // Top-level non-inbox projects
    state.todoistProjects = (projects || []).filter(p => !p.inboxProject && !p.parentId);

    if (!state.activeListId && state.todoistProjects.length > 0) {
      const groceries = state.todoistProjects.find(p => /grocer/i.test(p.name));
      state.activeListId = groceries ? groceries.id : state.todoistProjects[0].id;
      localStorage.setItem("hub.activeList", state.activeListId);
    }

    buildProjectBar();
    await loadTasks();
  } catch (e) {
    bar.innerHTML = "";
    tasksEl.innerHTML = `<p class="empty">Couldn't load lists. Check Todoist token in Settings.</p>`;
  }
}

function buildProjectBar() {
  const bar = $("lists-project-bar");
  bar.innerHTML = "";
  state.todoistProjects.forEach(p => {
    const btn = document.createElement("button");
    btn.className = "lists-project-btn" + (p.id === state.activeListId ? " active" : "");
    btn.textContent = p.name;
    btn.style.cssText = "border:0;outline:none;-webkit-appearance:none;";
    btn.onclick = () => {
      state.activeListId = p.id;
      localStorage.setItem("hub.activeList", p.id);
      buildProjectBar();
      loadTasks();
    };
    bar.appendChild(btn);
  });
}

async function loadTasks() {
  const el = $("lists-tasks");
  el.innerHTML = `<div class="empty" style="font-size:0.8rem;">Loading…</div>`;
  try {
    const tasks = await todoistFetch("/tasks?project_id=" + state.activeListId);
    el.innerHTML = "";
    if (!tasks || tasks.length === 0) {
      el.innerHTML = `<div class="empty">Nothing here yet.</div>`; return;
    }
    tasks.sort((a, b) => (a.order || 0) - (b.order || 0));
    tasks.forEach(t => el.appendChild(buildTaskRow(t)));
  } catch (e) {
    el.innerHTML = `<div class="empty">Couldn't load tasks.</div>`;
  }
}

function buildTaskRow(task) {
  const row = document.createElement("div");
  row.className = "task-row"; row.id = "task-" + task.id;
  const cb = document.createElement("div");
  cb.className = "task-cb";
  cb.innerHTML = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="1.5" y="1.5" width="17" height="17" rx="4" stroke="var(--line)" stroke-width="1.5"/>
  </svg>`;
  cb.onclick = () => completeTask(task.id);
  const label = document.createElement("span");
  label.className = "task-label"; label.textContent = task.content;
  row.append(cb, label);
  return row;
}

async function completeTask(id) {
  const row = $("task-" + id);
  if (row) { row.style.opacity = "0.3"; row.style.pointerEvents = "none"; }
  try {
    await todoistFetch("/tasks/" + id + "/close", "POST");
    setTimeout(() => { if (row) row.remove(); }, 400);
  } catch (e) {
    toast("Couldn't complete — try again");
    if (row) { row.style.opacity = ""; row.style.pointerEvents = ""; }
  }
}

async function addTodoistTask(content, projectId, dueString) {
  const body = { content };
  if (projectId) body.project_id = projectId;
  if (dueString) body.due_string = dueString;
  await todoistFetch("/tasks", "POST", body);
}

async function createTodoistProject(name) {
  await todoistFetch("/projects", "POST", { name });
}

/* ---------- calendar rendering ---------- */
const calOn = (cal) => !state.calsOff.has(cal.id);
const evDate = (ev) => ev.start.date || ev.start.dateTime.slice(0, 10);
function evTime(ev) {
  if (ev.start.date) return "all day";
  return fmt(new Date(ev.start.dateTime), { hour: "numeric", minute: "2-digit" }).toLowerCase();
}
function eventRow({ ev, cal }) {
  const row = document.createElement("div"); row.className = "event";
  const t = document.createElement("div");
  t.className = "time" + (ev.start.date ? " allday" : "");
  t.textContent = evTime(ev);
  const w = document.createElement("div"); w.className = "what";
  const ti = document.createElement("div"); ti.className = "title"; ti.textContent = ev.summary || "(no title)";
  const c = document.createElement("div"); c.className = "cal";
  c.textContent = cal.summaryOverride || cal.summary || "";
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
  const brief = events.find(({ ev, cal }) =>
    calOn(cal) && (ev.summary || "").trim() === CONFIG.BRIEF_TITLE && evDate(ev) === today);
  if (brief && brief.ev.description) { $("brief").hidden = false; $("brief-body").textContent = brief.ev.description; }
  else $("brief").hidden = true;
  const vis = visible(events);
  const todayTitle = $("today-title");
  if (todayTitle) todayTitle.textContent = "";
  fillList($("today-list"), vis.filter((x) => evDate(x.ev) === today), "Nothing scheduled — open day.");
  const tmrTitle = $("tomorrow-title");
  if (tmrTitle) tmrTitle.textContent = "Tomorrow";
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
    const g = document.createElement("div");
    g.className = "day-group" + (dISO < today ? " past" : "");
    const h = document.createElement("div"); h.className = "day-head";
    h.textContent = (dISO === today ? "Today · " : "") + labelFor(dISO);
    g.append(h);
    if (dayEvents.length === 0) {
      const e = document.createElement("div"); e.className = "empty"; e.textContent = "—"; g.append(e);
    } else {
      const l = document.createElement("div"); l.className = "event-list compact";
      dayEvents.forEach((x) => l.append(eventRow(x))); g.append(l);
    }
    wk.append(g);
  }
}
function fillList(el, items, emptyMsg) {
  el.innerHTML = "";
  if (items.length === 0) {
    const e = document.createElement("div"); e.className = "empty"; e.textContent = emptyMsg;
    el.append(e); return;
  }
  items.forEach((x) => el.append(eventRow(x)));
}

/* ---------- FAB ---------- */
const FAB_OPTS = {
  today: [
    { icon: "ti-calendar-plus", label: "Event" },
    { icon: "ti-circle-check", label: "Task" },
    { icon: "ti-bell", label: "Reminder" },
  ],
  week: [
    { icon: "ti-calendar-plus", label: "Event" },
    { icon: "ti-circle-check", label: "Task" },
    { icon: "ti-bell", label: "Reminder" },
  ],
  lists: [
    { icon: "ti-plus", label: "Item" },
    { icon: "ti-note", label: "Note" },
    { icon: "ti-list", label: "New list" },
  ],
};

function openFab() {
  state.fabOpen = true;
  $("tb-add").classList.add("open");
  $("fab-backdrop").classList.add("open");
  buildFabFlyout();
}
function closeFab() {
  state.fabOpen = false;
  $("tb-add").classList.remove("open");
  $("fab-backdrop").classList.remove("open");
}
function buildFabFlyout() {
  const flyout = $("fab-flyout");
  flyout.innerHTML = "";
  (FAB_OPTS[state.activeTab] || FAB_OPTS.today).forEach(o => {
    const btn = document.createElement("div");
    btn.className = "cap-opt";
    btn.innerHTML = `<i class="ti ${o.icon}" aria-hidden="true"></i>${o.label}`;
    btn.onclick = (e) => { e.stopPropagation(); closeFab(); handleCapture(o.label); };
    flyout.appendChild(btn);
  });
}

function handleCapture(label) {
  switch (label) {
    case "Event":
      toast("Add events directly in Google Calendar");
      break;
    case "Task":
      openCapSheet("task", "New task…", null);
      break;
    case "Reminder":
      openCapSheet("reminder", "Remind me to…", null);
      break;
    case "Item":
      openCapSheet("item", "Add item…", state.activeListId);
      break;
    case "Note":
      openCapSheet("note", "Quick note…", null);
      break;
    case "New list":
      openCapSheet("newlist", "List name…", null);
      break;
  }
}

/* ---------- capture sheet ---------- */
function openCapSheet(type, placeholder, projectId) {
  const sheet = $("cap-sheet");
  const input = $("cap-input");
  input.placeholder = placeholder;
  input.value = "";
  sheet.dataset.type = type;
  sheet.dataset.project = projectId || "";
  sheet.hidden = false;
  setTimeout(() => input.focus(), 80);
}

async function submitCapSheet() {
  const sheet = $("cap-sheet");
  const input = $("cap-input");
  const type = sheet.dataset.type;
  const projectId = sheet.dataset.project || null;
  const value = input.value.trim();
  if (!value) { sheet.hidden = true; return; }
  sheet.hidden = true;

  try {
    if (!getTodoistToken()) { toast("Set a Todoist token in Settings first"); return; }
    if (type === "newlist") {
      await createTodoistProject(value);
      toast("List created");
      renderLists();
    } else {
      const dueString = type === "reminder" ? "today" : undefined;
      await addTodoistTask(value, projectId, dueString);
      toast("Added!");
      if (type === "item" && state.activeTab === "lists") loadTasks();
    }
  } catch (e) {
    toast("Couldn't save — check Todoist token in Settings");
  }
}

/* ---------- settings ---------- */
function openSettings() {
  const list = $("cal-list");
  list.innerHTML = "";
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
      const name = document.createElement("span");
      name.textContent = cal.summaryOverride || cal.summary || cal.id;
      row.append(cb, name); list.append(row);
    });

  // Todoist token row
  const tokenRow = document.createElement("div");
  tokenRow.className = "cal-row todoist-row";
  tokenRow.innerHTML = `
    <div style="font-size:0.9rem;font-weight:600;margin-bottom:8px;color:var(--ink);">Todoist API token</div>
    <input type="password" id="todoist-token-input"
      placeholder="Paste token from todoist.com/app/settings/integrations/developer"
      value="${getTodoistToken()}"
      style="width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;
             font-size:0.88rem;background:var(--bg);color:var(--ink);font-family:inherit;">
    <button onclick="saveTodoistToken()"
      style="margin-top:8px;width:100%;padding:9px;border:0;border-radius:8px;
             background:var(--accent);color:var(--accent-ink);font-weight:600;
             cursor:pointer;font-family:inherit;font-size:0.9rem;">Save token</button>`;
  list.append(tokenRow);

  $("settings").hidden = false;
}

function saveTodoistToken() {
  const val = $("todoist-token-input").value.trim();
  localStorage.setItem("hub.todoistToken", val);
  $("settings").hidden = true;
  toast("Todoist token saved");
  if (state.activeTab === "lists") renderLists();
}

/* ---------- pull to refresh ---------- */
function wirePullToRefresh() {
  let startY = null, pulling = false;
  const ptr = $("ptr");
  document.addEventListener("touchstart", (e) => {
    if (window.scrollY <= 0 && !$("screen-main").hidden) {
      startY = e.touches[0].clientY; pulling = false;
    } else startY = null;
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
      if (state.activeTab === "lists") await renderLists();
    }
    ptr.hidden = true; ptr.style.height = "0px";
    startY = null; pulling = false;
  });
}

/* ---------- tab switching ---------- */
function switchTab(tab) {
  state.activeTab = tab;
  ["today", "week", "lists"].forEach(t => {
    const mainEl = $("tab-" + t);
    const btnEl = $("tb-" + t);
    if (mainEl) mainEl.hidden = (t !== tab);
    if (btnEl) btnEl.classList.toggle("active", t === tab);
  });
  if (tab === "lists") renderLists();
  if (state.fabOpen) buildFabFlyout(); // refresh contextual options
}

/* ---------- UI wiring ---------- */
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

  // Tab bar divs
  ["today", "week", "lists"].forEach(t => {
    const el = $("tb-" + t);
    if (el) el.addEventListener("click", () => switchTab(t));
  });

  // FAB
  $("tb-add").addEventListener("click", () => { state.fabOpen ? closeFab() : openFab(); });
  $("fab-backdrop").addEventListener("click", closeFab);

  // Capture sheet
  $("cap-submit").addEventListener("click", submitCapSheet);
  $("cap-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitCapSheet(); }
  });
  $("cap-sheet-cancel").addEventListener("click", () => { $("cap-sheet").hidden = true; });

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

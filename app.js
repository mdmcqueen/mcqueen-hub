/* McQueen Hub — app.js
   Session 2: Todoist lists + check-off, FAB capture flyout. */
"use strict";

const CONFIG = {
  CLIENT_ID: "508766830058-i6fta7vh37vu0o167vvsm74d2vr674dd.apps.googleusercontent.com",
  SCOPES: "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/userinfo.email",
  SCOPE_VERSION: 3, // bump + it forces a re-consent (v3 adds drive.appdata for settings backup)
  TZ: "America/Los_Angeles",
  BRIEF_TITLE: "🌙 Daily Brief",
  TODOIST: "https://white-thunder-5727.mdmcqueen.workers.dev",
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
  completedRecently: new Map(), // id -> { kind: 'today'|'list', data, expiresAt }
};

const CHECK_OPEN_SVG = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="1.5" y="1.5" width="17" height="17" rx="4" stroke="var(--line)" stroke-width="1.5"/>
</svg>`;
const CHECK_DONE_SVG = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="1.5" y="1.5" width="17" height="17" rx="4" fill="var(--accent)" stroke="var(--accent)" stroke-width="1.5"/>
  <path d="M5.5 10.5L8.5 13.5L14.5 7" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

function pruneCompletedRecently() {
  const now = Date.now();
  for (const [id, e] of state.completedRecently) {
    if (e.expiresAt < now) state.completedRecently.delete(id);
  }
}

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
  const savedScopeVer = Number(localStorage.getItem("hub.scopeVer") || 0);
  const needsReconsent = savedScopeVer < CONFIG.SCOPE_VERSION;
  const cachedTok = localStorage.getItem("hub.tok");
  const cachedExp = Number(localStorage.getItem("hub.tokExp") || 0);
  if (!needsReconsent && cachedTok && Date.now() < cachedExp - 60000) {
    state.token = cachedTok; state.tokenExp = cachedExp;
    showMain(); boot(); return;
  }
  if (localStorage.getItem("hub.authed") === "1") requestToken(needsReconsent); else showSignin();
}
function requestToken(forceConsent) {
  state.tokenClient.requestAccessToken({ prompt: forceConsent ? "consent" : "" });
}
async function onToken(resp) {
  if (resp.error) { showSignin(); return; }
  state.token = resp.access_token;
  state.tokenExp = Date.now() + (resp.expires_in - 60) * 1000;
  localStorage.setItem("hub.authed", "1");
  localStorage.setItem("hub.tok", state.token);
  localStorage.setItem("hub.tokExp", String(state.tokenExp));
  localStorage.setItem("hub.scopeVer", String(CONFIG.SCOPE_VERSION));
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
  await restoreSettingsFromDriveIfEmpty();
  // v58: relaunch lands where you were — with cached lists this paints the
  // grocery list instantly even before any network call resolves.
  const savedTab = localStorage.getItem("hub.activeTab");
  if (savedTab && savedTab !== "today" && savedTab !== state.activeTab) {
    switchTab(savedTab);
  }
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
  const headers = { Authorization: "Bearer " + tok };
  if (body) headers["Content-Type"] = "application/json";
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(CONFIG.TODOIST + path, opts);
  if (!r.ok) throw new Error("todoist-" + r.status);
  if (r.status === 204) return null;
  return r.json();
}

// v51: the v1 API paginates (~100–200 per page) and Whole Foods alone has
// 170+ items — single-page fetches silently dropped everything past page 1.
// Follows nextCursor/next_cursor until exhausted.
async function todoistFetchAll(path) {
  const base = path + (path.includes("?") ? "&" : "?") + "limit=200";
  let out = [], cursor = null, guard = 0;
  do {
    const d = await todoistFetch(base + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
    const arr = Array.isArray(d) ? d :
      (d && (d.results || d.items || d.tasks || d.sections || d.projects)) || [];
    out = out.concat(arr);
    cursor = (d && !Array.isArray(d)) ? (d.nextCursor || d.next_cursor || null) : null;
  } while (cursor && ++guard < 20);
  return out;
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

  // v53: keep existing content on refresh — only show loading when empty
  if (!bar.hasChildNodes()) {
    bar.innerHTML = `<div class="empty" style="font-size:0.8rem;">Loading…</div>`;
  }

  try {
    const projects = await todoistFetchAll("/projects");
    ingestProjects(projects || []);

    if (!state.activeListId && state.todoistProjects.length > 0) {
      const groceries = state.todoistProjects.find(p => /grocer/i.test(p.name));
      state.activeListId = groceries ? groceries.id : state.todoistProjects[0].id;
      localStorage.setItem("hub.activeList", state.activeListId);
    }

    buildProjectBar();
    await loadTasks();
  } catch (e) {
    bar.innerHTML = "";
    tasksEl.innerHTML = `<p class="empty">Error: ${e.message}</p>`;
  }
}

function buildProjectBar(animate) {
  const bar = $("lists-project-bar");
  bar.innerHTML = "";
  const projectsOff = getProjectsOff();
  const visible = allProjectsFlat().filter(p => !projectsOff.has(p.id));
  visible.forEach(p => {
    const btn = document.createElement("button");
    btn.className = "lists-project-btn" + (p.id === state.activeListId ? " active" : "") + (p._depth ? " sub" : "");
    if (animate && p.id === state.activeListId) btn.classList.add("pill-bump"); // v64
    btn.dataset.pid = p.id; // drag-drop target (v49)
    btn.textContent = p.name;
    // v59: needed-count badge on inventory store pills (from list cache)
    if (isInventoryList(p.id)) {
      const n = neededCount(p.id);
      if (n != null) {
        const pc = document.createElement("span");
        pc.className = "pill-count";
        pc.textContent = n;
        btn.appendChild(pc);
      }
    }
    btn.onclick = () => {
      state.activeListId = p.id;
      localStorage.setItem("hub.activeList", p.id);
      buildProjectBar(true); // v64: bump the newly active pill
      loadTasks();
      updateWakeLock(); // v58: lock follows the active list
    };
    // v62: active inventory pill grows a layered cart segment that toggles
    // trip mode (only unchecked items with qty ≥ 1).
    if (p.id === state.activeListId && isInventoryList(p.id)) {
      const grp = document.createElement("div");
      grp.className = "pill-group";
      const tripBtn = document.createElement("button");
      tripBtn.type = "button";
      tripBtn.className = "pill-trip" + (tripOn() ? " on" : "");
      tripBtn.title = "Trip mode — only what we need";
      tripBtn.innerHTML = `<i class="ti ti-shopping-cart" aria-hidden="true"></i>`;
      tripBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        localStorage.setItem("hub.tripMode", tripOn() ? "0" : "1");
        tripBtn.classList.toggle("on", tripOn());
        tripBtn.classList.remove("pill-bump");
        void tripBtn.offsetWidth; // v64: restart the bump animation
        tripBtn.classList.add("pill-bump");
        $("lists-tasks").classList.toggle("trip", tripOn());
      });
      grp.append(btn, tripBtn);
      bar.appendChild(grp);
    } else {
      bar.appendChild(btn);
    }
  });
  syncPillbarHeight(); // v64: keep sticky section heads flush under the bar
}

// v64: .list-section-head's sticky top is `env(safe-area-inset-top) +
// --pillbar-h` (see styles.css) so it stacks directly under the pill bar
// regardless of badge counts/font scaling changing the bar's real height.
function syncPillbarHeight() {
  const bar = $("lists-project-bar");
  if (!bar || bar.hidden) return;
  const h = bar.getBoundingClientRect().height;
  if (h > 0) document.documentElement.style.setProperty("--pillbar-h", h + "px");
}
window.addEventListener("resize", syncPillbarHeight);

/* Grocery family detection (v51). The project named "Groceries" (top level)
   and its children are treated specially:
   - store lists (Whole Foods, Costco) and Pantry are INVENTORY lists —
     checked-off items stay visible in place (dimmed) and can be unchecked
     back onto the list, because grocery items recur; nothing vanishes while
     you're mid-store or taking inventory.
   - the Pantry child renders as a lens: every store item regrouped by its
     home-location label (Cupboard / Fridge / Freezer). */
function groceryContext() {
  const flat = allProjectsFlat();
  const parent = flat.find(p => /^groceries$/i.test(p.name) && !(p.parentId || p.parent_id));
  if (!parent) return null;
  const kids = (state.todoistByParent || {})[parent.id] || [];
  const pantry = kids.find(p => /^pantry$/i.test(p.name)) || null;
  const stores = kids.filter(p => !pantry || p.id !== pantry.id);
  return { parent, pantry, stores };
}
/* v51: inventory behavior is now explicit and controllable per list.
   Default: ON for the grocery family, OFF elsewhere. The ♻︎ toggle above any
   list overrides the default (stored in hub.inventoryMode, backed up to
   Drive). Inventory ON = checked-off items stay visible and uncheckable —
   for recurring-item lists like groceries. OFF = normal Todoist behavior:
   completed tasks disappear from the list. */
const getInventoryOverrides = () => JSON.parse(localStorage.getItem("hub.inventoryMode") || "{}");

function isInventoryList(projectId) {
  const o = getInventoryOverrides();
  if (Object.prototype.hasOwnProperty.call(o, projectId)) return !!o[projectId];
  const ctx = groceryContext();
  if (!ctx) return false;
  return projectId === ctx.parent.id ||
    (ctx.pantry && projectId === ctx.pantry.id) ||
    ctx.stores.some(s => s.id === projectId);
}

// v52: the inventory control lives in Settings > Lists (♻︎ button per row),
// not at the top of each list.
function setInventoryOverride(projectId, val) {
  const o = getInventoryOverrides();
  o[projectId] = val;
  localStorage.setItem("hub.inventoryMode", JSON.stringify(o));
  saveSettingsToDrive();
}

// Completed tasks for an inventory list (rolling ~90-day window, the API max).
async function fetchCompletedItems(projectId) {
  try {
    const since = new Date(Date.now() - 89 * 86400000).toISOString();
    const until = new Date().toISOString();
    const items = await todoistFetchAll("/tasks/completed/by_completion_date?project_id=" + projectId +
      "&since=" + encodeURIComponent(since) + "&until=" + encodeURIComponent(until));
    return (items || []).map(it => ({
      id: it.taskId || it.task_id || it.id,
      content: it.content,
      description: it.description || "",
      labels: it.labels || [],
      priority: it.priority,
      sectionId: it.sectionId || it.section_id || null,
      childOrder: it.childOrder ?? it.child_order ?? null, // v62: manual order
    }));
  } catch (_) { return []; } // endpoint unavailable → behave like a normal list
}

// v46: fetch the project's sections alongside its tasks and render tasks
// grouped under section headers (Groceries' aisle walk-order, etc.).
// v51: inventory lists also fetch completed items and show them dimmed
// inside their section, uncheckable back onto the list.
// v53: section headers show an edit hint and stay visible even when empty
// (a freshly added section must be visible to be usable).
function setSectionHeadContent(head, name) {
  head.textContent = name; // v62: pencil hint removed — tap still renames
}

// "+ Add section" control at the bottom of real (non-lens) lists (v53).
function buildAddSectionControl() {
  const btn = document.createElement("div");
  btn.className = "add-section-btn";
  btn.textContent = "＋ Add section";
  btn.addEventListener("click", () => {
    if (btn.querySelector("input")) return;
    btn.textContent = "";
    const input = document.createElement("input");
    input.className = "sec-rename-input";
    input.placeholder = "Section name…";
    btn.appendChild(input);
    input.focus();
    let done = false;
    const commit = async () => {
      if (done) return; done = true;
      const val = input.value.trim();
      if (!val) { btn.textContent = "＋ Add section"; return; }
      btn.textContent = "Adding…";
      try {
        await todoistFetch("/sections", "POST",
          { name: val, projectId: state.activeListId, project_id: state.activeListId });
        toast("Section added");
        loadTasks();
      } catch (_) {
        toast("Couldn't add section — try again");
        btn.textContent = "＋ Add section";
      }
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } });
  });
  return btn;
}

function listEndMarker() {
  const end = document.createElement("div");
  end.className = "list-end";
  end.textContent = "· end of list ·";
  return end;
}

// v65: replaces the plain end-of-list marker while trip mode is active.
// Checks what's still visible (open + qty >= 1 — exactly what trip mode
// itself keeps on screen) rather than re-deriving that from task data, so
// it can never disagree with what the shopper is actually looking at.
function tripDoneButton() {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "trip-done-btn";
  btn.textContent = "I'm done shopping";
  btn.addEventListener("click", handleTripDone);
  return btn;
}
function remainingTripItems() {
  return Array.from($("lists-tasks").querySelectorAll(".task-row"))
    .filter(r => !r.classList.contains("task-done") && !r.classList.contains("qty-zero"))
    .map(r => r.querySelector(".task-label")?.textContent || "")
    .filter(Boolean);
}
function handleTripDone() {
  const remaining = remainingTripItems();
  if (remaining.length) { showTripSummary(remaining); return; }
  toast("Nice — everything's checked off");
  localStorage.setItem("hub.tripMode", "0");
  $("lists-tasks").classList.remove("trip");
  buildProjectBar();
  loadTasks();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function showTripSummary(names) {
  const modal = document.createElement("div");
  modal.className = "modal";
  const card = document.createElement("div");
  card.className = "modal-card";
  card.innerHTML = `<div class="modal-head"><strong>Still need ${names.length} ${names.length === 1 ? "item" : "items"}</strong><button class="btn-icon" id="trip-modal-close">✕</button></div>
    <div class="trip-remaining-list" id="trip-remaining-list"></div>
    <div class="settings-token-actions" style="margin-top:16px"><button id="trip-modal-continue" class="settings-btn-primary">Keep shopping</button></div>`;
  modal.appendChild(card);
  document.body.appendChild(modal);
  const list = card.querySelector("#trip-remaining-list");
  names.forEach(n => {
    const row = document.createElement("div");
    row.className = "trip-remaining-row";
    row.textContent = n;
    list.appendChild(row);
  });
  lockBodyScroll();
  const close = () => { modal.remove(); unlockBodyScroll(); };
  card.querySelector("#trip-modal-close").onclick = close;
  card.querySelector("#trip-modal-continue").onclick = close;
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
}

/* v58: render body extracted so cached data (instant paint on relaunch) and
   fresh network data share one code path. */
function renderListData(el, data) {
  const { tasks, sections, doneItems, inventory } = data;
  // v56: inventory items stay readable when checked — the checkmark means
  // "stocked at home," not "done with this forever."
  el.classList.toggle("inventory", !!inventory);
  el.classList.toggle("trip", !!inventory && tripOn()); // v59
  pruneCompletedRecently();
  const openIds = new Set(tasks.map(t => t.id));
  const doneIds = new Set(doneItems.map(c => c.id));
  const doneExtras = [...state.completedRecently.values()]
    .filter(e => e.kind === "list" && e.data.projectId === state.activeListId)
    .map(e => e.data.task)
    .filter(t => !openIds.has(t.id) && !doneIds.has(t.id));
  const frag = document.createDocumentFragment();
  const hasContent = (tasks && tasks.length > 0) || doneItems.length > 0 || doneExtras.length > 0;
  if (!hasContent && (!sections || sections.length === 0)) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Nothing here yet.";
    frag.appendChild(empty);
    frag.appendChild(buildAddSectionControl());
    el.replaceChildren(frag);
    return;
  }
  tasks.sort((a, b) => (a.childOrder ?? a.child_order ?? a.order ?? 0) - (b.childOrder ?? b.child_order ?? b.order ?? 0));
  const secOf = (t) => t.sectionId || t.section_id || null;
  const ordOf = (t) => t.childOrder ?? t.child_order ?? t.order ?? Number.MAX_SAFE_INTEGER;
  const renderGroup = (secId) => {
    const open = tasks.filter(t => secOf(t) === secId).map(t => ({ t, done: false }));
    const done = doneItems.filter(c => (c.sectionId || null) === secId).map(t => ({ t, done: true }));
    let group = open.concat(done);
    if (inventory) {
      // v62: ONE manual order per section — checked items keep their shelf
      // position instead of sinking to the bottom, so Michael can arrange
      // items to match how he picks them off the shelf.
      group.sort((a, b) => ordOf(a.t) - ordOf(b.t));
    }
    group.forEach(({ t, done: d }) => frag.appendChild(buildTaskRow(t, d)));
  };
  // Tasks with no section come first (matches Todoist's own layout)
  renderGroup(null);
  const secOrd = (s) => s.sectionOrder ?? s.section_order ?? s.order ?? 0;
  sections.slice().sort((a, b) => secOrd(a) - secOrd(b)).forEach(s => {
    const head = document.createElement("div");
    head.className = "list-section-head";
    head.dataset.sectionId = s.id; // drag-drop target (v49)
    setSectionHeadContent(head, s.name);
    head.addEventListener("click", () => beginSectionRename(head, s)); // v50
    frag.appendChild(head);
    renderGroup(s.id);
  });
  doneExtras.forEach(t => frag.appendChild(buildTaskRow(t, true)));
  frag.appendChild(buildAddSectionControl());
  // v65: swap in the "I'm done shopping" control while trip mode is active
  frag.appendChild((inventory && tripOn()) ? tripDoneButton() : listEndMarker());
  el.replaceChildren(frag);
}

const listCacheKey = (id) => "hub.listCache." + id;
function readListCache(id) {
  try { return JSON.parse(localStorage.getItem(listCacheKey(id)) || "null"); }
  catch (_) { return null; }
}
function writeListCache(id, data) {
  try { localStorage.setItem(listCacheKey(id), JSON.stringify(data)); } catch (_) {}
}

async function loadTasks() {
  const ctx = groceryContext();
  if (ctx && ctx.pantry && state.activeListId === ctx.pantry.id) return renderPantryLens(ctx);
  const el = $("lists-tasks");
  // v53: only show a loading state on first load / list switch — refreshes
  // render off-DOM and swap in atomically, so no clear-and-flash.
  // v58: on switch/relaunch, paint the cached copy instantly, then refresh.
  const switching = state._lastList !== state.activeListId;
  state._lastList = state.activeListId;
  const inventory = isInventoryList(state.activeListId);
  if (switching || !el.hasChildNodes()) {
    const cached = readListCache(state.activeListId);
    if (cached && cached.tasks) renderListData(el, { ...cached, inventory });
    else el.innerHTML = `<div class="empty" style="font-size:0.8rem;">Loading…</div>`;
  }
  try {
    const [tasks, sections, completed] = await Promise.all([
      todoistFetchAll("/tasks?project_id=" + state.activeListId),
      todoistFetchAll("/sections?project_id=" + state.activeListId).catch(() => []),
      inventory ? fetchCompletedItems(state.activeListId) : Promise.resolve([]),
      ensureCollaborators(state.activeListId),
    ]);
    const openIds = new Set(tasks.map(t => t.id));
    const doneItems = (completed || []).filter(c => c.id && !openIds.has(c.id));
    const data = { tasks, sections, doneItems, inventory };
    writeListCache(state.activeListId, { tasks, sections, doneItems });
    renderListData(el, data);
    if (inventory) buildProjectBar(); // v59: refresh needed-count badges
  } catch (e) {
    if (!el.querySelector(".task-row")) {
      el.innerHTML = `<div class="empty">Error: ${e.message}</div>`;
    } else {
      toast("Couldn't refresh — showing last loaded");
    }
  }
}

/* ---------- Pantry lens (v51) ---------- */
function renderPantryData(el, perStore) {
  el.classList.toggle("trip", tripOn()); // v59
  const frag = document.createDocumentFragment();
  const total = perStore.reduce((n, r) => n + r.open.length + r.done.length, 0);
  if (total === 0) {
    el.innerHTML = `<div class="empty">No items in the store lists yet.</div>`; return;
  }
  const badge = (name) => name.split(/\s+/).map(w => w[0]).join("").toUpperCase().slice(0, 2);
  const locOf = (t) => homeLocOf(t) || "Unsorted";
  currentLocs().concat(["Unsorted"]).forEach(loc => {
    const rows = [];
    perStore.forEach(({ store, open, done }) => {
      // v61: draggable — dropping into another group re-labels the item
      open.filter(t => locOf(t) === loc).forEach(t =>
        rows.push(buildTaskRow(t, false, { storeBadge: badge(store.name), loc })));
      done.filter(c => locOf(c) === loc).forEach(c =>
        rows.push(buildTaskRow(c, true, { storeBadge: badge(store.name), loc })));
    });
    if (!rows.length) return;
    const head = document.createElement("div");
    head.className = "list-section-head";
    head.dataset.loc = loc; // v61: drag-drop target
    head.textContent = loc;
    frag.appendChild(head);
    rows.forEach(r => frag.appendChild(r));
  });
  frag.appendChild(listEndMarker());
  el.replaceChildren(frag);
}

async function renderPantryLens(ctx) {
  const el = $("lists-tasks");
  el.classList.add("inventory"); // v56: readable checked items
  const switching = state._lastList !== state.activeListId;
  state._lastList = state.activeListId;
  if (switching || !el.hasChildNodes()) {
    const cached = readListCache(ctx.pantry.id);
    if (cached && cached.locs) state.pantryLocs = cached.locs; // v62
    if (cached && cached.perStore) renderPantryData(el, cached.perStore); // v58 instant paint
    else el.innerHTML = `<div class="empty" style="font-size:0.8rem;">Loading…</div>`;
  }
  try {
    await getPantryLocs(ctx); // v62: groups come from Pantry's sections
    const perStore = await Promise.all(ctx.stores.map(async (s) => {
      try {
        const [open, done] = await Promise.all([
          todoistFetchAll("/tasks?project_id=" + s.id),
          fetchCompletedItems(s.id),
        ]);
        const openIds = new Set(open.map(t => t.id));
        return { store: s, open, done: done.filter(c => c.id && !openIds.has(c.id)) };
      } catch (_) { return { store: s, open: [], done: [] }; }
    }));
    writeListCache(ctx.pantry.id, { perStore, locs: state.pantryLocs });
    renderPantryData(el, perStore);
  } catch (e) {
    if (!el.querySelector(".task-row")) {
      el.innerHTML = `<div class="empty">Error: ${e.message}</div>`;
    } else {
      toast("Couldn't refresh — showing last loaded");
    }
  }
}

// Collaborator names per shared project (cached). Used for assignee chips.
async function ensureCollaborators(projectId) {
  state.collabCache = state.collabCache || {};
  if (state.collabCache[projectId]) return state.collabCache[projectId];
  try {
    const data = await todoistFetch("/projects/" + projectId + "/collaborators");
    const list = Array.isArray(data) ? data : (data.results || data.items || data.collaborators || []);
    const map = {};
    (list || []).forEach(u => { map[u.id] = u.name || u.email || ""; });
    state.collabCache[projectId] = map;
  } catch (_) {
    state.collabCache[projectId] = {}; // personal project or endpoint unavailable — no chips
  }
  return state.collabCache[projectId];
}

const isP1 = (t) => t && (t.priority === 4 || t.priority === "p1");

/* v57: per-item quantity for grocery lists — stored as a trailing "qty: N"
   line in the task description (visible-but-harmless in Todoist's own app,
   machine-readable here). Absent = 1. */
const qtyOf = (t) => {
  const m = /(?:^|\n)qty:\s*(\d+)\s*$/im.exec((t && t.description) || "");
  return m ? Math.max(0, parseInt(m[1], 10)) : 1; // v59: 0 allowed = "not needed, keep on list"
};
async function saveQty(task, q) {
  const base = ((task.description) || "").replace(/(?:^|\n)qty:\s*\d+\s*$/gim, "").trim();
  const desc = q === 1 ? base : (base ? base + "\n" : "") + "qty: " + q;
  await todoistFetch("/tasks/" + task.id, "POST", { description: desc });
  task.description = desc;
}

/* v59: Trip mode — at the store, show only what you need: hides checked
   (stocked) items and qty-0 items, bumps touch targets. Persists across
   relaunch so a mid-shop suspension comes back in trip mode. */
// v62: trip mode toggles from the cart segment attached to the active pill
// (Spotify-style layered chip) — the in-list checkbox row is gone.
const tripOn = () => localStorage.getItem("hub.tripMode") === "1";

// v59: "N items" needed per store pill, computed from the list cache
function neededCount(pid) {
  const c = readListCache(pid);
  if (!c || !c.tasks) return null;
  return c.tasks.filter(t => qtyOf(t) >= 1).length;
}

// v55: recurring tasks "roll forward" on completion rather than finishing —
// they get a checked box but no strikethrough. Field shape varies by API
// surface, so check every known spelling.
const isRecurringTask = (t) => !!(t && (t.recurring === true ||
  t.isRecurring || t.is_recurring ||
  (t.due && (t.due.isRecurring || t.due.is_recurring))));

/* v53: swipe a row left to reveal Delete. Horizontal intent cancels the
   long-press drag; vertical scrolling is untouched. One row open at a time. */
const swipe = { openWrap: null, suppressClickUntil: 0 };

function closeOpenSwipe(except) {
  if (swipe.openWrap && swipe.openWrap !== except) {
    const w2 = swipe.openWrap;
    w2.classList.remove("swipe-open");
    const r = w2.querySelector(".task-row");
    if (r) { r.classList.add("snap"); r.style.transform = ""; }
    setTimeout(() => { if (!w2.classList.contains("swipe-open")) w2.classList.remove("swiping"); }, 280);
    swipe.openWrap = null;
  }
}

/* v57 fluidity: the row tracks the finger 1:1 (no transition while moving —
   the old always-on transition made it lag behind the finger, which was the
   "clunky" feel). Transitions only apply on release (.snap). A fast leftward
   flick deletes without reaching the distance threshold, like iOS Mail. The
   red layer + button only exist while a swipe is in progress, so resting
   cards have clean edges. */
function attachSwipe(wrap, row, onDelete) {
  let sx = 0, sy = 0, dx = 0, mode = null, startOpen = false, w = 320;
  let lastX = 0, lastT = 0, vel = 0;
  const threshold = () => Math.min(200, w * 0.5);
  row.addEventListener("touchstart", (e) => {
    if (e.target.closest(".qty-btn, .task-cb, button")) { mode = "v"; return; } // v61
    const t = e.touches[0];
    sx = t.clientX; sy = t.clientY; dx = 0; mode = null; vel = 0;
    lastX = t.clientX; lastT = e.timeStamp;
    w = row.offsetWidth || 320;
    startOpen = wrap.classList.contains("swipe-open");
    row.classList.remove("snap");
    closeOpenSwipe(wrap);
  }, { passive: true });
  row.addEventListener("touchmove", (e) => {
    if (drag.active) { mode = "v"; return; } // v61: never fight an active drag
    const t = e.touches[0];
    const mx = t.clientX - sx, my = t.clientY - sy;
    if (!mode) {
      if (Math.abs(mx) > 10 && Math.abs(mx) > Math.abs(my) * 1.5) {
        mode = "h"; cancelDragCandidate(); wrap.classList.add("swiping");
      } else if (Math.abs(my) > 10) mode = "v";
    }
    if (mode === "h") {
      const dt = e.timeStamp - lastT;
      if (dt > 0) vel = (t.clientX - lastX) / dt; // px/ms, negative = leftward
      lastX = t.clientX; lastT = e.timeStamp;
      dx = Math.min(0, Math.max(-w, mx + (startOpen ? -72 : 0)));
      row.style.transform = "translateX(" + dx + "px)";
      wrap.classList.toggle("swipe-armed", dx < -threshold());
    }
  }, { passive: true });
  row.addEventListener("touchend", () => {
    if (mode !== "h") return;
    swipe.suppressClickUntil = Date.now() + 350;
    wrap.classList.remove("swipe-armed");
    row.classList.add("snap");
    const flick = vel < -0.5 && dx < -60;
    if (dx < -threshold() || flick) {
      // Full swipe or flick: finish the motion and delete — no separate tap
      row.style.transform = "translateX(-110%)";
      wrap.classList.remove("swipe-open");
      if (swipe.openWrap === wrap) swipe.openWrap = null;
      setTimeout(onDelete, 140);
      return;
    }
    const open = dx < -40 && vel <= 0.05;
    wrap.classList.toggle("swipe-open", open);
    row.style.transform = open ? "translateX(-72px)" : "";
    if (!open) setTimeout(() => { if (!wrap.classList.contains("swipe-open")) wrap.classList.remove("swiping"); }, 280);
    swipe.openWrap = open ? wrap : (swipe.openWrap === wrap ? null : swipe.openWrap);
  });
}

function buildTaskRow(task, isDone, opts) {
  opts = opts || {};
  const row = document.createElement("div");
  row.className = "task-row" + (isDone ? " task-done" : "") + (isRecurringTask(task) ? " recurring" : "");
  row.id = "task-" + task.id;
  row.dataset.taskId = task.id;
  row.dataset.sectionId = task.sectionId || task.section_id || "";
  if (opts.loc !== undefined) row.dataset.loc = opts.loc; // v61: Pantry lens group
  // v62: checked items are draggable too on inventory lists (manual order)
  const draggable = !opts.noDrag && (!isDone || isInventoryList(state.activeListId));
  if (draggable) attachDrag(row, task);
  // v50: tap the card (not the checkbox) to edit title + home location.
  // v65: available on done rows too — inventory items stay visible once
  // checked, and there was previously no way to rename/relocate them once
  // ticked off. The whole left "checkbox gutter" (button + its surrounding
  // padding) is excluded by X-position, not just the button's own hit box,
  // so a tap that lands just beside the checkbox still toggles it instead
  // of opening edit.
  row.addEventListener("click", (e) => {
    if (e.target.closest(".task-cb")) return;
    if (e.clientX - row.getBoundingClientRect().left < 46) return;
    if (Date.now() < (drag.suppressClickUntil || 0)) return;
    if (Date.now() < (swipe.suppressClickUntil || 0)) return;
    openTaskEdit(task, row);
  });
  const cb = document.createElement("button");
  cb.className = "task-cb";
  cb.type = "button";
  cb.dataset.done = isDone ? "1" : "0";
  cb.setAttribute("aria-label", "Toggle complete");
  cb.innerHTML = isDone ? CHECK_DONE_SVG : CHECK_OPEN_SVG;
  cb.addEventListener("click", (e) => {
    e.stopPropagation();
    if (cb.dataset.done === "1") uncompleteTask(task.id);
    else completeTask(task.id, { kind: "list", data: { task, projectId: state.activeListId } });
  });
  const label = document.createElement("span");
  label.className = "task-label";
  label.textContent = task.content; // v62: 🔥 priority feature retired
  row.append(cb, label);
  // v57: − qty + stepper on inventory (grocery) lists
  if (isInventoryList(state.activeListId)) {
    row.classList.add("has-qty");
    const step = document.createElement("div");
    step.className = "qty-stepper";
    const minus = document.createElement("button");
    minus.type = "button"; minus.className = "qty-btn"; minus.textContent = "−";
    const num = document.createElement("span");
    num.className = "qty-num";
    const plus = document.createElement("button");
    plus.type = "button"; plus.className = "qty-btn"; plus.textContent = "+";
    let q = qtyOf(task);
    const renderQ = () => {
      num.textContent = q;
      step.classList.toggle("qty-one", q === 1);
      row.classList.toggle("qty-zero", q === 0); // hidden in trip mode
    };
    renderQ();
    let saveTimer = null;
    const change = (d) => {
      q = Math.max(0, q + d);
      renderQ();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        try { await saveQty(task, q); }
        catch (_) { toast("Couldn't save quantity — try again"); }
      }, 600);
    };
    minus.addEventListener("click", (e) => { e.stopPropagation(); change(-1); });
    plus.addEventListener("click", (e) => { e.stopPropagation(); change(1); });
    step.append(minus, num, plus);
    row.appendChild(step);
  }
  // Store badge (Pantry lens, v51) — which store this item is bought at
  if (opts.storeBadge) {
    const sb = document.createElement("span");
    sb.className = "store-badge";
    sb.textContent = opts.storeBadge;
    row.appendChild(sb);
  }
  // Assignee chip (shared projects) — first initial of the responsible user
  const uid = task.responsibleUid || task.responsible_uid || null;
  const collab = (state.collabCache || {})[state.activeListId] || {};
  if (uid && collab[uid]) {
    const chip = document.createElement("span");
    chip.className = "assignee-chip";
    chip.textContent = collab[uid].trim().charAt(0).toUpperCase();
    chip.title = collab[uid];
    row.appendChild(chip);
  }
  // v53: swipe-to-delete wrapper; v55: full swipe deletes in one motion
  const wrap = document.createElement("div");
  wrap.className = "swipe-wrap";
  const doDelete = async () => {
    closeOpenSwipe(null);
    wrap.style.transition = "opacity 0.15s";
    wrap.style.opacity = "0";
    setTimeout(() => wrap.remove(), 150);
    try {
      await todoistFetch("/tasks/" + task.id, "DELETE");
      toast("Deleted");
    } catch (_) {
      toast("Couldn't delete — refreshing");
      loadTasks();
    }
  };
  const del = document.createElement("button");
  del.className = "swipe-del";
  del.type = "button";
  del.textContent = "Delete";
  del.addEventListener("click", (e) => { e.stopPropagation(); doDelete(); });
  wrap.append(del, row);
  attachSwipe(wrap, row, doDelete);
  return wrap;
}

// A dragged/queried .task-row lives inside its swipe wrapper — DOM moves and
// removals must operate on the wrapper.
const wrapOf = (el) => (el && el.parentNode && el.parentNode.classList &&
  el.parentNode.classList.contains("swipe-wrap")) ? el.parentNode : el;

/* ---------- item edit sheet (v50) ---------- */
// v62: home locations are DYNAMIC — the Pantry project's sections define the
// groups (Michael manages them in Todoist), with matching labels on items.
// HOME_LOCS is only the cold-start fallback.
const HOME_LOCS = ["Cupboard", "Fridge", "Freezer"];
const currentLocs = () => state.pantryLocs || HOME_LOCS;
async function getPantryLocs(ctx) {
  if (state.pantryLocs) return state.pantryLocs;
  try {
    const secs = await todoistFetchAll("/sections?project_id=" + ctx.pantry.id);
    const ord = (s) => s.sectionOrder ?? s.section_order ?? s.order ?? 0;
    const names = secs.slice().sort((a, b) => ord(a) - ord(b)).map(s => s.name);
    state.pantryLocs = names.length ? names : HOME_LOCS.slice();
  } catch (_) { state.pantryLocs = HOME_LOCS.slice(); }
  return state.pantryLocs;
}
const homeLocOf = (task) => {
  const locs = currentLocs();
  const m = (task.labels || []).find(l => locs.some(n => n.toLowerCase() === String(l).toLowerCase()));
  return m ? locs.find(n => n.toLowerCase() === String(m).toLowerCase()) : "";
};

function openTaskEdit(task) {
  const old = $("task-edit");
  if (old) old.remove();
  const modal = document.createElement("div");
  modal.className = "modal"; modal.id = "task-edit";
  const card = document.createElement("div");
  card.className = "modal-card";
  card.innerHTML = `
    <div class="modal-head"><strong>Edit item</strong><button class="btn-icon" id="te-close">✕</button></div>
    <input id="te-title" class="settings-token-input" type="text" autocomplete="off">
    <div class="settings-section-label" style="margin-top:16px">Home location</div>
    <div class="te-locs" id="te-locs"></div>
    <div class="settings-token-actions" style="margin-top:16px"><button id="te-save" class="settings-btn-primary">Save</button></div>`;
  modal.appendChild(card);
  document.body.appendChild(modal);
  lockBodyScroll();
  $("te-title").value = task.content;
  let chosen = homeLocOf(task);
  const locsEl = $("te-locs");
  const renderLocs = () => {
    locsEl.innerHTML = "";
    currentLocs().forEach(n => {
      const b = document.createElement("button");
      b.className = "cap-pick-btn" + (chosen === n ? " te-active" : "");
      b.textContent = n;
      b.onclick = () => { chosen = (chosen === n) ? "" : n; renderLocs(); };
      locsEl.appendChild(b);
    });
  };
  renderLocs();
  const close = () => { modal.remove(); unlockBodyScroll(); };
  $("te-close").onclick = close;
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  $("te-save").onclick = async () => {
    const newTitle = $("te-title").value.trim() || task.content;
    const others = (task.labels || []).filter(l => !currentLocs().some(n => n.toLowerCase() === String(l).toLowerCase()));
    const labels = chosen ? others.concat([chosen]) : others;
    close();
    try {
      await todoistFetch("/tasks/" + task.id, "POST", { content: newTitle, labels });
      task.content = newTitle; task.labels = labels;
      toast("Saved");
      loadTasks();
    } catch (_) {
      toast("Couldn't save — try again");
    }
  };
}

/* ---------- section rename (v50) ---------- */
function beginSectionRename(head, s) {
  if (head.querySelector("input")) return;
  const old = s.name;
  head.textContent = "";
  const input = document.createElement("input");
  input.className = "sec-rename-input";
  input.value = old;
  head.appendChild(input);
  input.focus(); input.select();
  let committed = false;
  const commit = async () => {
    if (committed) return; committed = true;
    const val = input.value.trim();
    setSectionHeadContent(head, val || old);
    if (!val || val === old) return;
    try {
      await todoistFetch("/sections/" + s.id, "POST", { name: val });
      s.name = val;
      toast("Section renamed");
    } catch (_) {
      setSectionHeadContent(head, old);
      toast("Couldn't rename — try again");
    }
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } });
}

// v65: collapse-and-remove a checked-off row's wrapper instead of the CSS
// rule snapping it away instantly (see the trip-mode "leaving" rule in
// styles.css). Also fixes the flex-gap-around-a-hidden-child bug at its
// root, since the wrapper is genuinely removed from the DOM once this runs.
function startLeaveAnimation(wrap) {
  if (!wrap || !wrap.isConnected || wrap.classList.contains("leaving")) return;
  wrap.style.maxHeight = wrap.getBoundingClientRect().height + "px";
  requestAnimationFrame(() => {
    wrap.classList.add("leaving");
    wrap.style.maxHeight = "0px";
  });
  setTimeout(() => { if (wrap.isConnected) wrap.remove(); }, 340);
}

async function completeTask(id, ctx) {
  const row = $("task-" + id);
  // Immediately show completed state — checkbox stays clickable so it can be undone
  if (row) {
    row.classList.add("task-done");
    const cb = row.querySelector(".task-cb");
    if (cb) { cb.innerHTML = CHECK_DONE_SVG; cb.dataset.done = "1"; }
  }
  // Remember it briefly so it survives the next re-render instead of vanishing
  if (ctx) state.completedRecently.set(id, { ...ctx, expiresAt: Date.now() + 120000 });
  // v65: in trip mode, give a beat before the row actually leaves — protects
  // against an accidental checkbox tap mid-aisle and reads less abrupt than
  // an instant disappearance. .pending-hide keeps the CSS auto-hide rule
  // from snapping it away before the grace period is up.
  const wrap = row ? wrapOf(row) : null;
  if (wrap && ctx && ctx.kind === "list" && tripOn() && isInventoryList(ctx.data.projectId)) {
    clearTimeout(wrap._tripHideTimer);
    wrap.classList.add("pending-hide");
    wrap._tripHideTimer = setTimeout(() => {
      wrap.classList.remove("pending-hide");
      startLeaveAnimation(wrap);
    }, 2200);
  }
  try {
    await todoistFetch("/tasks/" + id + "/close", "POST");
  } catch (e) {
    toast("Couldn't complete — try again");
    if (wrap) { clearTimeout(wrap._tripHideTimer); wrap.classList.remove("pending-hide"); }
    if (row) {
      row.classList.remove("task-done");
      const cb = row.querySelector(".task-cb");
      if (cb) { cb.innerHTML = CHECK_OPEN_SVG; cb.dataset.done = "0"; }
    }
    state.completedRecently.delete(id);
  }
}

async function uncompleteTask(id) {
  const row = $("task-" + id);
  const wrap = row ? wrapOf(row) : null;
  // v65: undoing within the grace period cancels the pending trip-mode hide
  if (wrap) {
    clearTimeout(wrap._tripHideTimer);
    wrap.classList.remove("pending-hide");
    if (wrap.classList.contains("leaving")) { wrap.classList.remove("leaving"); wrap.style.maxHeight = ""; }
  }
  if (row) {
    row.classList.remove("task-done");
    const cb = row.querySelector(".task-cb");
    if (cb) { cb.innerHTML = CHECK_OPEN_SVG; cb.dataset.done = "0"; }
  }
  state.completedRecently.delete(id);
  try {
    await todoistFetch("/tasks/" + id + "/reopen", "POST");
  } catch (e) {
    toast("Couldn't undo — try again");
    if (row) {
      row.classList.add("task-done");
      const cb = row.querySelector(".task-cb");
      if (cb) { cb.innerHTML = CHECK_DONE_SVG; cb.dataset.done = "1"; }
    }
  }
}

/* ---------- drag to reorder / move (Lists tab, v49) ----------
   Long-press (320ms) a task row to lift it, then:
   - drop between rows        → reorder (persisted via sync item_reorder)
   - drop on a section header → move to top of that section
   - drop on a project pill   → move the task to that project
   Movement >8px before the timer fires is treated as a scroll, not a drag. */
const drag = {
  timer: null, row: null, task: null, active: false, ghost: null,
  startX: 0, startY: 0, lastX: 0, lastY: 0, offsetY: 0,
  overRow: null, overHead: null, overPill: null, after: false, raf: null,
};

function attachDrag(row, task) {
  row.addEventListener("touchstart", (e) => {
    if (e.target.closest(".task-cb, .qty-btn, button")) return; // v61
    const t = e.touches[0];
    startDragCandidate(row, task, t.clientX, t.clientY);
  }, { passive: true });
  row.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.target.closest(".task-cb, .qty-btn, button")) return;
    startDragCandidate(row, task, e.clientX, e.clientY);
  });
}

function startDragCandidate(row, task, x, y) {
  cancelDragCandidate();
  drag.row = row; drag.task = task; drag.startX = x; drag.startY = y;
  drag.timer = setTimeout(beginDrag, 280); // v61: slightly quicker to arm
}

function cancelDragCandidate() {
  if (drag.timer) clearTimeout(drag.timer);
  drag.timer = null;
  if (!drag.active) { drag.row = null; drag.task = null; }
}

function beginDrag() {
  drag.timer = null;
  const row = drag.row;
  if (!row || !row.isConnected) return;
  const rect = row.getBoundingClientRect();
  drag.offsetY = drag.startY - rect.top;
  const ghost = row.cloneNode(true);
  ghost.className = row.className + " drag-ghost";
  ghost.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;z-index:60;pointer-events:none;margin:0;`;
  document.body.appendChild(ghost);
  drag.ghost = ghost;
  row.classList.add("drag-src");
  drag.active = true;
  drag.lastX = drag.startX; drag.lastY = drag.startY;
  if (navigator.vibrate) navigator.vibrate(10);
  drag.raf = requestAnimationFrame(dragAutoScroll);
}

function dragMove(x, y) {
  drag.lastX = x; drag.lastY = y;
  drag.ghost.style.top = (y - drag.offsetY) + "px";
  clearDropMarks();
  const el = document.elementFromPoint(x, y);
  if (!el) return;
  const pill = el.closest(".lists-project-btn");
  if (pill && pill.dataset.pid && pill.dataset.pid !== String(state.activeListId)) {
    pill.classList.add("drop-target");
    drag.overPill = pill;
    return;
  }
  const row2 = el.closest(".task-row");
  if (row2 && row2 !== drag.row && row2.dataset.taskId) {
    const r = row2.getBoundingClientRect();
    drag.after = y > r.top + r.height / 2;
    row2.classList.add(drag.after ? "drop-after" : "drop-before");
    drag.overRow = row2;
    return;
  }
  const head = el.closest(".list-section-head");
  if (head && (head.dataset.sectionId || head.dataset.loc !== undefined)) {
    head.classList.add("drop-after");
    drag.overHead = head;
  }
}

function clearDropMarks() {
  if (drag.overRow) drag.overRow.classList.remove("drop-before", "drop-after");
  if (drag.overHead) drag.overHead.classList.remove("drop-after");
  if (drag.overPill) drag.overPill.classList.remove("drop-target");
  drag.overRow = drag.overHead = drag.overPill = null;
}

function dragAutoScroll() {
  if (!drag.active) return;
  const y = drag.lastY, vh = window.innerHeight;
  if (y < 110) { window.scrollBy(0, -10); dragMove(drag.lastX, drag.lastY); }
  else if (y > vh - 150) { window.scrollBy(0, 10); dragMove(drag.lastX, drag.lastY); }
  drag.raf = requestAnimationFrame(dragAutoScroll);
}

async function finishDrag() {
  cancelAnimationFrame(drag.raf);
  const row = drag.row, task = drag.task;
  const pill = drag.overPill, tRow = drag.overRow, head = drag.overHead, after = drag.after;
  if (drag.ghost) drag.ghost.remove();
  if (row) row.classList.remove("drag-src");
  clearDropMarks();
  drag.active = false; drag.row = null; drag.task = null; drag.ghost = null;
  if (!row || !task) return;
  try {
    if (pill) {
      const pid = pill.dataset.pid, name = pill.textContent;
      wrapOf(row).remove();
      await moveTask(task.id, { project_id: pid });
      // v54: inventory lists are timeless — arriving items lose their date
      // (quick-adds default to "today"; without this they'd rot as Overdue).
      if (isInventoryList(pid) && (task.due || task.dueDate || task.due_date || task.dueDatetime || task.due_datetime)) {
        try { await todoistFetch("/tasks/" + task.id, "POST", { dueString: "no date", due_string: "no date" }); } catch (_) {}
      }
      toast("Moved to " + name);
      return;
    }
    if (tRow || head) {
      const target = tRow || head;
      // v61: Pantry lens — groups are home-location labels, so a drop there
      // means "this lives in the Fridge now," not a section move.
      if (target.dataset.loc !== undefined || row.dataset.loc !== undefined) {
        if (tRow) { const tw = wrapOf(tRow); tw.parentNode.insertBefore(wrapOf(row), after ? tw.nextSibling : tw); }
        else head.parentNode.insertBefore(wrapOf(row), head.nextSibling);
        const newLoc = target.dataset.loc || "Unsorted";
        const oldLoc = row.dataset.loc || "Unsorted";
        row.dataset.loc = newLoc;
        if (newLoc !== oldLoc) {
          const others = (task.labels || []).filter(l => !currentLocs().some(n => n.toLowerCase() === String(l).toLowerCase()));
          const labels = (newLoc === "Unsorted") ? others : others.concat([newLoc]);
          await todoistFetch("/tasks/" + task.id, "POST", { labels });
          task.labels = labels;
          toast(newLoc === "Unsorted" ? "Marked unsorted" : "Moved to " + newLoc);
        }
        return;
      }
      const newSec = target.dataset.sectionId || "";
      const oldSec = row.dataset.sectionId || "";
      // v53: rows live inside swipe wrappers — move the wrapper
      if (tRow) { const tw = wrapOf(tRow); tw.parentNode.insertBefore(wrapOf(row), after ? tw.nextSibling : tw); }
      else head.parentNode.insertBefore(wrapOf(row), head.nextSibling);
      row.dataset.sectionId = newSec;
      if (newSec !== oldSec) {
        await moveTask(task.id, newSec ? { section_id: newSec } : { project_id: state.activeListId });
      }
      await persistReorder(newSec);
    }
  } catch (e) {
    toast("Couldn't move — try again");
    loadTasks();
  }
}

function wireDrag() {
  document.addEventListener("touchmove", (e) => {
    if (drag.active || sdrag.active) {
      e.preventDefault(); // blocks page scroll while a card is lifted
      const t = e.touches[0];
      if (drag.active) dragMove(t.clientX, t.clientY);
      else sdragMove(t.clientX, t.clientY);
    } else if (drag.timer) {
      const t = e.touches[0];
      // v61: 14px tolerance — natural finger tremor was cancelling the
      // long-press before it could arm, making drag feel broken.
      if (Math.abs(t.clientX - drag.startX) > 14 || Math.abs(t.clientY - drag.startY) > 14) cancelDragCandidate();
    } else if (sdrag.timer) {
      const t = e.touches[0];
      if (Math.abs(t.clientX - sdrag.startX) > 14 || Math.abs(t.clientY - sdrag.startY) > 14) cancelSettingsDrag();
    }
  }, { passive: false });
  document.addEventListener("mousemove", (e) => {
    if (drag.active) dragMove(e.clientX, e.clientY);
    else if (sdrag.active) sdragMove(e.clientX, e.clientY);
    else if (drag.timer && (Math.abs(e.clientX - drag.startX) > 14 || Math.abs(e.clientY - drag.startY) > 14)) cancelDragCandidate();
    else if (sdrag.timer && (Math.abs(e.clientX - sdrag.startX) > 14 || Math.abs(e.clientY - sdrag.startY) > 14)) cancelSettingsDrag();
  });
  const up = () => {
    if (drag.active) finishDrag(); else cancelDragCandidate();
    if (sdrag.active) finishSettingsDrag(); else cancelSettingsDrag();
  };
  document.addEventListener("touchend", up);
  document.addEventListener("touchcancel", up);
  document.addEventListener("mouseup", up);
}

/* ---------- Settings drag (v52) ----------
   Same long-press gesture as task cards, applied to the top-level project
   rows in Settings > Lists. Children travel with their parent (the order
   model is unchanged — only top-level order is stored). */
const sdrag = { timer: null, row: null, pid: null, active: false, ghost: null,
  startX: 0, startY: 0, lastY: 0, offsetY: 0, overRow: null, after: false };

function attachSettingsDrag(row, pid) {
  row.addEventListener("touchstart", (e) => {
    if (e.target.tagName === "INPUT" || e.target.closest("button")) return;
    const t = e.touches[0];
    sdragCandidate(row, pid, t.clientX, t.clientY);
  }, { passive: true });
  row.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.target.tagName === "INPUT" || e.target.closest("button")) return;
    sdragCandidate(row, pid, e.clientX, e.clientY);
  });
}

function sdragCandidate(row, pid, x, y) {
  cancelSettingsDrag();
  sdrag.row = row; sdrag.pid = pid; sdrag.startX = x; sdrag.startY = y;
  sdrag.timer = setTimeout(beginSettingsDrag, 320);
}

function cancelSettingsDrag() {
  if (sdrag.timer) clearTimeout(sdrag.timer);
  sdrag.timer = null;
  if (!sdrag.active) { sdrag.row = null; sdrag.pid = null; }
}

function beginSettingsDrag() {
  sdrag.timer = null;
  const row = sdrag.row;
  if (!row || !row.isConnected) return;
  const rect = row.getBoundingClientRect();
  sdrag.offsetY = sdrag.startY - rect.top;
  const ghost = row.cloneNode(true);
  ghost.className = row.className + " drag-ghost";
  ghost.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;z-index:60;pointer-events:none;margin:0;background:var(--card);border-radius:10px;`;
  document.body.appendChild(ghost);
  sdrag.ghost = ghost;
  row.classList.add("drag-src");
  sdrag.active = true;
  sdrag.lastY = sdrag.startY;
  if (navigator.vibrate) navigator.vibrate(10);
}

function sdragMove(x, y) {
  sdrag.lastY = y;
  sdrag.ghost.style.top = (y - sdrag.offsetY) + "px";
  if (sdrag.overRow) sdrag.overRow.classList.remove("drop-before", "drop-after");
  sdrag.overRow = null;
  // Auto-scroll the settings modal card
  const card = document.querySelector("#settings .modal-card");
  if (card) {
    const r = card.getBoundingClientRect();
    if (y < r.top + 60) card.scrollTop -= 10;
    else if (y > r.bottom - 60) card.scrollTop += 10;
  }
  const el = document.elementFromPoint(x, y);
  if (!el) return;
  const row2 = el.closest(".proj-sort-row");
  if (row2 && row2 !== sdrag.row && row2.dataset.top === "1") {
    const r = row2.getBoundingClientRect();
    sdrag.after = y > r.top + r.height / 2;
    row2.classList.add(sdrag.after ? "drop-after" : "drop-before");
    sdrag.overRow = row2;
  }
}

function finishSettingsDrag() {
  const { row, pid, overRow, after } = sdrag;
  if (sdrag.ghost) sdrag.ghost.remove();
  if (row) row.classList.remove("drag-src");
  if (overRow) overRow.classList.remove("drop-before", "drop-after");
  sdrag.active = false; sdrag.row = null; sdrag.pid = null; sdrag.ghost = null; sdrag.overRow = null;
  if (!overRow || !pid) return;
  const targetPid = overRow.dataset.id;
  if (targetPid === pid) return;
  const arr = state.todoistProjects;
  const from = arr.findIndex(p => p.id === pid);
  if (from < 0) return;
  const [moved] = arr.splice(from, 1);
  let to = arr.findIndex(p => p.id === targetPid);
  if (to < 0) { arr.splice(from, 0, moved); return; }
  arr.splice(to + (after ? 1 : 0), 0, moved);
  localStorage.setItem("hub.projectOrder", JSON.stringify(arr.map(p => p.id)));
  saveSettingsToDrive();
  buildProjectBar();
  if (state._renderProjRows) state._renderProjRows();
}

// Move a task to another project/section. Tries the v1 move endpoint first,
// falls back to a sync item_move command.
async function moveTask(id, dest) {
  const body = { ...dest };
  if (dest.project_id) body.projectId = dest.project_id; // both casings, v44 lesson
  if (dest.section_id) body.sectionId = dest.section_id;
  try {
    await todoistFetch("/tasks/" + id + "/move", "POST", body);
  } catch (_) {
    await todoistSync([{ type: "item_move", args: { id, ...dest } }]);
  }
}

async function todoistSync(commands) {
  const cmds = commands.map(c => ({
    uuid: (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : "u" + Math.random().toString(36).slice(2),
    ...c,
  }));
  await todoistFetch("/sync", "POST", { commands: cmds });
}

// Persist the DOM order of a section's rows as child_order. Best-effort:
// if the sync call fails the optimistic order survives until next load.
async function persistReorder(sectionId) {
  const items = [...$("lists-tasks").querySelectorAll(".task-row")]
    .filter(r => (r.dataset.sectionId || "") === (sectionId || "") && r.dataset.taskId)
    .map((r, i) => ({ id: r.dataset.taskId, child_order: i + 1 }));
  if (items.length < 2) return;
  try { await todoistSync([{ type: "item_reorder", args: { items } }]); }
  catch (e) { console.warn("reorder not persisted", e); }
}

async function addTodoistTask(content, projectId, due) {
  const body = { content };
  // The account's Todoist API (v1, unified) reads/returns camelCase field
  // names (confirmed via projectId/dueDate/inboxProject in GET responses),
  // but this was still POSTing snake_case-only keys (project_id, due_date...).
  // Those got silently ignored, so quick-added tasks landed in Inbox with NO
  // due date at all — which is why they never matched the Today tab's
  // "filter=today" query even though the task itself existed (visible only
  // in Todoist directly / a plain project list, never in the Today view).
  // Sending both casings is a harmless, version-proof fix.
  if (projectId) { body.projectId = projectId; body.project_id = projectId; }
  if (due) {
    // v63: send due_date whenever we know it, even alongside due_datetime.
    // Without it, Todoist can derive due.date from due_datetime's UTC day,
    // which rolls to tomorrow for any evening Pacific time (7pm PT = 2am
    // UTC) — the task then silently never matches the Today filter.
    if (due.date) { body.dueDate = due.date; body.due_date = due.date; }
    if (due.datetime) { body.dueDatetime = due.datetime; body.due_datetime = due.datetime; }
    else if (due.string) { body.dueString = due.string; body.due_string = due.string; }
  }
  await todoistFetch("/tasks", "POST", body);
}

async function createTodoistProject(name) {
  await todoistFetch("/projects", "POST", { name });
}

// v47: Todoist's server-side quick-add parser — understands natural language
// dates ("tue 3pm", "every saturday 9am"), priorities ("p1"), and #project
// routing, exactly like typing in Todoist's own add bar. Used for Task
// captures when no date chip is set; falls back to the plain endpoint.
async function quickAddTask(text) {
  await todoistFetch("/tasks/quick", "POST", { text, meta: false });
}

/* Project hierarchy — v45.
   Subprojects (Margot, Sadie, Finance, 312 Rheem's children…) used to be
   invisible: both the Lists tab and the Today view's visibility check only
   looked at top-level (!parentId) projects, so any task inside a nested
   project silently vanished from Today. ingestProjects() keeps the top-level
   ordering model (Settings reorder applies to parents; children travel with
   them) and records the parent→children map; allProjectsFlat() walks it
   depth-first so every consumer sees the full tree. */
function ingestProjects(allProj) {
  const inbox = allProj.find(p => p.inboxProject || p.inbox_project);
  if (inbox) state.todoistInboxId = inbox.id;
  const nonInbox = allProj.filter(p => !(p.inboxProject || p.inbox_project));
  const ord = (p) => p.childOrder ?? p.child_order ?? 0;
  const byParent = {};
  nonInbox.forEach(p => {
    const par = p.parentId || p.parent_id || null;
    if (par) (byParent[par] = byParent[par] || []).push(p);
  });
  Object.values(byParent).forEach(arr => arr.sort((a, b) => ord(a) - ord(b)));
  let tops = nonInbox.filter(p => !(p.parentId || p.parent_id));
  const savedOrder = JSON.parse(localStorage.getItem("hub.projectOrder") || "null");
  if (savedOrder) {
    const idMap = Object.fromEntries(tops.map(p => [p.id, p]));
    tops = savedOrder.map(id => idMap[id]).filter(Boolean)
      .concat(tops.filter(p => !savedOrder.includes(p.id)));
  }
  state.todoistProjects = tops;
  state.todoistByParent = byParent;
}
function allProjectsFlat() {
  const out = [];
  const walk = (p, depth) => {
    p._depth = depth;
    out.push(p);
    ((state.todoistByParent || {})[p.id] || []).forEach(c => walk(c, depth + 1));
  };
  (state.todoistProjects || []).forEach(p => walk(p, 0));
  return out;
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
  // v59: tap an event to open it in Google Calendar for editing
  if (ev.htmlLink) {
    row.classList.add("linked");
    row.addEventListener("click", () => window.open(ev.htmlLink, "_blank"));
  }
  return row;
}
function visible(events) {
  return events.filter((x) => calOn(x.cal) && (x.ev.summary || "").trim() !== CONFIG.BRIEF_TITLE);
}
async function fetchTasksByFilter(filter) {
  if (!getTodoistToken()) return [];
  try {
    // Ensure projects (and the Inbox id) are loaded so we can filter by visibility
    if (!state.todoistProjects || state.todoistProjects.length === 0 || state.todoistInboxId == null) {
      ingestProjects(await todoistFetchAll("/projects"));
    }
    // v45: visibility now covers nested projects too (allProjectsFlat), so a
    // task due today inside Margot/Finance/312 Rheem's children shows up.
    const off = getProjectsOff();
    const visibleIds = new Set(allProjectsFlat().filter(p => !off.has(p.id)).map(p => p.id));
    // Quick-added tasks (Today/Week FAB) have no project and land in Inbox —
    // Inbox has no visibility toggle in Settings, so always treat it as shown.
    if (state.todoistInboxId) visibleIds.add(state.todoistInboxId);
    // v54: inventory lists (grocery family + any ♻︎-flagged list) are
    // timeless — their items never belong in Today or Overdue, even if a
    // date sneaks onto one.
    for (const id of [...visibleIds]) {
      if (isInventoryList(id)) visibleIds.delete(id);
    }
    // v59 ROOT-CAUSE FIX for phantom Today/Overdue items: the plain /tasks
    // endpoint silently IGNORES an unknown ?filter= param — once pagination
    // (v51) fetched every page, "filter=today" was returning the entire
    // account. Use the dedicated filter endpoint, and apply the date
    // predicate locally regardless, so a misbehaving endpoint can never
    // leak undated/old tasks into the timeline again.
    let tasks;
    try {
      tasks = await todoistFetchAll("/tasks/filter?query=" + encodeURIComponent(filter));
    } catch (_) {
      tasks = await todoistFetchAll("/tasks");
    }
    const today = todayISO();
    const dayOf = (t) => {
      const d = t.dueDate || t.due_date || (t.due && (t.due.date || t.due.datetime)) || null;
      return d ? String(d).slice(0, 10) : null;
    };
    tasks = (tasks || []).filter(t => {
      const day = dayOf(t);
      if (!day) return false;
      return filter === "today" ? day === today : day < today;
    });
    return tasks.filter(t => visibleIds.has(t.projectId || t.project_id));
  } catch (e) { return []; }
}

function parseItemTime(isoStr) {
  // Returns a Date or null
  if (!isoStr) return null;
  // Handles both "2026-06-13T14:00:00" and "2026-06-13T14:00:00Z"
  return new Date(isoStr);
}

async function renderToday() {
  const today = todayISO();
  const now = new Date();
  $("hdr-date").textContent = fmt(now, { weekday: "long", month: "long", day: "numeric" });

  const [calEvents, tasks, overdueTasks] = await Promise.all([
    fetchRange(today, 2),
    fetchTasksByFilter("today"),
    fetchTasksByFilter("overdue"),
  ]);

  // Find brief (passed to buildTimeline for Tomorrow section)
  const briefEv = calEvents.find(({ ev, cal }) =>
    calOn(cal) && (ev.summary || "").trim() === CONFIG.BRIEF_TITLE && evDate(ev) === today);
  const briefText = briefEv?.ev?.description || null;

  // Build unified item list for TODAY
  const items = [];

  // Calendar events — today only, not the brief
  visible(calEvents).forEach(({ ev, cal }) => {
    if (evDate(ev) !== today) return;
    if ((ev.summary || "").trim() === CONFIG.BRIEF_TITLE) return;
    const isAllDay = !ev.start.dateTime;
    const time = isAllDay ? null : parseItemTime(ev.start.dateTime);
    const endTime = isAllDay ? null : parseItemTime(ev.end?.dateTime);
    ev._cal = cal; // attach for timelineRow
    items.push({ type: "event", title: ev.summary || "(no title)", time, endTime, allDay: isAllDay, id: ev.id, ev });
  });

  // Todoist tasks due today
  tasks.forEach(t => {
    // dueDateTime for timed tasks, dueDate for untimed
    const dt = t.dueDatetime || t.due_datetime || t.dueDateTime || null;
    const time = dt ? parseItemTime(dt) : null;
    items.push({ type: "task", title: t.content, time, allDay: !dt, id: t.id, task: t });
  });

  // Merge in tasks completed moments ago — Todoist's "today" filter no longer
  // returns them, but we keep showing them (dimmed/struck) briefly so the
  // checkmark tap doesn't look like it silently failed.
  pruneCompletedRecently();
  state.completedRecently.forEach((entry, id) => {
    if (entry.kind === "today" && !items.find(i => i.id === id)) {
      items.push({ ...entry.data.item, isDone: true });
    }
  });

  // Sort: timed items by time, untimed/all-day at end
  items.sort((a, b) => {
    if (!a.time && !b.time) return 0;
    if (!a.time) return 1;
    if (!b.time) return -1;
    return a.time - b.time;
  });

  // Overdue tasks (v45) — dated before today, shown at the very top so they
  // can't rot invisibly. Completing one works exactly like a today task.
  pruneCompletedRecently();
  const overdueItems = overdueTasks.map(t => {
    const d = t.dueDate || t.due_date || (t.due && (t.due.date || t.due.datetime)) || "";
    return { type: "task", title: t.content, time: null, allDay: true, id: t.id, task: t,
      overdueDate: String(d).slice(0, 10) };
  });
  state.completedRecently.forEach((entry, id) => {
    if (entry.kind === "overdue" && !overdueItems.find(i => i.id === id)) {
      overdueItems.push({ ...entry.data.item, isDone: true });
    }
  });

  // Tomorrow events (for collapsed section)
  const tmrItems = visible(calEvents).filter(({ ev }) => evDate(ev) === isoPlus(today, 1));

  buildTimeline(items, tmrItems, now, briefText, overdueItems);
}

function buildTimeline(items, tmrItems, now, briefText, overdueItems) {
  const el = $("today-timeline");
  el.innerHTML = "";

  // Overdue drawer (v54): collapsed by default, count in the header,
  // remembers your last open/closed choice.
  if (overdueItems && overdueItems.length > 0) {
    const openPref = localStorage.getItem("hub.overdueOpen") === "1";
    const oToggle = document.createElement("div");
    oToggle.className = "tmr-toggle overdue-toggle";
    oToggle.innerHTML = `<span class="ov-title">Overdue</span>` +
      `<span class="tmr-count">${overdueItems.length} item${overdueItems.length !== 1 ? "s" : ""}</span>` +
      `<span class="tmr-chevron">${openPref ? "⌄" : "›"}</span>`;
    const oBody = document.createElement("div");
    oBody.className = "tmr-body";
    oBody.hidden = !openPref;
    overdueItems.forEach(item => oBody.appendChild(timelineRow(item, false)));
    oToggle.addEventListener("click", () => {
      const open = !oBody.hidden;
      oBody.hidden = open;
      localStorage.setItem("hub.overdueOpen", open ? "0" : "1");
      oToggle.querySelector(".tmr-chevron").textContent = open ? "›" : "⌄";
    });
    el.appendChild(oToggle);
    el.appendChild(oBody);
  }

  // Meal card (v59) — the family dinner cadence, glanceable at the top.
  // Mon salmon / Tue chicken / Wed pasta / Thu turkey / Fri pizza-or-sushi;
  // weekends ad hoc (no card). TODO: fold in Erika's prepped meals once
  // that rhythm settles.
  const MEALS = { Monday: "Salmon", Tuesday: "Chicken", Wednesday: "Pasta",
    Thursday: "Turkey", Friday: "Pizza or sushi" };
  const todayMeal = MEALS[fmt(now, { weekday: "long" })];
  if (todayMeal) {
    // v62: event-row structure so the meal text aligns with card titles below
    const mc = document.createElement("div");
    mc.className = "event meal-card";
    mc.innerHTML = `<span class="cb-spacer"></span><div class="time allday">🍽</div>` +
      `<div class="what"><div class="title"><span class="meal-label">Tonight</span>${todayMeal}</div></div>`;
    el.appendChild(mc);
  }

  const timed = items.filter(i => i.time);
  const untimed = items.filter(i => !i.time);
  const nowMs = now.getTime();

  // Find split point: first item in future
  const firstFutureIdx = timed.findIndex(i => i.time > now);
  const hasPast = firstFutureIdx > 0 || (firstFutureIdx === -1 && timed.length > 0);
  const allPast = firstFutureIdx === -1 && timed.length > 0;

  // Render timed items
  let nowMarker = null;
  timed.forEach((item, i) => {
    const isFuture = item.time > now;
    // v59: an event that has started but not ended is ACTIVE, not past —
    // no dimming, accent edge, "· now" in the time column.
    const ongoing = !isFuture && item.endTime && item.endTime > now;

    // Insert now marker before first future item
    if (isFuture && (i === 0 || timed[i - 1].time <= now)) {
      nowMarker = document.createElement("div");
      nowMarker.className = "now-marker";
      nowMarker.id = "now-marker";
      nowMarker.innerHTML = `<span class="now-dot"></span><span class="now-label">Now</span><div class="now-line"></div>`;
      el.appendChild(nowMarker);
    }

    el.appendChild(timelineRow(item, !isFuture && !ongoing, ongoing));
  });

  // If all items are past, add now marker at end of timed section
  if (allPast || timed.length === 0) {
    nowMarker = document.createElement("div");
    nowMarker.className = "now-marker";
    nowMarker.id = "now-marker";
    nowMarker.innerHTML = `<span class="now-dot"></span><span class="now-label">Now</span><div class="now-line"></div>`;
    el.appendChild(nowMarker);
  }

  // Untimed / all-day tasks
  if (untimed.length > 0) {
    const label = document.createElement("div");
    label.className = "timeline-section-label";
    label.textContent = "Anytime today";
    el.appendChild(label);
    untimed.forEach(item => el.appendChild(timelineRow(item, false)));
  }

  // Empty state
  if (items.length === 0 && (!overdueItems || overdueItems.length === 0)) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.style.paddingTop = "40px";
    empty.textContent = "Nothing scheduled — open day.";
    el.appendChild(empty);
  }

  // Collapsed tomorrow + brief section
  const tmrToggle = document.createElement("div");
  tmrToggle.className = "tmr-toggle";
  const tmrCount = tmrItems.length;
  const hasBrief = !!briefText;
  const tmrLabel = "Tomorrow";
  const tmrMeta = tmrCount > 0 ? tmrCount + " event" + (tmrCount !== 1 ? "s" : "") : (hasBrief ? "" : "Nothing yet");
  tmrToggle.innerHTML = `<span>${tmrLabel}</span><span class="tmr-count">${tmrMeta}</span><span class="tmr-chevron">›</span>`;

  const tmrBody = document.createElement("div");
  tmrBody.className = "tmr-body";
  tmrBody.hidden = true;

  // Tonight's brief first
  if (hasBrief) {
    const briefBlock = document.createElement("div");
    briefBlock.className = "brief-block";
    briefBlock.textContent = briefText;
    tmrBody.appendChild(briefBlock);
  }

  // Tomorrow events
  if (tmrCount > 0) {
    if (hasBrief) {
      const divider = document.createElement("div");
      divider.className = "tmr-divider";
      divider.textContent = "Tomorrow's schedule";
      tmrBody.appendChild(divider);
    }
    tmrItems.forEach(({ ev }) => {
      ev._cal = ev._cal || { summary: "" };
      tmrBody.appendChild(eventRow({ ev, cal: ev._cal }));
    });
  } else if (!hasBrief) {
    tmrBody.innerHTML = `<div class="empty" style="padding:12px 0">Nothing yet.</div>`;
  }

  tmrToggle.addEventListener("click", () => {
    const open = !tmrBody.hidden;
    tmrBody.hidden = open;
    tmrToggle.querySelector(".tmr-chevron").textContent = open ? "›" : "⌄";
  });
  el.appendChild(tmrToggle);
  el.appendChild(tmrBody);

  // Auto-scroll: put now-marker near top, showing ~24px of last past item
  requestAnimationFrame(() => {
    const marker = $("now-marker");
    if (!marker) return;
    const container = el;
    const markerTop = marker.offsetTop;
    // Peek at last past item if any
    const peek = hasPast ? 28 : 0;
    container.scrollTop = Math.max(0, markerTop - peek);
  });
}

function fmtTime(date) {
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: CONFIG.TZ });
}

function timelineRow(item, isPast, ongoing) {
  if (item.type === "event") {
    // Reuse existing eventRow structure, just mark past.
    // v48: leading spacer keeps the time column aligned with task rows,
    // whose far-left slot is the checkbox.
    const row = eventRow({ ev: item.ev, cal: item.ev._cal || { summary: "" } });
    const spacer = document.createElement("span");
    spacer.className = "cb-spacer";
    row.prepend(spacer);
    if (ongoing) {
      row.classList.add("ongoing"); // v59: started, not finished — active
      const t = row.querySelector(".time");
      if (t) t.textContent += " · now";
    } else if (isPast) {
      row.style.opacity = "0.38";
    }
    return row;
  }
  const isDone = !!item.isDone;
  // Task row — matches Lists tab style but with time column prepended
  const row = document.createElement("div");
  row.className = "event" + (isDone ? " task-done" : "") +
    (isRecurringTask(item.task) ? " recurring" : ""); // reuse event card style
  row.id = "task-" + item.id;
  if (isPast && !isDone) row.style.opacity = "0.38";

  const timeEl = document.createElement("div");
  timeEl.className = "time" + (item.time ? "" : " allday");
  timeEl.textContent = item.time ? fmtTime(item.time) : "Anytime";
  if (item.overdueDate) {
    timeEl.className = "time overdue";
    timeEl.textContent = new Date(item.overdueDate + "T12:00:00")
      .toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  const w = document.createElement("div"); w.className = "what";
  // Checkbox
  const cb = document.createElement("button"); cb.className = "task-cb"; cb.type = "button";
  cb.dataset.done = isDone ? "1" : "0";
  cb.innerHTML = isDone ? CHECK_DONE_SVG : CHECK_OPEN_SVG;
  cb.addEventListener("click", (e) => {
    e.stopPropagation();
    if (cb.dataset.done === "1") uncompleteTask(item.id);
    else completeTask(item.id, { kind: item.overdueDate ? "overdue" : "today", data: { item } });
  });
  const title = document.createElement("div"); title.className = "title";
  title.textContent = item.title; // v62: 🔥 priority feature retired
  // v48: checkbox lives at the far left (Todoist/Notes convention),
  // then the time column, then the title.
  w.append(title);
  row.append(cb, timeEl, w);
  return row;
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
  $("cap-sheet").hidden = true;
  unpinCapSheet();
  const qp = $("cap-quick-pick");
  if (qp) qp.hidden = true;
}
function buildFabFlyout() {
  const flyout = $("fab-flyout");
  flyout.innerHTML = "";
  (FAB_OPTS[state.activeTab] || FAB_OPTS.today).forEach(o => {
    const btn = document.createElement("div");
    btn.className = "cap-opt";
    btn.innerHTML = `<i class="ti ${o.icon}" aria-hidden="true"></i>${o.label}`;
    btn.onclick = (e) => { e.stopPropagation(); $("fab-backdrop").classList.remove("open"); handleCapture(o.label); };
    flyout.appendChild(btn);
  });
}

function handleCapture(label) {
  switch (label) {
    case "Event":
      openCapSheet("event", "Event title…", null, todayISO());
      break;
    case "Task":
      // Week tab (or after clearing the date chip) supports natural language:
      // "dentist tue 3pm", "water plants every saturday"
      openCapSheet("task", state.activeTab === "today" ? "New task…" : "New task… (try: dentist tue 3pm)",
        null, state.activeTab === "today" ? todayISO() : null);
      break;
    case "Reminder":
      openCapSheet("reminder", "Remind me to…", null, state.activeTab === "today" ? todayISO() : null);
      break;
    case "Item": {
      // In the Pantry lens, new items are real store tasks — default to the
      // first store (edit the item afterward to set location/aisle).
      const ctx = groceryContext();
      const inPantry = ctx && ctx.pantry && state.activeListId === ctx.pantry.id;
      const target = (inPantry && ctx.stores[0]) ? ctx.stores[0].id : state.activeListId;
      openCapSheet("item", "Add item…", target);
      break;
    }
    case "Note":
      openCapSheet("note", "Quick note…", null);
      break;
    case "New list":
      openCapSheet("newlist", "List name…", null);
      break;
  }
}

/* ---------- capture sheet ---------- */
// v63: on iOS, a position:fixed bottom sheet doesn't reposition when the
// keyboard opens — it stays anchored to the full layout viewport while the
// *visual* viewport shrinks, so the sheet (and the blinking caret inside
// #cap-input) ends up rendered lower than the keyboard's actual top edge,
// reading as "the cursor shows up below the field." Track the visual
// viewport and translate the sheet up by exactly the keyboard's height.
function pinCapSheet() {
  const vv = window.visualViewport;
  const sheet = $("cap-sheet");
  if (!vv || !sheet || sheet.hidden) return;
  const kbInset = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
  sheet.style.transform = kbInset > 1 ? `translateY(-${kbInset}px)` : "";
}
function unpinCapSheet() {
  const sheet = $("cap-sheet");
  if (sheet) sheet.style.transform = "";
}
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", pinCapSheet);
  window.visualViewport.addEventListener("scroll", pinCapSheet);
}

function openCapSheet(type, placeholder, projectId, dueDate) {
  const sheet = $("cap-sheet");
  const input = $("cap-input");
  input.placeholder = placeholder;
  input.value = "";
  sheet.dataset.type = type;
  sheet.dataset.project = projectId || "";

  // Date + time chips — show for task, reminder, and event types
  const chip = $("cap-due-chip");
  const timeChip = $("cap-time-chip");
  const qp = $("cap-quick-pick");
  const tp = $("cap-time-pick");
  if (qp) qp.remove();
  if (tp) tp.remove();
  if (type === "task" || type === "reminder" || type === "event") {
    const defaultDate = dueDate || "";
    $("cap-due-txt").textContent = defaultDate ? fmtDueChip(defaultDate) : "No date";
    chip.dataset.date = defaultDate;
    $("cap-due-input").value = defaultDate;
    chip.hidden = false;
    timeChip.dataset.time = "";
    $("cap-time-txt").textContent = "No time";
    $("cap-time-input").value = "";
    timeChip.hidden = false;
  } else {
    chip.hidden = true;
    timeChip.hidden = true;
  }

  sheet.hidden = false;
  setTimeout(() => { input.focus(); pinCapSheet(); setTimeout(pinCapSheet, 350); }, 80);
}

function fmtDueChip(isoDate) {
  if (!isoDate) return "No date";
  const today = todayISO();
  const tomorrow = isoPlus(today, 1);
  if (isoDate === today) return "Today";
  if (isoDate === tomorrow) return "Tomorrow";
  const d = new Date(isoDate + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function fmtTimeChip(hhmm) {
  if (!hhmm) return "No time";
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(); d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// NOTE: assumes the device's local timezone matches CONFIG.TZ (America/Los_Angeles),
// consistent with how the rest of the app treats browser-local time as Pacific time.
function localToUTCISO(dateISO, timeHHMM) {
  return new Date(`${dateISO}T${timeHHMM}:00`).toISOString();
}

async function submitCapSheet() {
  const sheet = $("cap-sheet");
  const input = $("cap-input");
  const type = sheet.dataset.type;
  const projectId = sheet.dataset.project || null;
  const value = input.value.trim();
  if (!value) { sheet.hidden = true; unpinCapSheet(); return; }
  sheet.hidden = true;
  unpinCapSheet();

  const chipDate = $("cap-due-chip").dataset.date || "";
  const chipTime = $("cap-time-chip").dataset.time || "";

  try {
    if (type === "event") {
      await addCalendarEvent(value, chipDate || todayISO(), chipTime);
      toast("Event added");
      closeFab();
      if (state.activeTab === "today") renderToday();
      if (state.activeTab === "week") renderWeek();
      return;
    }
    if (!getTodoistToken()) { toast("Set a Todoist token in Settings first"); return; }
    if (type === "newlist") {
      await createTodoistProject(value);
      toast("List created");
      renderLists();
    } else {
      let due = null;
      // v63: lock the explicit local calendar date alongside the UTC instant
      // (see addTodoistTask) — this is the actual fix for "timed tasks added
      // for Today don't show up."
      if (chipDate && chipTime) due = { date: chipDate, datetime: localToUTCISO(chipDate, chipTime) };
      else if (chipDate) due = { date: chipDate };
      else if (type === "reminder") due = { string: "today" };
      if (type === "task" && !chipDate && !chipTime) {
        // No chips → let Todoist parse the text itself ("dentist tue 3pm",
        // "water plants every saturday", "milk #Groceries").
        try { await quickAddTask(value); }
        catch (_) { await addTodoistTask(value, projectId, due); }
      } else {
        await addTodoistTask(value, projectId, due);
      }
      toast("Added!");
      closeFab();
      if (type === "item" && state.activeTab === "lists") loadTasks();
      if ((type === "task" || type === "reminder") && state.activeTab === "today") renderToday();
    }
  } catch (e) {
    if (String(e.message).startsWith("cal-403")) {
      toast("Re-connect Google Calendar access, then try again");
      requestToken(true);
    } else if (type === "event") {
      toast("Couldn't add event — try again");
    } else {
      toast("Couldn't save — check Todoist token in Settings");
    }
  }
}

async function addCalendarEvent(title, dateISO, timeHHMM) {
  let body;
  if (timeHHMM) {
    const startISO = localToUTCISO(dateISO, timeHHMM);
    const endISO = new Date(new Date(startISO).getTime() + 60 * 60000).toISOString();
    body = {
      summary: title,
      start: { dateTime: startISO, timeZone: CONFIG.TZ },
      end: { dateTime: endISO, timeZone: CONFIG.TZ },
    };
  } else {
    body = {
      summary: title,
      start: { date: dateISO },
      end: { date: isoPlus(dateISO, 1) },
    };
  }
  const r = await fetch(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    { method: "POST", headers: { Authorization: "Bearer " + state.token, "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
  if (!r.ok) throw new Error("cal-" + r.status);
  state.ranges = {}; // invalidate cache so the new event shows up right away
  return r.json();
}

/* ---------- settings backup (Google Drive appDataFolder) ---------- */
// Hidden per-app storage in the user's own Drive — invisible in the Drive UI,
// only readable by this app while signed in as the same Google account.
// Lets calendar/list settings and the Todoist token survive a localStorage wipe
// (e.g. deleting + re-adding the home-screen icon resets iOS's storage container).
const DRIVE_SETTINGS_FILE = "hub-settings.json";
let driveSaveChain = Promise.resolve();

function saveSettingsToDrive() {
  driveSaveChain = driveSaveChain.then(saveSettingsToDriveImpl).catch((e) => {
    console.warn("Drive settings backup failed", e);
  });
  return driveSaveChain;
}

async function driveFindSettingsFileId() {
  const r = await fetch(
    "https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=" +
      encodeURIComponent(`name='${DRIVE_SETTINGS_FILE}'`) + "&fields=files(id,name)",
    { headers: { Authorization: "Bearer " + state.token } }
  );
  if (!r.ok) throw new Error("drive-" + r.status);
  const data = await r.json();
  return (data.files && data.files[0]) ? data.files[0].id : null;
}

async function saveSettingsToDriveImpl() {
  if (!state.token) return;
  const payload = {
    calsOff: [...state.calsOff],
    projectsOff: JSON.parse(localStorage.getItem("hub.projectsOff") || "[]"),
    projectOrder: JSON.parse(localStorage.getItem("hub.projectOrder") || "null"),
    inventoryMode: getInventoryOverrides(),
    activeListId: state.activeListId,
    todoistToken: getTodoistToken(),
    savedAt: Date.now(),
  };
  let fileId = await driveFindSettingsFileId();
  if (!fileId) {
    const createRes = await fetch("https://www.googleapis.com/drive/v3/files", {
      method: "POST",
      headers: { Authorization: "Bearer " + state.token, "Content-Type": "application/json" },
      body: JSON.stringify({ name: DRIVE_SETTINGS_FILE, parents: ["appDataFolder"] }),
    });
    if (!createRes.ok) throw new Error("drive-create-" + createRes.status);
    fileId = (await createRes.json()).id;
  }
  await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
    method: "PATCH",
    headers: { Authorization: "Bearer " + state.token, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// Only restores if this looks like a fresh/wiped install — never clobbers
// settings the user has already set on this device.
async function restoreSettingsFromDriveIfEmpty() {
  const hasLocalSettings = localStorage.getItem("hub.todoistToken") ||
    localStorage.getItem("hub.calsOff") || localStorage.getItem("hub.projectOrder");
  if (hasLocalSettings) return;
  try {
    const fileId = await driveFindSettingsFileId();
    if (!fileId) return;
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers: { Authorization: "Bearer " + state.token } });
    if (!r.ok) return;
    const data = await r.json();
    if (data.calsOff) localStorage.setItem("hub.calsOff", JSON.stringify(data.calsOff));
    if (data.projectsOff) localStorage.setItem("hub.projectsOff", JSON.stringify(data.projectsOff));
    if (data.projectOrder) localStorage.setItem("hub.projectOrder", JSON.stringify(data.projectOrder));
    if (data.inventoryMode) localStorage.setItem("hub.inventoryMode", JSON.stringify(data.inventoryMode));
    if (data.activeListId) localStorage.setItem("hub.activeList", data.activeListId);
    if (data.todoistToken) localStorage.setItem("hub.todoistToken", data.todoistToken);
    state.calsOff = new Set(JSON.parse(localStorage.getItem("hub.calsOff") || "[]"));
    state.activeListId = localStorage.getItem("hub.activeList") || null;
    toast("Restored your settings from backup");
  } catch (e) {
    console.warn("Drive settings restore failed", e);
  }
}

/* ---------- settings ---------- */
const getProjectsOff = () => new Set(JSON.parse(localStorage.getItem("hub.projectsOff") || "[]"));

// v53: lock the page behind modals — scrolling the Settings list was also
// scrolling the active list underneath (iOS scroll bleed-through).
let _bodyLocked = false, _bodyLockY = 0;
function lockBodyScroll() {
  if (_bodyLocked) return;
  _bodyLocked = true;
  _bodyLockY = window.scrollY;
  document.body.style.position = "fixed";
  document.body.style.top = (-_bodyLockY) + "px";
  document.body.style.left = "0";
  document.body.style.right = "0";
}
function unlockBodyScroll() {
  if (!_bodyLocked) return;
  _bodyLocked = false;
  document.body.style.position = "";
  document.body.style.top = "";
  document.body.style.left = "";
  document.body.style.right = "";
  window.scrollTo(0, _bodyLockY);
}
function closeSettings() {
  $("settings").hidden = true;
  unlockBodyScroll();
}

function openSettings() {
  if ($("settings").hidden) lockBodyScroll();
  $("settings-back").hidden = true;
  $("settings-title").textContent = "Settings";
  const body = $("settings-body");
  body.innerHTML = "";

  const navItems = [
    { label: "Calendars", page: "calendars" },
    { label: "Lists", page: "lists" },
  ];
  navItems.forEach(({ label, page }) => {
    const row = document.createElement("div");
    row.className = "settings-nav-row";
    row.innerHTML = `<span>${label}</span><span class="settings-nav-arrow">›</span>`;
    row.addEventListener("click", () => openSettingsPage(page));
    body.appendChild(row);
  });

  $("settings").hidden = false;
}

function openSettingsPage(page) {
  $("settings-back").hidden = false;
  const body = $("settings-body");
  body.innerHTML = "";

  if (page === "calendars") {
    $("settings-title").textContent = "Calendars";
    [...state.cals]
      .sort((a, b) => (a.summaryOverride || a.summary || "").localeCompare(b.summaryOverride || b.summary || ""))
      .forEach((cal) => {
        const row = document.createElement("label"); row.className = "cal-row";
        const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = calOn(cal);
        cb.addEventListener("change", () => {
          cb.checked ? state.calsOff.delete(cal.id) : state.calsOff.add(cal.id);
          localStorage.setItem("hub.calsOff", JSON.stringify([...state.calsOff]));
          saveSettingsToDrive();
          renderToday(); renderWeek();
        });
        const name = document.createElement("span");
        name.textContent = cal.summaryOverride || cal.summary || cal.id;
        row.append(cb, name); body.append(row);
      });
  }

  if (page === "lists") {
    $("settings-title").textContent = "Lists";
    const projectsOff = getProjectsOff();

    // Token section
    const tokenSection = document.createElement("div");
    tokenSection.innerHTML = `
      <div class="settings-section-label">Todoist API token</div>
      <input type="password" id="todoist-token-input" class="settings-token-input"
        placeholder="Paste token…" value="${getTodoistToken()}">
      <div class="settings-token-actions">
        <button id="token-vis-btn" class="settings-btn-secondary">Show</button>
        <button id="token-save-btn" class="settings-btn-primary">Save token</button>
      </div>`;
    body.append(tokenSection);
    tokenSection.querySelector("#token-vis-btn").addEventListener("click", toggleTokenVisibility);
    tokenSection.querySelector("#token-save-btn").addEventListener("click", saveTodoistToken);

    // Projects section
    if (state.todoistProjects && state.todoistProjects.length > 0) {
      const projLabel = document.createElement("div");
      projLabel.className = "settings-section-label";
      projLabel.style.marginTop = "20px";
      projLabel.textContent = "Projects shown";
      body.append(projLabel);

      // Load saved order, fall back to current order
      const savedOrder = JSON.parse(localStorage.getItem("hub.projectOrder") || "null");
      if (savedOrder) {
        const idMap = Object.fromEntries(state.todoistProjects.map(p => [p.id, p]));
        state.todoistProjects = savedOrder.map(id => idMap[id]).filter(Boolean)
          .concat(state.todoistProjects.filter(p => !savedOrder.includes(p.id)));
      }

      const projList = document.createElement("div");
      projList.id = "proj-sort-list";
      body.append(projList);

      const hint = document.createElement("div");
      hint.className = "settings-hint";
      hint.textContent = "Hold + drag a list to reorder (sub-lists move with their parent). ♻︎ = inventory list: checked items stay visible.";
      body.append(hint);

      // v52: drag to reorder (same gesture as task cards); ♻︎ toggles
      // inventory behavior per list.
      const renderProjRows = () => {
        projList.innerHTML = "";
        const projectsOff2 = getProjectsOff();
        allProjectsFlat().forEach((p) => {
          const i = state.todoistProjects.indexOf(p); // -1 for subprojects
          const row = document.createElement("div");
          row.className = "proj-sort-row";
          row.dataset.id = p.id;
          row.dataset.top = i >= 0 ? "1" : "0";
          if (p._depth) row.style.paddingLeft = (2 + p._depth * 18) + "px";

          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.checked = !projectsOff2.has(p.id);
          cb.addEventListener("change", () => {
            const off = getProjectsOff();
            cb.checked ? off.delete(p.id) : off.add(p.id);
            localStorage.setItem("hub.projectsOff", JSON.stringify([...off]));
            saveSettingsToDrive();
            buildProjectBar();
          });

          const name = document.createElement("span");
          name.textContent = p.name;
          name.style.flex = "1";
          if (p._depth) name.style.color = "var(--muted)";

          const invBtn = document.createElement("button");
          invBtn.className = "inv-btn" + (isInventoryList(p.id) ? " on" : "");
          invBtn.textContent = "♻︎";
          invBtn.title = "Inventory list — checked items stay visible";
          invBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            setInventoryOverride(p.id, !isInventoryList(p.id));
            invBtn.classList.toggle("on", isInventoryList(p.id));
          });

          row.append(cb, name, invBtn);
          if (i >= 0) attachSettingsDrag(row, p.id);
          projList.append(row);
        });
      };
      state._renderProjRows = renderProjRows;
      renderProjRows();
    }
  }
}

function toggleTokenVisibility() {
  const input = $("todoist-token-input");
  const btn = $("token-vis-btn");
  if (input.type === "password") { input.type = "text"; btn.textContent = "Hide"; }
  else { input.type = "password"; btn.textContent = "Show"; }
}

function saveTodoistToken() {
  const val = $("todoist-token-input").value.trim();
  if (!val) { toast("Token can't be empty"); return; }
  localStorage.setItem("hub.todoistToken", val);
  saveSettingsToDrive();
  closeSettings();
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
      // v59: elastic resistance (diminishing returns like native rubber-band)
      // + a much longer pull (140px) before triggering — it fired too easily.
      pulling = dy > 140;
      ptr.hidden = false;
      ptr.textContent = pulling ? "Release to refresh" : "Pull to refresh";
      ptr.style.height = Math.min(64, 64 * (1 - Math.exp(-dy / 180))) + "px";
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

/* ---------- screen wake lock (v58) ----------
   While a grocery/inventory list is on screen, keep the display awake —
   no more phone sleeping mid-aisle. Released when leaving the list or
   backgrounding; re-acquired on return (iOS releases locks on hide). */
let _wakeLock = null;
async function updateWakeLock() {
  const want = state.activeTab === "lists" &&
    isInventoryList(state.activeListId) &&
    document.visibilityState === "visible";
  try {
    if (want && !_wakeLock && "wakeLock" in navigator) {
      _wakeLock = await navigator.wakeLock.request("screen");
      _wakeLock.addEventListener("release", () => { _wakeLock = null; });
    } else if (!want && _wakeLock) {
      const wl = _wakeLock; _wakeLock = null;
      await wl.release();
    }
  } catch (_) { _wakeLock = null; } // unsupported/denied — degrade silently
}

/* ---------- tab switching ---------- */
function switchTab(tab) {
  state.activeTab = tab;
  localStorage.setItem("hub.activeTab", tab); // v58: relaunch restores this
  ["today", "week", "lists"].forEach(t => {
    const mainEl = $("tab-" + t);
    const btnEl = $("tb-" + t);
    if (mainEl) mainEl.hidden = (t !== tab);
    if (btnEl) btnEl.classList.toggle("active", t === tab);
  });
  if (tab === "lists") renderLists();
  updateWakeLock();
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
  $("btn-signin").addEventListener("click", () => requestToken(true));
  $("btn-settings").addEventListener("click", openSettings);
  $("settings-back").addEventListener("click", openSettings);
  $("settings-close").addEventListener("click", closeSettings);
  $("settings").addEventListener("click", (e) => { if (e.target === $("settings")) closeSettings(); });

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
  // v62: chips ARE native pickers — a transparent date/time input covers
  // each chip, so one tap opens iOS's own picker. Clearing the value (the
  // picker's Reset/backspace) returns to "No date"/"No time".
  $("cap-due-input").addEventListener("change", (e) => {
    const val = e.target.value;
    $("cap-due-chip").dataset.date = val;
    $("cap-due-txt").textContent = val ? fmtDueChip(val) : "No date";
  });
  $("cap-time-input").addEventListener("change", (e) => {
    const val = e.target.value;
    $("cap-time-chip").dataset.time = val;
    $("cap-time-txt").textContent = val ? fmtTimeChip(val) : "No time";
  });

  document.addEventListener("visibilitychange", () => {
    updateWakeLock(); // v58: re-acquire on return, release on hide
    if (!document.hidden && localStorage.getItem("hub.authed") === "1" && ensureToken()) refreshAll();
  });

  wirePullToRefresh();
  wireDrag();
}

window.addEventListener("load", () => {
  wireUI();
  const start = () => (window.google && google.accounts ? initAuth() : setTimeout(start, 150));
  start();
});
/* v57: update banner — new builds activate immediately (skipWaiting+claim),
   so when the controller changes on an already-controlled page, a fresh
   version is live and one refresh picks it up. No more force-quitting. */
function showUpdateBanner() {
  if ($("upd-banner")) return;
  const b = document.createElement("div");
  b.id = "upd-banner";
  b.className = "upd-banner";
  b.textContent = "Update ready — tap to refresh";
  b.addEventListener("click", () => location.reload());
  document.body.appendChild(b);
}
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) { hadController = true; return; } // first install
    showUpdateBanner();
  });
}

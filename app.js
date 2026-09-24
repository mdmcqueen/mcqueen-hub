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
  feedCache: {},      // v79: url -> { text, at }
  feedErrors: {},     // v79: feed id -> true when its last fetch failed
  needConsent: false, // v78: escalate to prompt:"consent" only after a quiet try fails
  tokenAsked: false,
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
    error_callback: () => { onTokenFailure(); },
  });
  const savedScopeVer = Number(localStorage.getItem("hub.scopeVer") || 0);
  const needsReconsent = savedScopeVer < CONFIG.SCOPE_VERSION;
  const cachedTok = localStorage.getItem("hub.tok");
  const cachedExp = Number(localStorage.getItem("hub.tokExp") || 0);
  if (!needsReconsent && cachedTok && Date.now() < cachedExp - 60000) {
    state.token = cachedTok; state.tokenExp = cachedExp;
    showMain(); boot(); return;
  }
  // v72: always try a SILENT grab first, even with no "hub.authed" flag. The
  // Google grant lives server-side and survives localStorage being evicted (iOS
  // ITP; an installed PWA also has a separate store from Safari's). GIS does a
  // prompt:"" request through a hidden iframe — no popup, no user gesture needed
  // — so if the grant is still good we land straight in the app. Only if it
  // fails do we show the sign-in screen, whose button does the real consent
  // inside a click (a popup outside a gesture would be blocked).
  // Deliberately NOT passing needsReconsent here: that would force prompt:"consent"
  // at load with no gesture. A grant missing a scope is caught in onToken instead.
  requestToken(false);
}
/* v78: `prompt:"consent"` DEMANDS the whole Google gauntlet — account chooser,
   unverified-app interstitial, "go to … (unsafe)", scope list — even when a
   perfectly good grant already exists. It should be the last resort, not the
   normal path. `prompt:""` reuses the existing grant silently.

   Why the sign-in button still gets tapped at all on iPhone: the boot-time
   silent attempt runs in a hidden iframe against accounts.google.com, which
   needs a third-party cookie, and Safari blocks those outright. So on iOS the
   silent boot path can never succeed and we always land on the sign-in screen.
   The button's popup is a TOP-LEVEL window, though, so it does carry the real
   Google session — `prompt:""` there should return a token with no UI at all.
   `hint` names the account so the chooser is skipped too.

   If that fails the grant is genuinely gone, so the NEXT tap escalates to
   consent. Escalating inside the failure handler instead would open a popup
   well after the gesture, which Safari blocks. */
function requestToken(forceConsent) {
  const opts = { prompt: forceConsent || state.needConsent ? "consent" : "" };
  if (state.email) opts.hint = state.email;
  state.tokenAsked = true;
  state.tokenClient.requestAccessToken(opts);
}

// Something went wrong getting a token: a silent attempt with no live grant,
// a dismissed popup, a network failure. Arm the escalation so the next tap
// asks for real consent, and get the user back to a button they can press.
function onTokenFailure() {
  if (state.tokenAsked && !state.needConsent) {
    state.needConsent = true;
    toast("Tap Sign in once more to reconnect Google");
  }
  showSignin();
}
async function onToken(resp) {
  if (resp.error) { onTokenFailure(); return; }
  // v72: a silent request can succeed while granting FEWER scopes than we asked
  // for (e.g. an older grant predating a SCOPE_VERSION bump). GIS reports what was
  // actually granted; if anything is missing, bail to the sign-in screen so the
  // user can tap through a real consent. Defensive: if resp.scope is absent, trust it.
  if (resp.scope) {
    const granted = resp.scope.split(" ").filter(Boolean);
    const missing = CONFIG.SCOPES.split(" ").filter((s) => s && !granted.includes(s));
    // A short grant can only be fixed by real consent, so escalate directly.
    if (missing.length) { state.needConsent = true; showSignin(); return; }
  }
  state.token = resp.access_token;
  state.tokenExp = Date.now() + (resp.expires_in - 60) * 1000;
  localStorage.setItem("hub.authed", "1");
  localStorage.setItem("hub.tok", state.token);
  localStorage.setItem("hub.tokExp", String(state.tokenExp));
  localStorage.setItem("hub.scopeVer", String(CONFIG.SCOPE_VERSION));
  state.needConsent = false; // v78: got a token, so stand the escalation down
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
  // v79: the Drive backup needs a Google token. On the feeds path there
  // may not be one, and that must not stop the app booting.
  if (state.token) await restoreSettingsFromDriveIfEmpty();
  // v81: pull the household settings first — they may carry the calendar
  // feeds and Todoist token this device doesn't have yet.
  if (syncOn()) {
    try { if (await syncPull() === "applied") state.ranges = {}; }
    catch (e) { console.warn("settings pull failed", e); }
  }
  flushOutbox(); // v75: a relaunch heals anything left queued from last session
  // v58: relaunch lands where you were — with cached lists this paints the
  // grocery list instantly even before any network call resolves.
  const savedTab = localStorage.getItem("hub.activeTab");
  if (savedTab && savedTab !== "today" && savedTab !== state.activeTab) {
    switchTab(savedTab);
  }
  // v79: with feeds configured the calendar list comes from them, and no
  // Google call happens at all.
  if (usingFeeds()) {
    state.cals = getFeeds().map((f) => ({ id: f.id, summary: f.name || "Calendar" }));
    await refreshAll();
    return;
  }
  try {
    const data = await gapiFetch("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250");
    state.cals = (data.items || []).filter((c) => c.selected !== false || c.primary);
    await refreshAll();
  } catch (e) { if (String(e.message) !== "auth") toast("Couldn't load calendars"); }
}
/* ---------- calendar feeds (v79) ----------
   Google's API needs an OAuth token, and on iOS that means clearing a
   security gauntlet most launches (see the v78 notes). A calendar's
   "secret address in iCal format" needs no sign-in at all, so when feeds
   are configured they become the source and Google is not required to
   open the app.

   calendar.google.com sends no CORS headers, so feeds are read through
   the Worker's /ical route rather than directly. */
const getFeeds = () => {
  try { const a = JSON.parse(localStorage.getItem("hub.calFeeds") || "[]"); return Array.isArray(a) ? a : []; }
  catch (_) { return []; }
};
const setFeeds = (arr) => {
  localStorage.setItem("hub.calFeeds", JSON.stringify(arr));
  saveSettingsToDrive();
};
// Feeds configured => feeds are the calendar. No feeds => unchanged Google path.
const usingFeeds = () => getFeeds().length > 0;
const feedUrl = (u) => CONFIG.TODOIST + "/ical?u=" + encodeURIComponent(u);

// Raw .ics text, briefly cached: Today and Week ask for different windows
// but the same feeds, and refetching every feed per window is wasteful.
async function fetchFeedText(url, maxAgeMs) {
  const cache = (state.feedCache = state.feedCache || {});
  const hit = cache[url];
  if (hit && Date.now() - hit.at < (maxAgeMs == null ? 240000 : maxAgeMs)) return hit.text;
  const r = await fetch(feedUrl(url));
  if (!r.ok) throw new Error("feed-" + r.status);
  const text = await r.text();
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("not-a-calendar");
  cache[url] = { text, at: Date.now() };
  return text;
}

// Check one feed and read its own name out of it, for the settings screen.
async function probeFeed(url) {
  const text = await fetchFeedText(url, 0);
  const parsed = ICAL.parse(text, CONFIG.TZ);
  return { name: parsed.calName || "Calendar", events: parsed.events.length };
}

async function fetchRangeFromFeeds(startISO, days) {
  const feeds = getFeeds();
  const from = isoPlus(startISO, -1);
  const to = isoPlus(startISO, days + 1);
  const all = [];
  await Promise.all(feeds.map(async (f) => {
    try {
      const text = await fetchFeedText(f.url);
      const parsed = ICAL.parse(text, CONFIG.TZ);
      const cal = { id: f.id, summary: f.name || parsed.calName || "Calendar" };
      all.push(...ICAL.expand(parsed, from, to, CONFIG.TZ, cal));
    } catch (_) {
      // One bad feed must not empty the whole calendar.
      state.feedErrors = state.feedErrors || {};
      state.feedErrors[f.id] = true;
    }
  }));
  return all;
}

async function fetchRange(startISO, days) {
  const key = startISO + ":" + days;
  if (state.ranges[key]) return state.ranges[key];
  if (usingFeeds()) {                                    // v79
    state.ranges[key] = await fetchRangeFromFeeds(startISO, days);
    return state.ranges[key];
  }
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
  // v69: covers relaunching straight into the Week tab, where switchTab()
  // already ran before this data existed to scroll to.
  if (state.activeTab === "week") scrollWeekToToday();
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
  /* v75: a fetch with no deadline can hang forever on captive or flaky store
     wi-fi. The await never settles, so the catch never runs, no error is ever
     shown, and the caller believes the write succeeded. Abort at 15s so a
     stalled request becomes a real, catchable failure. */
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  opts.signal = ctl.signal;
  let r;
  try {
    r = await fetch(CONFIG.TODOIST + path, opts);
  } catch (_) {
    throw new Error(ctl.signal.aborted ? "todoist-timeout" : "todoist-network");
  } finally {
    clearTimeout(timer);
  }
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

// v70: same idea as syncPillbarHeight() but for .week-nav, which is now the
// single sticky/safe-area-absorbing bar for the Week tab (see styles.css) —
// .day-head sticks directly under it via var(--weeknav-h).
function syncWeeknavHeight() {
  const nav = document.querySelector(".week-nav");
  if (!nav) return;
  const h = nav.getBoundingClientRect().height;
  if (h > 0) document.documentElement.style.setProperty("--weeknav-h", h + "px");
}
window.addEventListener("resize", syncWeeknavHeight);

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
      projectId, // v73: completed rows need it so the store picker can read them
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
/* v82: collapsible list sections.

   The rows are siblings of their heading in one flat fragment — not nested
   inside it — because drag-to-reorder reads .task-row positions directly and
   wrapping them would change what it sees. So collapsing walks forward from
   a heading to the next one and hides those wrappers, leaving the structure
   alone. Collapsed state is per list and remembered, so a long store list
   opens the way you left it. */
const collapsedKey = (listId) => "hub.collapsed." + listId;
function getCollapsed(listId) {
  try { return new Set(JSON.parse(localStorage.getItem(collapsedKey(listId)) || "[]")); }
  catch (_) { return new Set(); }
}
function setCollapsed(listId, set) {
  try { localStorage.setItem(collapsedKey(listId), JSON.stringify([...set])); } catch (_) {}
}
const secKeyOf = (head) => head.dataset.sectionId || head.dataset.loc || head.textContent || "";

// Hide or show every row between this heading and the next one.
function applySectionCollapse(head, collapsed) {
  head.classList.toggle("collapsed", collapsed);
  let n = head.nextElementSibling;
  while (n && !n.classList.contains("list-section-head")) {
    if (n.classList.contains("swipe-wrap") || n.classList.contains("task-row")) {
      n.classList.toggle("sec-hidden", collapsed);
    }
    n = n.nextElementSibling;
  }
}

function wireSectionCollapse(el, listId) {
  const set = getCollapsed(listId);
  el.querySelectorAll(".list-section-head").forEach((head) => {
    const key = secKeyOf(head);
    if (set.has(key)) applySectionCollapse(head, true);
    head.addEventListener("click", (e) => {
      // A section rename also lives on this heading (v50) — don't hijack it.
      if (e.target.tagName === "INPUT") return;
      const live = getCollapsed(listId);
      const now = !live.has(key);
      now ? live.add(key) : live.delete(key);
      setCollapsed(listId, live);
      applySectionCollapse(head, now);
    });
  });
}

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
  let { tasks, sections, doneItems, inventory } = data;
  /* v75: an unconfirmed check-off still lives in the outbox, so a refetch
     that reports the item as open — or a cached paint from before the tap —
     must not flip it back to unchecked. */
  const pending = outboxMap();
  if (Object.keys(pending).length) {
    const closing = (tasks || []).filter(t => pending[t.id] === "close");
    const reopening = (doneItems || []).filter(t => pending[t.id] === "reopen");
    if (closing.length || reopening.length) {
      tasks = (tasks || []).filter(t => pending[t.id] !== "close").concat(reopening);
      doneItems = (doneItems || []).filter(t => pending[t.id] !== "reopen").concat(closing);
    }
  }
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
  wireSectionCollapse(el, state.activeListId); // v82
}

const listCacheKey = (id) => "hub.listCache." + id;
function readListCache(id) {
  try { return JSON.parse(localStorage.getItem(listCacheKey(id)) || "null"); }
  catch (_) { return null; }
}
function writeListCache(id, data) {
  try { localStorage.setItem(listCacheKey(id), JSON.stringify(data)); } catch (_) {}
}

/* ---------- offline outbox (v75) ----------
   A check-off used to be fire-and-forget: the row was ticked, trip mode hid
   it 2.2s later, and the close request went out unsupervised. If that request
   failed — or hung, which on store wi-fi it does — nothing recovered it. The
   row was already gone, so the rollback had no row to roll back, and the next
   refresh quietly showed the item as still needed. That is exactly what
   happened at Whole Foods on 2026-09-20: four items checked off mid-aisle
   left no trace in Todoist at all.

   Now the intent is written down BEFORE the network call and only cleared on
   confirmation, so a check-off survives a timeout, a dropped connection, a
   backgrounded PWA, or a relaunch, and is retried until it lands. */
const OUTBOX_KEY = "hub.outbox";
function readOutbox() {
  try { const a = JSON.parse(localStorage.getItem(OUTBOX_KEY) || "[]"); return Array.isArray(a) ? a : []; }
  catch (_) { return []; }
}
function writeOutbox(arr) {
  try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(arr)); } catch (_) {}
}
function outboxPut(taskId, op, projectId) {
  const arr = readOutbox().filter(e => e.taskId !== taskId); // newest intent wins
  arr.push({ taskId, op, projectId, at: Date.now() });
  writeOutbox(arr);
}
function outboxDrop(taskId) {
  writeOutbox(readOutbox().filter(e => e.taskId !== taskId));
}
function outboxMap() {
  const m = {};
  readOutbox().forEach(e => { m[e.taskId] = e.op; });
  return m;
}

// Keep the cached list in step with a confirmed write, so the pill badge and
// an offline relaunch don't fall back to a pre-check-off snapshot.
function cacheMarkDone(projectId, taskId) {
  const c = projectId ? readListCache(projectId) : null;
  if (!c || !Array.isArray(c.tasks)) return;
  const t = c.tasks.find(x => x.id === taskId);
  if (!t) return;
  writeListCache(projectId, { ...c,
    tasks: c.tasks.filter(x => x.id !== taskId),
    doneItems: (c.doneItems || []).concat([t]) });
}
function cacheMarkOpen(projectId, taskId) {
  const c = projectId ? readListCache(projectId) : null;
  if (!c) return;
  const d = (c.doneItems || []).find(x => x.id === taskId);
  if (!d) return;
  writeListCache(projectId, { ...c,
    tasks: (c.tasks || []).concat([d]),
    doneItems: (c.doneItems || []).filter(x => x.id !== taskId) });
}

let _flushing = false;
async function flushOutbox() {
  if (_flushing || navigator.onLine === false) return;
  if (!readOutbox().length || !getTodoistToken()) return;
  _flushing = true;
  let settled = 0, stalled = false;
  try {
    for (const e of readOutbox()) {
      try {
        await todoistFetch("/tasks/" + e.taskId + "/" + (e.op === "close" ? "close" : "reopen"), "POST");
        outboxDrop(e.taskId);
        if (e.op === "close") cacheMarkDone(e.projectId, e.taskId);
        else cacheMarkOpen(e.projectId, e.taskId);
        settled++;
      } catch (err) {
        const code = parseInt((/todoist-(\d+)/.exec(String(err && err.message)) || [])[1], 10);
        if (code >= 400 && code < 500) { outboxDrop(e.taskId); settled++; } // gone or rejected: stop retrying
        else { stalled = true; break; }                                     // offline/timeout/5xx: keep for later
      }
    }
  } finally { _flushing = false; }
  if (settled) buildProjectBar();
  const left = readOutbox().length;
  if (stalled && left) toast(left + (left === 1 ? " change" : " changes") + " waiting to sync");
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
  await flushOutbox(); // v75: land any queued check-offs before reading back
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
        rows.push(buildTaskRow(t, false, { storeBadge: badge(store.name), storeId: store.id, loc })));
      done.filter(c => locOf(c) === loc).forEach(c =>
        rows.push(buildTaskRow(c, true, { storeBadge: badge(store.name), storeId: store.id, loc })));
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
  wireSectionCollapse(el, state.activeListId); // v82
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
  // v75: discount check-offs still in flight, so the badge drops on the tap
  // instead of sitting on the count from the last completed refresh.
  const pend = outboxMap();
  return c.tasks.filter(t => qtyOf(t) >= 1 && pend[t.id] !== "close").length;
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
    // v76: measure the excluded checkbox gutter instead of hard-coding it.
    // Trip mode draws a bigger box with a bigger tap area, and a fixed 46px
    // would let a tap beside it open the edit sheet instead of checking off.
    // Outside trip mode this still works out to exactly 46px.
    const rowLeft = row.getBoundingClientRect().left;
    const cbBox = row.querySelector(".task-cb");
    const gutter = cbBox ? (cbBox.getBoundingClientRect().right - rowLeft + 12) : 46;
    if (e.clientX - rowLeft < gutter) return;
    if (Date.now() < (drag.suppressClickUntil || 0)) return;
    if (Date.now() < (swipe.suppressClickUntil || 0)) return;
    openTaskEdit(task, { storeId: opts.storeId }); // v73
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

function openTaskEdit(task, opts) {
  opts = opts || {};
  const old = $("task-edit");
  if (old) old.remove();
  const modal = document.createElement("div");
  modal.className = "modal"; modal.id = "task-edit";
  const card = document.createElement("div");
  card.className = "modal-card";
  /* v73: which store list this item lives in. The row supplies it (the Pantry
     lens knows, and completed rows now carry projectId); on a real store list
     the active list is itself the store. Only offered when there's more than
     one store to choose between and we actually know the current one. */
  /* v82: Home location comes from the Pantry's sections (Cupboard, Fridge,
     Freezer). Those mean nothing on a non-grocery list, but the chips were
     rendered for every task on every list — so editing something in Michael
     offered to file it in the Freezer. Show them only inside the Groceries
     family. */
  const gc = groceryContext();
  const groceryIds = new Set();
  if (gc) {
    if (gc.parent) groceryIds.add(gc.parent.id);
    if (gc.pantry) groceryIds.add(gc.pantry.id);
    (gc.stores || []).forEach((st) => groceryIds.add(st.id));
  }
  const taskProject = opts.storeId || task.projectId || task.project_id || state.activeListId;
  const showLocs = groceryIds.has(taskProject);

  const storeList = (gc || {}).stores || [];
  const startStore = opts.storeId || task.projectId || task.project_id ||
    (storeList.some(s => s.id === state.activeListId) ? state.activeListId : null);
  const showStores = storeList.length > 1 && storeList.some(s => s.id === startStore);
  let chosenStore = startStore;
  card.innerHTML = `
    <div class="modal-head"><strong>Edit item</strong><button class="btn-icon" id="te-close">✕</button></div>
    <input id="te-title" class="settings-token-input" type="text" autocomplete="off">` +
    (showLocs ? `
    <div class="settings-section-label" style="margin-top:16px">Home location</div>
    <div class="te-locs" id="te-locs"></div>` : "") +
    (showStores ? `
    <div class="settings-section-label" style="margin-top:16px">Store</div>
    <div class="te-locs" id="te-stores"></div>` : "") + `
    <div class="settings-token-actions" style="margin-top:16px"><button id="te-save" class="settings-btn-primary">Save</button></div>`;
  modal.appendChild(card);
  document.body.appendChild(modal);
  lockBodyScroll();
  $("te-title").value = task.content;
  let chosen = homeLocOf(task);
  const locsEl = $("te-locs");
  const renderLocs = () => {
    if (!locsEl) return;          // v82: hidden outside the Groceries family
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
  // v73: unlike home location, store is not clearable — an item must live in some store list.
  const renderStores = () => {
    const el = $("te-stores");
    if (!el) return;
    el.innerHTML = "";
    storeList.forEach(s => {
      const b = document.createElement("button");
      b.className = "cap-pick-btn" + (chosenStore === s.id ? " te-active" : "");
      b.textContent = s.name;
      b.onclick = () => { chosenStore = s.id; renderStores(); };
      el.appendChild(b);
    });
  };
  renderStores();
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
      if (showStores && chosenStore && chosenStore !== startStore) {
        await moveTask(task.id, { project_id: chosenStore }); // v73
        const s = storeList.find(x => x.id === chosenStore);
        toast("Moved to " + (s ? s.name : "store"));
      } else {
        toast("Saved");
      }
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
  // v75: write the intent down before going to the network.
  const projectId = (ctx && ctx.data && ctx.data.projectId) || state.activeListId;
  outboxPut(id, "close", projectId);
  buildProjectBar(); // badge reflects the tap right away
  try {
    await todoistFetch("/tasks/" + id + "/close", "POST");
    outboxDrop(id);
    cacheMarkDone(projectId, id);
    buildProjectBar();
  } catch (e) {
    const code = parseInt((/todoist-(\d+)/.exec(String(e && e.message)) || [])[1], 10);
    if (code >= 400 && code < 500) {
      // Rejected outright (task deleted, bad request) — retrying won't help,
      // so undo the optimistic UI and say so.
      outboxDrop(id);
      toast("Couldn't complete — try again");
      if (wrap) { clearTimeout(wrap._tripHideTimer); wrap.classList.remove("pending-hide"); }
      if (row) {
        row.classList.remove("task-done");
        const cb = row.querySelector(".task-cb");
        if (cb) { cb.innerHTML = CHECK_OPEN_SVG; cb.dataset.done = "0"; }
      }
      state.completedRecently.delete(id);
      buildProjectBar();
    } else {
      // Offline, timed out, or Todoist is down: the check-off stays queued and
      // the item stays checked. Don't put it back on the shelf.
      toast("Saved — will sync when you're back online");
    }
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
  const projectId = state.activeListId; // v75
  outboxPut(id, "reopen", projectId);
  buildProjectBar();
  try {
    await todoistFetch("/tasks/" + id + "/reopen", "POST");
    outboxDrop(id);
    cacheMarkOpen(projectId, id);
    buildProjectBar();
  } catch (e) {
    const code = parseInt((/todoist-(\d+)/.exec(String(e && e.message)) || [])[1], 10);
    if (code >= 400 && code < 500) {
      outboxDrop(id);
      toast("Couldn't undo — try again");
      if (row) {
        row.classList.add("task-done");
        const cb = row.querySelector(".task-cb");
        if (cb) { cb.innerHTML = CHECK_DONE_SVG; cb.dataset.done = "1"; }
      }
      buildProjectBar();
    } else {
      toast("Saved — will sync when you're back online");
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
  if (row2 && row2 !== sdrag.row &&
      row2.dataset.top === sdrag.row.dataset.top &&
      row2.dataset.parent === sdrag.row.dataset.parent) { // v74: siblings only
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
  if (!overRow || !pid || !row) return;
  const targetPid = overRow.dataset.id;
  if (targetPid === pid) return;
  // v74: top-level rows reorder state.todoistProjects; a sub-list reorders its
  // own parent's child array. sdragMove already guaranteed they're siblings.
  const isTop = row.dataset.top === "1";
  const parentId = row.dataset.parent || null;
  const arr = isTop ? state.todoistProjects
                    : ((state.todoistByParent || {})[parentId] || []);
  const from = arr.findIndex(p => p.id === pid);
  if (from < 0) return;
  const [moved] = arr.splice(from, 1);
  let to = arr.findIndex(p => p.id === targetPid);
  if (to < 0) { arr.splice(from, 0, moved); return; }
  arr.splice(to + (after ? 1 : 0), 0, moved);
  if (isTop) {
    localStorage.setItem("hub.projectOrder", JSON.stringify(arr.map(p => p.id)));
  } else {
    const map = JSON.parse(localStorage.getItem("hub.subOrder") || "{}");
    map[parentId] = arr.map(p => p.id);
    localStorage.setItem("hub.subOrder", JSON.stringify(map));
  }
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

async function addTodoistTask(content, projectId, due, opts) {
  opts = opts || {};
  const body = { content };
  // v82: both casings, same reasoning as the due fields below.
  if (opts.assigneeId) {
    body.responsibleUid = opts.assigneeId;
    body.responsible_uid = opts.assigneeId;
  }
  if (opts.priority && opts.priority !== 1) body.priority = opts.priority;
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
  return todoistFetch("/tasks/quick", "POST", { text, meta: false });
}

/* v82: Todoist's quick-add parser always files into Inbox unless the text
   says "#List". The + sheet already knows which list it was opened on, so a
   task Todoist left in Inbox is moved there, and the sheet's default date
   (Today/Week) fills in only when the words didn't name a date. */
async function quickAddInto(text, projectId, defaultDate) {
  const t = await quickAddTask(text);
  if (!t || !t.id) return true;
  const pid = t.projectId || t.project_id;
  const inboxed = state.todoistInboxId ? pid === state.todoistInboxId : !/#\S/.test(text);
  try {
    if (projectId && inboxed && pid !== projectId) await moveTask(t.id, { project_id: projectId });
    if (defaultDate && !t.due) {
      await todoistFetch("/tasks/" + t.id, "POST", { dueDate: defaultDate, due_date: defaultDate });
    }
  } catch (_) {
    return false;
  }
  return true;
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
  /* v74: sub-lists are hand-orderable too. Todoist's child_order is the
     default; a saved per-parent order overrides it, exactly the way
     hub.projectOrder overrides it for top-level lists. Unknown/new children
     keep their child_order position at the end. */
  const savedSub = JSON.parse(localStorage.getItem("hub.subOrder") || "null");
  if (savedSub) {
    Object.keys(byParent).forEach(par => {
      const want = savedSub[par];
      if (!Array.isArray(want)) return;
      const arr = byParent[par];
      const idMap = Object.fromEntries(arr.map(c => [c.id, c]));
      byParent[par] = want.map(id => idMap[id]).filter(Boolean)
        .concat(arr.filter(c => !want.includes(c.id)));
    });
  }
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
    // v66: sort by time, not by whichever calendar's fetch happened to
    // resolve first — fetchRange awaits all calendars in parallel and
    // appends each one's whole batch as it lands, so unsorted entries read
    // as "grouped by calendar," not "how the day unfolds." All-day/untimed
    // events sort to the end, matching the Today tab's convention.
    const dayEvents = events.filter((x) => evDate(x.ev) === dISO).sort((a, b) => {
      const ta = parseItemTime(a.ev.start.dateTime);
      const tb = parseItemTime(b.ev.start.dateTime);
      if (!ta && !tb) return 0;
      if (!ta) return 1;
      if (!tb) return -1;
      return ta - tb;
    });
    const g = document.createElement("div");
    g.dataset.date = dISO; // v69: lets scrollWeekToToday() find today's group
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
  const spacer = document.createElement("div");
  spacer.className = "week-end-spacer"; // v71: room for the last day to reach the top on auto-scroll
  wk.append(spacer);
  syncWeeknavHeight(); // v70: keep sticky day-heads flush under .week-nav
}
// v70: scrolls so today's sticky day-head lands exactly where it's about to
// stick (right under .week-nav) — a no-op if the currently displayed week
// doesn't include today (weekOffset != 0, or today's group simply isn't in
// the DOM yet on a slow first load).
// v69 used head.scrollIntoView({block:"start"}), which fired synchronously
// right after unhiding the Week tab/rebuilding its DOM — before the browser
// had settled layout for the newly-visible sticky elements, so it silently
// no-op'd. Deferring one frame (rAF) lets layout catch up, and computing the
// scroll delta manually from getBoundingClientRect (rather than trusting
// scrollIntoView's own handling of sticky offsets) sidesteps cross-engine
// inconsistency in how sticky position interacts with scrollIntoView.
function scrollWeekToToday() {
  if (state.weekOffset !== 0) return;
  requestAnimationFrame(() => {
    syncWeeknavHeight();
    const g = document.querySelector('#week-list .day-group[data-date="' + todayISO() + '"]');
    const head = g && g.querySelector(".day-head");
    if (!head) return;
    const nav = document.querySelector(".week-nav");
    const navH = nav ? nav.getBoundingClientRect().height : 0;
    const delta = head.getBoundingClientRect().top - navH;
    if (Math.abs(delta) > 1) {
      const cur = window.scrollY || document.documentElement.scrollTop || 0;
      window.scrollTo({ top: Math.max(0, cur + delta), behavior: "auto" });
    }
  });
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
/* v82: the + used to open a menu whose contents changed per tab — Event,
   Reminder, Note, New list. Event needs Google, which is going away;
   Reminder is just a task with a time; Note had no handler at all and fell
   through to an unfiled Todoist task, i.e. the Inbox, which this app hides
   on purpose. One quietly lost note later, it is one action everywhere:
   add a task, to a list you can see and change. */
function defaultCaptureProject() {
  if (state.activeTab === "lists" && state.activeListId) {
    const ctx = groceryContext();
    // The Pantry is a lens, not a real list — a new item belongs in a store.
    if (ctx && ctx.pantry && state.activeListId === ctx.pantry.id && ctx.stores[0]) {
      return ctx.stores[0].id;
    }
    return state.activeListId;
  }
  // Today/Week have no list in view; default to Michael's own list.
  const mine = allProjectsFlat().find((p) => /^michael$/i.test(p.name));
  if (mine) return mine.id;
  const first = (state.todoistProjects || [])[0];
  return first ? first.id : null;
}

function openQuickAdd() {
  const projectId = defaultCaptureProject();
  const onList = state.activeTab === "lists";
  openCapSheet("task", onList ? "Add to this list\u2026" : "New task\u2026",
    projectId, onList ? null : todayISO());
}

/* v82: which list the task lands in, shown rather than assumed. The Note
   that vanished did so because nothing on screen said where it was going. */
function buildCapListChip(projectId) {
  const sel = $("cap-list-select");
  const txt = $("cap-list-txt");
  const chip = $("cap-list-chip");
  if (!sel || !chip) return;
  sel.innerHTML = "";
  const flat = allProjectsFlat();
  if (!flat.length) { chip.hidden = true; return; }
  flat.forEach((p) => {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = (p._depth ? "\u2014 " : "") + p.name;
    if (p.id === projectId) o.selected = true;
    sel.appendChild(o);
  });
  const chosen = flat.find((p) => p.id === projectId) || flat[0];
  txt.textContent = chosen ? chosen.name : "List";
  chip.hidden = false;
  sel.onchange = () => {
    const p = flat.find((x) => x.id === sel.value);
    $("cap-sheet").dataset.project = sel.value;
    txt.textContent = p ? p.name : "List";
    buildCapOwnerChip(sel.value);   // shared-ness may have changed
  };
}

const CAP_PRIORITIES = [
  { v: "1", label: "No priority" },
  { v: "4", label: "Priority 1" },
  { v: "3", label: "Priority 2" },
  { v: "2", label: "Priority 3" },
];
function buildCapPriorityChip() {
  const sel = $("cap-pri-select");
  const txt = $("cap-pri-txt");
  const chip = $("cap-pri-chip");
  if (!sel || !chip) return;
  sel.innerHTML = "";
  CAP_PRIORITIES.forEach((p) => {
    const o = document.createElement("option");
    o.value = p.v; o.textContent = p.label;
    sel.appendChild(o);
  });
  sel.value = "1";
  txt.textContent = "No priority";
  chip.hidden = false;
  sel.onchange = () => {
    $("cap-sheet").dataset.priority = sel.value;
    const p = CAP_PRIORITIES.find((x) => x.v === sel.value);
    txt.textContent = p ? p.label : "No priority";
  };
}

/* Assigning only works on a SHARED project — on a personal one there is
   nobody to assign to, and Todoist rejects it. So the chip appears only
   where it can actually do something, rather than failing after the fact. */
async function buildCapOwnerChip(projectId) {
  const sel = $("cap-own-select");
  const txt = $("cap-own-txt");
  const chip = $("cap-own-chip");
  if (!sel || !chip) return;
  chip.hidden = true;
  $("cap-sheet").dataset.assignee = "";
  if (!projectId) return;
  let people = {};
  try { people = await ensureCollaborators(projectId); } catch (_) { return; }
  const ids = Object.keys(people || {});
  if (ids.length < 2) return;            // personal list: no one to assign to
  if ($("cap-sheet").dataset.project !== projectId) return;  // list changed meanwhile
  sel.innerHTML = "";
  const none = document.createElement("option");
  none.value = ""; none.textContent = "Anyone";
  sel.appendChild(none);
  ids.forEach((id) => {
    const o = document.createElement("option");
    o.value = id;
    o.textContent = (people[id] || "").split(" ")[0] || people[id] || id;
    sel.appendChild(o);
  });
  sel.value = "";
  txt.textContent = "Anyone";
  chip.hidden = false;
  sel.onchange = () => {
    $("cap-sheet").dataset.assignee = sel.value;
    const opt = sel.options[sel.selectedIndex];
    txt.textContent = opt ? opt.textContent : "Anyone";
  };
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
  sheet.dataset.assignee = "";
  sheet.dataset.priority = "1";   // Todoist: 1 = p4 (none), 4 = p1
  sheet.dataset.openDate = "";
  buildCapListChip(projectId);
  buildCapPriorityChip();
  buildCapOwnerChip(projectId);   // async; hides itself on a personal list

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
    sheet.dataset.openDate = defaultDate;
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
    if (!getTodoistToken()) { toast("Set a Todoist token in Settings first"); return; }
    let due = null;
    // v63: lock the explicit local calendar date alongside the UTC instant
    // (see addTodoistTask) — the actual fix for "timed tasks added for Today
    // don't show up."
    if (chipDate && chipTime) due = { date: chipDate, datetime: localToUTCISO(chipDate, chipTime) };
    else if (chipDate) due = { date: chipDate };

    const opts = {
      assigneeId: sheet.dataset.assignee || null,
      priority: Number(sheet.dataset.priority || 1),
    };
    // v82: with an explicit list, date, owner or priority on screen, honour
    // them. Only a bare title goes through Todoist's own parser, which reads
    // "dentist tue 3pm" and "#Groceries" out of the text itself.
    // The date chip counts as "set" only if it was changed from what the
    // sheet opened with (Today/Week open pre-set to today).
    const openDate = sheet.dataset.openDate || "";
    const plain = chipDate === openDate && !chipTime && !opts.assigneeId && opts.priority === 1;
    if (plain) {
      let landed = true;
      try { landed = await quickAddInto(value, projectId, openDate); }
      catch (_) { await addTodoistTask(value, projectId, due, opts); }
      if (landed === false) { toast("Added, but it may be sitting in Inbox"); closeFab(); return; }
    } else {
      await addTodoistTask(value, projectId, due, opts);
    }
    toast("Added!");
    closeFab();
    if (state.activeTab === "lists") loadTasks();
    if (state.activeTab === "today") renderToday();
    if (state.activeTab === "week") renderWeek();
  } catch (e) {
    if (String(e.message).startsWith("cal-403")) {
      toast("Re-connect Google Calendar access, then try again");
      requestToken(true);
    } else {
      toast("Couldn't save — check Todoist token in Settings");
    }
  }
}

async function addCalendarEvent(title, dateISO, timeHHMM) {
  // v79: calendar feeds are read-only. Creating an event is the one thing
  // that still needs a Google token, so fail with an explanation rather
  // than a generic error.
  if (!state.token) {
    toast("Adding events needs Google — sign in from Settings");
    throw new Error("no-google");
  }
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

/* ---------- household sync (v81) ----------
   The Drive backup only runs when a Google token happens to exist, which on
   the feeds path it often doesn't. Without a replacement, losing browser
   storage loses the Todoist token AND the calendar feeds, and Sasha's phone
   would need everything typed in by hand.

   So: a household passphrase. It is stretched with PBKDF2 into 64 bytes —
   the first half encrypts the settings, the second half names the bucket
   they are stored under. Both halves stay on the device. The Worker receives
   an opaque blob and a bucket id and can decrypt neither, so someone who
   learned a bucket id would get ciphertext.

   The passphrase itself is never stored, only the derived bytes, so it
   cannot be read back off a device. The same phrase on another phone derives
   the same bucket and the same key — that is the whole sharing mechanism. */
const SYNC_KEY = "hub.syncKey";      // base64 of the 64 derived bytes
const SYNC_SALT = "mcqueen-hub-sync-v1";
const SYNC_ITERATIONS = 200000;

const b64 = (bytes) => {
  let out = "";
  bytes.forEach((b) => { out += String.fromCharCode(b); });
  return btoa(out);
};
const unb64 = (str) => {
  const bin = atob(str);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
};
const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

async function deriveSyncBytes(passphrase) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(SYNC_SALT), iterations: SYNC_ITERATIONS, hash: "SHA-256" },
    base, 512);
  return new Uint8Array(bits);
}

const syncBytes = () => {
  const v = localStorage.getItem(SYNC_KEY);
  return v ? unb64(v) : null;
};
const syncOn = () => !!localStorage.getItem(SYNC_KEY);
const syncBucket = (bytes) => toHex(bytes.slice(32, 64));
const syncUrl = (bucket) => CONFIG.TODOIST + "/settings/" + bucket;

async function syncEncrypt(obj, bytes) {
  const key = await crypto.subtle.importKey("raw", bytes.slice(0, 32), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key,
    new TextEncoder().encode(JSON.stringify(obj)));
  return JSON.stringify({ v: 1, iv: b64(iv), ct: b64(new Uint8Array(ct)) });
}

async function syncDecrypt(text, bytes) {
  let env;
  try { env = JSON.parse(text); } catch (_) { throw new Error("bad-blob"); }
  if (!env || env.v !== 1 || !env.iv || !env.ct) throw new Error("bad-blob");
  const key = await crypto.subtle.importKey("raw", bytes.slice(0, 32), "AES-GCM", false, ["decrypt"]);
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(env.iv) }, key, unb64(env.ct));
  } catch (_) {
    // AES-GCM authenticates, so a wrong key fails here rather than quietly
    // yielding garbage. That makes this the reliable "wrong passphrase" signal.
    throw new Error("bad-passphrase");
  }
  return JSON.parse(new TextDecoder().decode(plain));
}

async function syncPushNow() {
  const bytes = syncBytes();
  if (!bytes) return;
  const payload = settingsPayload();
  payload.savedAt = Date.now();
  localStorage.setItem("hub.settingsAt", String(payload.savedAt));
  const body = await syncEncrypt(payload, bytes);
  const r = await fetch(syncUrl(syncBucket(bytes)), { method: "PUT", body });
  if (!r.ok) throw new Error("sync-" + r.status);
  localStorage.setItem("hub.syncAt", String(Date.now()));
}

let _syncTimer = null;
function syncPush() {
  if (!syncOn()) return;
  clearTimeout(_syncTimer);
  // Coalesce: toggling six lists in a row is one upload, not six.
  _syncTimer = setTimeout(() => {
    syncPushNow().catch((e) => console.warn("settings sync failed", e));
  }, 1500);
}

/* "applied" | "current" | "empty". Newest wins by savedAt, so a phone that
   has been offline cannot overwrite fresher settings from the other one
   merely by opening later. */
async function syncPull() {
  const bytes = syncBytes();
  if (!bytes) return "empty";
  const r = await fetch(syncUrl(syncBucket(bytes)));
  if (r.status === 404) return "empty";
  if (!r.ok) throw new Error("sync-" + r.status);
  const remote = await syncDecrypt(await r.text(), bytes);
  const localAt = Number(localStorage.getItem("hub.settingsAt") || 0);
  if (!(remote.savedAt > localAt)) return "current";
  applySettings(remote);
  localStorage.setItem("hub.syncAt", String(Date.now()));
  return "applied";
}

async function syncConnect(passphrase) {
  const bytes = await deriveSyncBytes(passphrase);
  localStorage.setItem(SYNC_KEY, b64(bytes));
  try {
    const res = await syncPull();
    if (res === "empty") { await syncPushNow(); return "seeded"; }  // first device
    return res;
  } catch (e) {
    localStorage.removeItem(SYNC_KEY);   // never leave a half-connected state
    throw e;
  }
}

function saveSettingsToDrive() {
  syncPush();   // v81: sync alongside the Drive backup, not instead of it
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

// v81: one definition of "the settings", shared by the Drive backup and the
// household sync, so the two can never drift apart.
function settingsPayload() {
  return {
    calsOff: [...state.calsOff],
    projectsOff: JSON.parse(localStorage.getItem("hub.projectsOff") || "[]"),
    projectOrder: JSON.parse(localStorage.getItem("hub.projectOrder") || "null"),
    calFeeds: getFeeds(), // v79
    subOrder: JSON.parse(localStorage.getItem("hub.subOrder") || "null"), // v74
    inventoryMode: getInventoryOverrides(),
    activeListId: state.activeListId,
    todoistToken: getTodoistToken(),
    savedAt: Number(localStorage.getItem("hub.settingsAt") || 0) || Date.now(),
  };
}

// v81: apply a settings payload, wherever it came from.
function applySettings(data) {
  if (!data) return;
  if (data.calsOff) localStorage.setItem("hub.calsOff", JSON.stringify(data.calsOff));
  if (data.projectsOff) localStorage.setItem("hub.projectsOff", JSON.stringify(data.projectsOff));
  if (data.projectOrder) localStorage.setItem("hub.projectOrder", JSON.stringify(data.projectOrder));
  if (data.subOrder) localStorage.setItem("hub.subOrder", JSON.stringify(data.subOrder));
  if (data.inventoryMode) localStorage.setItem("hub.inventoryMode", JSON.stringify(data.inventoryMode));
  if (data.activeListId) localStorage.setItem("hub.activeList", data.activeListId);
  if (data.todoistToken) localStorage.setItem("hub.todoistToken", data.todoistToken);
  if (data.calFeeds) localStorage.setItem("hub.calFeeds", JSON.stringify(data.calFeeds));
  if (data.savedAt) localStorage.setItem("hub.settingsAt", String(data.savedAt));
  state.calsOff = new Set(JSON.parse(localStorage.getItem("hub.calsOff") || "[]"));
  state.activeListId = localStorage.getItem("hub.activeList") || null;
}

async function saveSettingsToDriveImpl() {
  if (!state.token) return;
  const payload = settingsPayload();
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
    if (data.calFeeds) localStorage.setItem("hub.calFeeds", JSON.stringify(data.calFeeds)); // v79
    if (data.subOrder) localStorage.setItem("hub.subOrder", JSON.stringify(data.subOrder)); // v74
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
    { label: "Household sync", page: "sync" }, // v81
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

/* v79: Calendars settings — feeds first, Google only as the fallback.

   A feed URL is a credential (anyone holding it can read that calendar),
   so it is never rendered into the page as text; only the calendar's own
   name is shown. Each URL is checked by actually fetching it when added,
   so a typo is caught here rather than showing up as a silently empty
   Week tab days later. */
function feedIdFor(url) {
  let h = 0;
  for (let i = 0; i < url.length; i++) { h = (h * 31 + url.charCodeAt(i)) | 0; }
  return "feed" + (h >>> 0).toString(36);
}

function renderCalendarSettings(body) {
  const feeds = getFeeds();

  const label = document.createElement("div");
  label.className = "settings-section-label";
  label.textContent = "Calendar feeds";
  body.append(label);

  const hint = document.createElement("div");
  hint.className = "settings-hint";
  hint.textContent = feeds.length
    ? "Reading from these feeds. No Google sign-in needed."
    : "In Google Calendar: a calendar's Settings \u2192 Integrate calendar \u2192 " +
      "\u201cSecret address in iCal format\u201d. Paste one per line below. " +
      "Once a feed is added the app stops asking you to sign in to Google.";
  body.append(hint);

  const list = document.createElement("div");
  body.append(list);

  const drawList = () => {
    list.innerHTML = "";
    getFeeds().forEach((f) => {
      const row = document.createElement("label"); row.className = "cal-row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !state.calsOff.has(f.id);
      cb.addEventListener("change", () => {
        cb.checked ? state.calsOff.delete(f.id) : state.calsOff.add(f.id);
        localStorage.setItem("hub.calsOff", JSON.stringify([...state.calsOff]));
        saveSettingsToDrive();
        state.ranges = {};
        renderToday(); renderWeek();
      });
      const name = document.createElement("span");
      name.style.flex = "1";
      name.textContent = f.name || "Calendar";
      if ((state.feedErrors || {})[f.id]) {
        name.textContent += "  \u26a0\ufe0e couldn't load";
        name.style.color = "var(--muted)";
      }
      const del = document.createElement("button");
      del.className = "settings-btn-secondary";
      del.style.flex = "0 0 auto";
      del.textContent = "Remove";
      del.addEventListener("click", (e) => {
        e.preventDefault();
        setFeeds(getFeeds().filter((x) => x.id !== f.id));
        delete (state.feedCache || {})[f.url];
        state.ranges = {};
        drawList();
        toast("Feed removed");
        renderToday(); renderWeek();
      });
      row.append(cb, name, del);
      list.append(row);
    });
  };
  drawList();

  const addLabel = document.createElement("div");
  addLabel.className = "settings-section-label";
  addLabel.style.marginTop = "16px";
  addLabel.textContent = feeds.length ? "Add more" : "Add feeds";
  body.append(addLabel);

  const ta = document.createElement("textarea");
  ta.className = "settings-token-input";
  ta.rows = 4;
  ta.placeholder = "https://calendar.google.com/calendar/ical/.../basic.ics\none per line";
  ta.style.fontSize = "16px"; // v60: anything smaller makes iOS zoom the page
  body.append(ta);

  const status = document.createElement("div");
  status.className = "settings-hint";
  body.append(status);

  const actions = document.createElement("div");
  actions.className = "settings-token-actions";
  const add = document.createElement("button");
  add.className = "settings-btn-primary";
  add.textContent = "Add feeds";
  actions.append(add);
  body.append(actions);

  add.addEventListener("click", async () => {
    const urls = ta.value.split(/\s+/).map((u) => u.trim()).filter(Boolean);
    if (!urls.length) { status.textContent = "Paste at least one feed address."; return; }
    add.disabled = true;
    const existing = getFeeds();
    const added = [];
    const problems = [];
    for (const url of urls) {
      if (existing.some((f) => f.url === url)) { problems.push("already added"); continue; }
      try {
        const info = await probeFeed(url);      // real fetch: catches typos now
        added.push({ id: feedIdFor(url), url, name: info.name });
        status.textContent = "Added " + info.name + " (" + info.events + " entries)";
      } catch (e) {
        const why = String(e.message) === "not-a-calendar" ? "that address didn't return a calendar"
          : /feed-4/.test(String(e.message)) ? "the address was rejected \u2014 check you copied all of it"
          : "couldn't reach it";
        problems.push(why);
      }
    }
    add.disabled = false;
    if (added.length) {
      setFeeds(existing.concat(added));
      ta.value = "";
      state.ranges = {};
      state.cals = getFeeds().map((f) => ({ id: f.id, summary: f.name || "Calendar" }));
      drawList();
      // v80: if this was done from the sign-in screen, the app has never
      // started. Start it now rather than leaving a working setup behind a
      // sign-in screen it no longer needs.
      if ($("screen-main").hidden) {
        showMain();
        boot();
      } else {
        renderToday(); renderWeek();
      }
    }
    if (problems.length) {
      status.textContent = (added.length ? "Added " + added.length + ". " : "") +
        problems.length + " didn't work: " + problems.join("; ");
    } else if (added.length) {
      status.textContent = "Added " + added.length + " feed" + (added.length > 1 ? "s" : "") + ".";
    }
  });

  // Google calendars remain available until feeds take over, so nothing is
  // lost mid-migration.
  if (!feeds.length && state.cals && state.cals.length) {
    const gl = document.createElement("div");
    gl.className = "settings-section-label";
    gl.style.marginTop = "20px";
    gl.textContent = "Google calendars";
    body.append(gl);
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
}

/* v81: Household sync settings.

   The passphrase is the only thing standing between the settings blob and
   anyone who can reach the Worker, so the copy has to make that clear
   without lecturing. It is never stored — only the bytes derived from it —
   so there is no "show passphrase" and no way to recover it from a device.
   Losing it means picking a new one and setting up once more. */
function renderSyncSettings(body) {
  const connected = syncOn();

  const blurb = document.createElement("div");
  blurb.className = "settings-hint";
  blurb.textContent = connected
    ? "This device is syncing. Enter the same phrase on another phone and it picks up these settings \u2014 lists, calendar feeds and the Todoist token."
    : "Keeps your settings \u2014 lists, calendar feeds, Todoist token \u2014 backed up and shared across phones. " +
      "Pick a phrase of a few words you'll remember. It never leaves this device: it's used to scramble the " +
      "backup so only your phones can read it. It can't be recovered, so if you forget it you just pick a new one.";
  body.append(blurb);

  if (connected) {
    const at = Number(localStorage.getItem("hub.syncAt") || 0);
    const when = document.createElement("div");
    when.className = "settings-hint";
    when.textContent = at ? "Last synced " + fmt(new Date(at), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
                          : "Not synced yet.";
    body.append(when);

    const status = document.createElement("div");
    status.className = "settings-hint";
    body.append(status);

    const actions = document.createElement("div");
    actions.className = "settings-token-actions";
    const now = document.createElement("button");
    now.className = "settings-btn-primary";
    now.textContent = "Sync now";
    const off = document.createElement("button");
    off.className = "settings-btn-secondary";
    off.textContent = "Disconnect";
    actions.append(off, now);
    body.append(actions);

    now.addEventListener("click", async () => {
      now.disabled = true; status.textContent = "Syncing\u2026";
      try {
        const res = await syncPull();
        await syncPushNow();
        status.textContent = res === "applied" ? "Updated from your other device." : "Up to date.";
        when.textContent = "Last synced just now";
        if (res === "applied") {
          state.ranges = {};
          state.cals = getFeeds().map((f) => ({ id: f.id, summary: f.name || "Calendar" }));
          renderToday(); renderWeek();
        }
      } catch (e) {
        status.textContent = String(e.message) === "bad-passphrase"
          ? "That stored key no longer matches the backup. Disconnect and reconnect with the right phrase."
          : "Couldn't sync \u2014 try again.";
      }
      now.disabled = false;
    });

    off.addEventListener("click", () => {
      localStorage.removeItem(SYNC_KEY);
      toast("Sync disconnected on this device");
      openSettingsPage("sync");
    });
    return;
  }

  const input = document.createElement("input");
  input.type = "password";
  input.className = "settings-token-input";
  input.placeholder = "Household phrase\u2026";
  input.autocomplete = "off";
  body.append(input);

  const status = document.createElement("div");
  status.className = "settings-hint";
  body.append(status);

  const actions = document.createElement("div");
  actions.className = "settings-token-actions";
  const go = document.createElement("button");
  go.className = "settings-btn-primary";
  go.textContent = "Connect";
  actions.append(go);
  body.append(actions);

  go.addEventListener("click", async () => {
    const phrase = input.value.trim();
    if (phrase.length < 8) {
      status.textContent = "Use at least 8 characters \u2014 a few words is ideal.";
      return;
    }
    go.disabled = true;
    status.textContent = "Connecting\u2026";   // PBKDF2 takes a moment on a phone
    try {
      const res = await syncConnect(phrase);
      input.value = "";
      if (res === "seeded") toast("Sync on \u2014 this device's settings are now the backup");
      else if (res === "applied") toast("Sync on \u2014 settings restored");
      else toast("Sync on \u2014 already up to date");
      if (res === "applied") {
        state.ranges = {};
        state.cals = getFeeds().map((f) => ({ id: f.id, summary: f.name || "Calendar" }));
        if ($("screen-main").hidden) { showMain(); boot(); }
        else { renderToday(); renderWeek(); if (state.activeTab === "lists") renderLists(); }
      }
      openSettingsPage("sync");
    } catch (e) {
      go.disabled = false;
      status.textContent = String(e.message) === "bad-passphrase"
        ? "That phrase doesn't match the existing backup. Check it and try again."
        : "Couldn't reach the backup \u2014 check your connection and try again.";
    }
  });
}

function openSettingsPage(page) {
  $("settings-back").hidden = false;
  const body = $("settings-body");
  body.innerHTML = "";

  if (page === "calendars") {
    $("settings-title").textContent = "Calendars";
    renderCalendarSettings(body);
  }

  if (page === "sync") {
    $("settings-title").textContent = "Household sync";
    renderSyncSettings(body);
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

    // v82: "New list" used to live in the + menu. The + is one action now,
    // so list creation belongs with the rest of the list settings.
    const newLabel = document.createElement("div");
    newLabel.className = "settings-section-label";
    newLabel.style.marginTop = "20px";
    newLabel.textContent = "New list";
    body.append(newLabel);
    const newWrap = document.createElement("div");
    newWrap.className = "settings-token-actions";
    const newInput = document.createElement("input");
    newInput.type = "text";
    newInput.className = "settings-token-input";
    newInput.placeholder = "List name\u2026";
    newInput.style.flex = "2";
    const newBtn = document.createElement("button");
    newBtn.className = "settings-btn-primary";
    newBtn.style.flex = "1";
    newBtn.textContent = "Create";
    newWrap.append(newInput, newBtn);
    body.append(newWrap);
    newBtn.addEventListener("click", async () => {
      const name = newInput.value.trim();
      if (!name) return;
      newBtn.disabled = true;
      try {
        await createTodoistProject(name);
        newInput.value = "";
        toast("List created");
        await renderLists();
        openSettingsPage("lists");   // redraw with the new list in place
      } catch (_) {
        toast("Couldn't create the list \u2014 Todoist may be at its project limit");
      }
      newBtn.disabled = false;
    });

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
      hint.textContent = "Hold + drag a list to reorder. Sub-lists reorder within their own parent. ♻︎ = inventory list: checked items stay visible.";
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
          row.dataset.parent = p.parentId || p.parent_id || ""; // v74: siblings only
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
          attachSettingsDrag(row, p.id); // v74: sub-lists drag too
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
  if (tab === "week") scrollWeekToToday(); // v69
  updateWakeLock();
  if (state.fabOpen) closeFab(); // v82: no per-tab menu to refresh; a tab
                                 // change while capturing just cancels it
}

/* ---------- UI wiring ---------- */
function showSignin() { $("screen-signin").hidden = false; $("screen-main").hidden = true; }
function showMain() { $("screen-signin").hidden = true; $("screen-main").hidden = false; }
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => { t.hidden = true; }, 3500);
}

function wireUI() {
  // v78: ask for the QUIET flow first — the popup carries the live Google
  // session, so an existing grant returns a token with no consent screen.
  $("btn-signin").addEventListener("click", () => requestToken(false));
  // v80: the settings modal is a sibling of both screens, so it opens fine
  // over the sign-in screen. Straight to Calendars — that is the only thing
  // worth doing from here.
  $("btn-signin-feeds").addEventListener("click", () => {
    openSettings();
    openSettingsPage("calendars");
  });
  $("btn-settings").addEventListener("click", openSettings);
  $("settings-back").addEventListener("click", openSettings);
  $("settings-close").addEventListener("click", closeSettings);
  $("settings").addEventListener("click", (e) => { if (e.target === $("settings")) closeSettings(); });

  $("week-prev").addEventListener("click", () => { state.weekOffset--; renderWeek(); });
  $("week-next").addEventListener("click", () => { state.weekOffset++; renderWeek(); });
  $("week-today").addEventListener("click", () => { state.weekOffset = 0; renderWeek().then(scrollWeekToToday); }); // v69

  // Tab bar divs
  ["today", "week", "lists"].forEach(t => {
    const el = $("tb-" + t);
    if (el) el.addEventListener("click", () => switchTab(t));
  });

  // FAB
  // v82: straight into the task sheet — no menu to choose from.
  $("tb-add").addEventListener("click", () => {
    if (state.fabOpen) { closeFab(); return; }
    if (!getTodoistToken()) { toast("Set a Todoist token in Settings first"); return; }
    openFab();
    openQuickAdd();
  });
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
    if (!document.hidden) {
      flushOutbox(); // v75: coming back to the app is a chance to sync
      if (syncOn()) syncPull().catch(() => {});            // v81
      if (usingFeeds()) refreshAll();                      // v79: no token needed
      else if (localStorage.getItem("hub.authed") === "1" && ensureToken()) refreshAll();
    }
  });
  window.addEventListener("online", flushOutbox); // v75

  wirePullToRefresh();
  wireDrag();
}

window.addEventListener("load", () => {
  wireUI();
  // v79: with calendar feeds configured, nothing on the launch path needs
  // Google — so show the app immediately instead of a sign-in screen.
  // Sign-in stays available in Settings for the features that still use it.
  if (usingFeeds()) {
    showMain();
    boot();
    return;
  }
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

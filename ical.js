/* McQueen Hub — iCalendar (.ics) reading.
   ------------------------------------------------------------------
   Replaces the Google Calendar API as the source for Today/Week. The
   whole design constraint is one line: EMIT EVENTS IN THE SAME SHAPE
   GOOGLE'S API RETURNS. Everything downstream (renderToday, renderWeek,
   eventRow, evDate, evTime, the brief lookup) then needs no changes.

   That shape, for the fields the app actually reads:
     { summary, description, id, iCalUID,
       start: { date: "YYYY-MM-DD" }            // all-day
            | { dateTime: "YYYY-MM-DDTHH:MM:SS-07:00" },
       end:   { ... same ... } }

   Note the OFFSET form, not "Z". evDate() does start.dateTime.slice(0,10)
   to get the day, so a UTC timestamp would put a 6pm Pacific event on the
   following day. Google returns local-offset strings; so do we.

   No DOM, no globals beyond ICAL — this file is unit-tested on its own. */
"use strict";

const ICAL = (() => {

  /* ---------- line unfolding + property parsing ---------- */

  // RFC 5545 folds long lines by inserting CRLF + one space/tab.
  function unfold(text) {
    return String(text || "")
      .replace(/\r\n/g, "\n").replace(/\r/g, "\n")
      .replace(/\n[ \t]/g, "")
      .split("\n")
      .filter((l) => l.length > 0);
  }

  // NAME;PARAM=value;Q="quoted:value":THE VALUE
  function parseLine(line) {
    let i = 0, inQuote = false;
    for (; i < line.length; i++) {
      const c = line[i];
      if (c === '"') inQuote = !inQuote;
      else if (c === ":" && !inQuote) break;
    }
    if (i >= line.length) return null;
    const head = line.slice(0, i);
    const value = line.slice(i + 1);
    const parts = [];
    let cur = "", q = false;
    for (const c of head) {
      if (c === '"') { q = !q; continue; }
      if (c === ";" && !q) { parts.push(cur); cur = ""; continue; }
      cur += c;
    }
    parts.push(cur);
    const name = parts.shift().toUpperCase();
    const params = {};
    parts.forEach((p) => {
      const eq = p.indexOf("=");
      if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
    });
    return { name, params, value };
  }

  // TEXT values escape these; order matters (backslash last).
  function unescapeText(v) {
    return String(v || "")
      .replace(/\\n/gi, "\n")
      .replace(/\\,/g, ",")
      .replace(/\;/g, ";")
      .replace(/\\\\/g, "\\");
  }

  /* ---------- time zones ----------
     An ICS local time plus a TZID is not an instant until you know the
     offset in force AT that moment. Rather than ship a timezone database,
     ask the engine: format a candidate instant in the target zone, read
     back the wall-clock it produces, and correct by the difference. Two
     passes settle DST boundaries. */

  const _dtfCache = {};
  function dtf(tz) {
    if (!_dtfCache[tz]) {
      _dtfCache[tz] = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hour12: false,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
    }
    return _dtfCache[tz];
  }

  // What wall-clock does `instant` show as, in `tz`? -> ms since epoch of
  // that wall-clock read as if it were UTC.
  function wallClockMs(instant, tz) {
    const p = {};
    for (const { type, value } of dtf(tz).formatToParts(instant)) p[type] = value;
    return Date.UTC(+p.year, +p.month - 1, +p.day,
                    +p.hour % 24, +p.minute, +p.second);
  }

  function offsetMs(instant, tz) {
    return wallClockMs(instant, tz) - instant.getTime();
  }

  // "20260924T090000" in `tz` -> Date (a true instant).
  function zonedToInstant(y, mo, d, h, mi, s, tz) {
    const asUTC = Date.UTC(y, mo - 1, d, h, mi, s);
    let guess = new Date(asUTC - offsetMs(new Date(asUTC), tz));
    // One correction pass handles the DST-transition cases.
    guess = new Date(asUTC - offsetMs(guess, tz));
    return guess;
  }

  function pad(n, w) { return String(Math.abs(n)).padStart(w || 2, "0"); }

  // Instant -> "YYYY-MM-DDTHH:MM:SS-07:00" in `tz`, matching Google.
  function instantToLocalISO(instant, tz) {
    const off = offsetMs(instant, tz);
    const w = new Date(instant.getTime() + off);
    const sign = off < 0 ? "-" : "+";
    const mins = Math.round(Math.abs(off) / 60000);
    return w.getUTCFullYear() + "-" + pad(w.getUTCMonth() + 1) + "-" + pad(w.getUTCDate()) +
      "T" + pad(w.getUTCHours()) + ":" + pad(w.getUTCMinutes()) + ":" + pad(w.getUTCSeconds()) +
      sign + pad(Math.floor(mins / 60)) + ":" + pad(mins % 60);
  }

  function instantToLocalDate(instant, tz) {
    return instantToLocalISO(instant, tz).slice(0, 10);
  }

  /* ---------- DTSTART / DTEND / EXDATE values ---------- */

  // Returns { allDay, instant, y, mo, d } — instant is null for all-day,
  // where a calendar date is the truth and has no single instant.
  function parseDateValue(value, params, defaultTz) {
    const v = String(value || "").trim();
    const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
    if (dateOnly || (params.VALUE || "").toUpperCase() === "DATE") {
      const m = dateOnly || /^(\d{4})(\d{2})(\d{2})/.exec(v);
      if (!m) return null;
      return { allDay: true, instant: null, y: +m[1], mo: +m[2], d: +m[3] };
    }
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
    if (!m) return null;
    const [, Y, MO, D, H, MI, S, Z] = m;
    if (Z) {
      return { allDay: false, instant: new Date(Date.UTC(+Y, +MO - 1, +D, +H, +MI, +S)) };
    }
    // TZID when given; otherwise "floating" — treat as the display zone,
    // which is what a household calendar means by a bare local time.
    const tz = params.TZID || defaultTz;
    let inst;
    try { inst = zonedToInstant(+Y, +MO, +D, +H, +MI, +S, tz); }
    catch (_) { inst = zonedToInstant(+Y, +MO, +D, +H, +MI, +S, defaultTz); }
    return { allDay: false, instant: inst };
  }

  /* ---------- parse ---------- */

  function parse(text, defaultTz) {
    const tz = defaultTz || "UTC";
    const lines = unfold(text);
    const out = { calName: "", events: [] };
    let cur = null, depth = 0;

    for (const raw of lines) {
      const p = parseLine(raw);
      if (!p) continue;

      if (p.name === "BEGIN") {
        if (p.value === "VEVENT") { cur = { exdates: [] }; depth = 0; }
        else if (cur) depth++;          // VALARM etc. inside an event
        continue;
      }
      if (p.name === "END") {
        if (p.value === "VEVENT") { if (cur) out.events.push(cur); cur = null; }
        else if (cur) depth--;
        continue;
      }
      if (!cur) {
        // Calendar-level: the feed names itself, so the app doesn't have to.
        if (p.name === "X-WR-CALNAME") out.calName = unescapeText(p.value).trim();
        continue;
      }
      if (depth > 0) continue;          // ignore alarm properties

      switch (p.name) {
        case "UID": cur.uid = p.value.trim(); break;
        case "SUMMARY": cur.summary = unescapeText(p.value); break;
        case "DESCRIPTION": cur.description = unescapeText(p.value); break;
        case "LOCATION": cur.location = unescapeText(p.value); break;
        case "STATUS": cur.status = p.value.trim().toUpperCase(); break;
        case "SEQUENCE": cur.sequence = parseInt(p.value, 10) || 0; break;
        case "RRULE": cur.rrule = parseRRule(p.value); break;
        case "DTSTART": cur.start = parseDateValue(p.value, p.params, tz); break;
        case "DTEND": cur.end = parseDateValue(p.value, p.params, tz); break;
        case "DURATION": cur.duration = parseDuration(p.value); break;
        case "RECURRENCE-ID": cur.recurrenceId = parseDateValue(p.value, p.params, tz); break;
        case "EXDATE":
          p.value.split(",").forEach((v) => {
            const d = parseDateValue(v, p.params, tz);
            if (d) cur.exdates.push(d);
          });
          break;
        default: break;
      }
    }
    return out;
  }

  function parseRRule(v) {
    const r = {};
    String(v || "").split(";").forEach((kv) => {
      const eq = kv.indexOf("=");
      if (eq < 0) return;
      const k = kv.slice(0, eq).toUpperCase();
      const val = kv.slice(eq + 1);
      if (k === "FREQ") r.freq = val.toUpperCase();
      else if (k === "INTERVAL") r.interval = Math.max(1, parseInt(val, 10) || 1);
      else if (k === "COUNT") r.count = parseInt(val, 10) || 0;
      else if (k === "UNTIL") r.until = val;
      else if (k === "BYDAY") r.byday = val.toUpperCase().split(",");
      else if (k === "BYMONTHDAY") r.bymonthday = val.split(",").map(Number);
      else if (k === "BYMONTH") r.bymonth = val.split(",").map(Number);
      else if (k === "WKST") r.wkst = val.toUpperCase();
    });
    r.interval = r.interval || 1;
    return r.freq ? r : null;
  }

  function parseDuration(v) {
    const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(v || "").trim());
    if (!m) return null;
    const sign = m[1] === "-" ? -1 : 1;
    const ms = ((+m[2] || 0) * 604800 + (+m[3] || 0) * 86400 +
                (+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) * 1000;
    return sign * ms;
  }

  /* ---------- recurrence ---------- */

  const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

  function dayMatches(byday, dow) {
    // Entries may carry an ordinal ("3TU"); the ordinal is checked elsewhere.
    return byday.some((b) => b.slice(-2) === DAYS[dow]);
  }

  // nth weekday within a month: "3TU" = 3rd Tuesday, "-1FR" = last Friday.
  function ordinalMatches(byday, y, mo, d) {
    const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
    return byday.some((b) => {
      const code = b.slice(-2);
      if (code !== DAYS[dow]) return false;
      const ord = parseInt(b.slice(0, -2), 10);
      if (!ord) return true;                   // no ordinal: any such weekday
      if (ord > 0) return Math.ceil(d / 7) === ord;
      const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      return Math.ceil((last - d + 1) / 7) === -ord;
    });
  }

  const MAX_ITER = 2000;   // guards a malformed or absurd rule

  /* Occurrence start instants (or {y,mo,d} for all-day) that fall within
     [from, to]. Returns an array of "keys" plus the shifted start. */
  function occurrences(ev, fromMs, toMs, tz) {
    const res = [];
    if (!ev.start) return res;
    const allDay = ev.start.allDay;

    const startMs = allDay
      ? Date.UTC(ev.start.y, ev.start.mo - 1, ev.start.d)
      : ev.start.instant.getTime();

    if (!ev.rrule) {
      // fromMs/toMs arrive already padded by expand(); do not pad again.
      if (startMs >= fromMs && startMs <= toMs) res.push(startMs);
      return res;
    }

    const r = ev.rrule;
    let untilMs = Infinity;
    if (r.until) {
      const u = parseDateValue(r.until, {}, tz);
      if (u) untilMs = u.allDay ? Date.UTC(u.y, u.mo - 1, u.d) : u.instant.getTime();
    }

    // Walk in the event's own wall-clock so DST doesn't drift the time:
    // decompose the start, step the calendar fields, recompose.
    const base = new Date(startMs + (allDay ? 0 : offsetMs(new Date(startMs), tz)));
    const bY = base.getUTCFullYear(), bMo = base.getUTCMonth() + 1, bD = base.getUTCDate();
    const bH = base.getUTCHours(), bMi = base.getUTCMinutes(), bS = base.getUTCSeconds();

    const mk = (y, mo, d) => allDay
      ? Date.UTC(y, mo - 1, d)
      : zonedToInstant(y, mo, d, bH, bMi, bS, tz).getTime();

    let emitted = 0, iter = 0;
    const push = (ms) => {
      if (ms > untilMs) return false;
      if (r.count && emitted >= r.count) return false;
      emitted++;
      if (ms >= fromMs && ms <= toMs) res.push(ms);
      return true;
    };

    if (r.freq === "DAILY" || r.freq === "WEEKLY") {
      const step = (r.freq === "DAILY" ? 1 : 7) * r.interval;
      let cursor = new Date(Date.UTC(bY, bMo - 1, bD));
      // Skip ahead when we can: COUNT is measured from the very first
      // occurrence, so only skip when there is no COUNT to keep.
      if (!r.count && fromMs > startMs) {
        const days = Math.floor((fromMs - startMs) / 86400000);
        const whole = Math.floor(days / step) * step;
        if (whole > 0) cursor = new Date(cursor.getTime() + whole * 86400000);
      }
      while (iter++ < MAX_ITER) {
        const y = cursor.getUTCFullYear(), mo = cursor.getUTCMonth() + 1, d = cursor.getUTCDate();
        if (r.freq === "WEEKLY" && r.byday && r.byday.length) {
          // Expand the week this cursor sits in.
          const weekStart = cursor.getTime() - cursor.getUTCDay() * 86400000;
          for (let k = 0; k < 7; k++) {
            const day = new Date(weekStart + k * 86400000);
            if (day.getTime() < Date.UTC(bY, bMo - 1, bD)) continue;
            if (!dayMatches(r.byday, day.getUTCDay())) continue;
            const ms = mk(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate());
            if (ms < startMs) continue;
            if (!push(ms)) { iter = MAX_ITER; break; }
          }
        } else {
          const ms = mk(y, mo, d);
          if (ms >= startMs && !push(ms)) break;
        }
        cursor = new Date(cursor.getTime() + step * 86400000);
        if (cursor.getTime() > toMs + 86400000) break;
      }
      return res;
    }

    if (r.freq === "MONTHLY" || r.freq === "YEARLY") {
      const stepMonths = (r.freq === "MONTHLY" ? 1 : 12) * r.interval;
      let y = bY, mo = bMo;
      while (iter++ < MAX_ITER) {
        const monthStart = Date.UTC(y, mo - 1, 1);
        if (monthStart > toMs + 86400000) break;
        const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
        let candidates = [];
        if (r.bymonthday && r.bymonthday.length) {
          candidates = r.bymonthday
            .map((d) => (d > 0 ? d : daysInMonth + d + 1))
            .filter((d) => d >= 1 && d <= daysInMonth);
        } else if (r.byday && r.byday.length) {
          for (let d = 1; d <= daysInMonth; d++) {
            if (ordinalMatches(r.byday, y, mo, d)) candidates.push(d);
          }
        } else {
          candidates = [Math.min(bD, daysInMonth)];
          if (bD > daysInMonth) candidates = [];   // skip short months
        }
        if (r.bymonth && r.bymonth.length && !r.bymonth.includes(mo)) candidates = [];
        candidates.sort((a, b) => a - b);
        let stop = false;
        for (const d of candidates) {
          const ms = mk(y, mo, d);
          if (ms < startMs) continue;
          if (!push(ms)) { stop = true; break; }
        }
        if (stop) break;
        mo += stepMonths;
        while (mo > 12) { mo -= 12; y++; }
      }
      return res;
    }

    // Unknown FREQ: fall back to the single start, rather than nothing.
    if (startMs >= fromMs && startMs <= toMs) res.push(startMs);
    return res;
  }

  /* ---------- expand a parsed feed into Google-shaped events ---------- */

  function expand(parsed, fromISO, toISO, tz, cal) {
    const zone = tz || "UTC";
    const fromMs = Date.parse(fromISO + "T00:00:00Z") - 86400000;
    const toMs = Date.parse(toISO + "T00:00:00Z") + 86400000;
    const out = [];

    // RECURRENCE-ID entries replace one occurrence of their series.
    const overrides = {};
    parsed.events.forEach((ev) => {
      if (!ev.recurrenceId || !ev.uid) return;
      const k = ev.recurrenceId.allDay
        ? Date.UTC(ev.recurrenceId.y, ev.recurrenceId.mo - 1, ev.recurrenceId.d)
        : ev.recurrenceId.instant.getTime();
      overrides[ev.uid + "|" + k] = ev;
    });

    parsed.events.forEach((ev) => {
      if (ev.recurrenceId) return;                  // handled as an override
      if (ev.status === "CANCELLED") return;
      if (!ev.start) return;

      const exSet = new Set(ev.exdates.map((x) =>
        x.allDay ? Date.UTC(x.y, x.mo - 1, x.d) : x.instant.getTime()));

      occurrences(ev, fromMs, toMs, zone).forEach((ms) => {
        if (exSet.has(ms)) return;

        let src = ev;
        const ov = overrides[ev.uid + "|" + ms];
        let startMs = ms;
        if (ov) {
          if (ov.status === "CANCELLED") return;
          src = ov;
          startMs = ov.start.allDay
            ? Date.UTC(ov.start.y, ov.start.mo - 1, ov.start.d)
            : ov.start.instant.getTime();
        }

        const allDay = src.start.allDay;
        // Length: DTEND when present, else DURATION, else a day / an hour.
        let lenMs;
        if (src.end) {
          const s0 = src.start.allDay
            ? Date.UTC(src.start.y, src.start.mo - 1, src.start.d)
            : src.start.instant.getTime();
          const e0 = src.end.allDay
            ? Date.UTC(src.end.y, src.end.mo - 1, src.end.d)
            : src.end.instant.getTime();
          lenMs = e0 - s0;
        } else if (src.duration != null) {
          lenMs = src.duration;
        } else {
          lenMs = allDay ? 86400000 : 3600000;
        }
        const endMs = startMs + lenMs;

        const g = {
          summary: src.summary || "",
          description: src.description || "",
          location: src.location || "",
          id: (src.uid || "") + "-" + startMs,
          iCalUID: src.uid || "",
        };
        if (allDay) {
          const s = new Date(startMs), e = new Date(endMs);
          g.start = { date: s.toISOString().slice(0, 10) };
          g.end = { date: e.toISOString().slice(0, 10) };
        } else {
          g.start = { dateTime: instantToLocalISO(new Date(startMs), zone) };
          g.end = { dateTime: instantToLocalISO(new Date(endMs), zone) };
        }
        out.push({ ev: g, cal });
      });
    });

    return out;
  }

  return {
    parse, expand, unfold, parseLine, unescapeText, parseRRule, parseDuration,
    instantToLocalISO, instantToLocalDate, zonedToInstant, offsetMs,
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ICAL;

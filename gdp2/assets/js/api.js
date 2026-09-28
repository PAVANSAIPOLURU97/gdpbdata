/*
  api.js
  ==================================================================
  The ONLY file that knows how to talk to the Google Sheets backend.

  Every function that existed before still exists with the same name,
  the same arguments and the same return shape. Two additions:

    * apiListByDay(sheet, day, dateCol, options) — asks the server for
      only the rows on one calendar day. Used by Milk Input so the list
      never downloads more than today. Cached separately per day, so it
      can't collide with the full-sheet cache.

    * apiInvalidate now also clears any day-scoped cache for the sheet,
      so a save is never masked by a stale day cache.

  Underneath, as before:
    * CACHE (90s, memory + sessionStorage for small master sheets)
    * DEDUPE of in-flight requests
    * BULK — apiListMany fetches many sheets in ONE round trip
    * BATCH — apiAddRows saves N rows in ONE request
    * STALE-WHILE-REVALIDATE for instant paint
  ==================================================================
*/

const API_CACHE_TTL_MS = 90 * 1000;
const API_PERSISTED_SHEETS = ["Units", "ProductMaster", "EmployeeMaster", "RawMaterials", "MilkMaster"];

const _apiMemoryCache = {};   // key -> { rows, fetchedAt }   (key is sheet, or "sheet@day")
const _apiInFlight = {};      // key -> Promise (dedupe)

function isBackendConfigured() {
  return APP_CONFIG.appsScriptUrl && APP_CONFIG.appsScriptUrl.indexOf("https://") === 0;
}

function _requireBackend() {
  if (!isBackendConfigured()) {
    throw new Error("Backend not set up yet. See docs/GOOGLE_SHEETS_SETUP.md.");
  }
}

// ------------------------------------------------------------------
// Cache plumbing
// ------------------------------------------------------------------

function _sessionKey(sheetName) {
  return "pgd_cache_" + sheetName;
}

function _cacheRead(cacheKey) {
  const mem = _apiMemoryCache[cacheKey];
  if (mem && (Date.now() - mem.fetchedAt) < API_CACHE_TTL_MS) return mem;

  if (API_PERSISTED_SHEETS.indexOf(cacheKey) !== -1) {
    try {
      const raw = sessionStorage.getItem(_sessionKey(cacheKey));
      if (raw) {
        const parsed = JSON.parse(raw);
        _apiMemoryCache[cacheKey] = parsed;
        return parsed;
      }
    } catch (e) { /* sessionStorage unavailable or full — ignore */ }
  }
  return mem || null;
}

function _cacheWrite(cacheKey, rows) {
  const entry = { rows: rows, fetchedAt: Date.now() };
  _apiMemoryCache[cacheKey] = entry;
  if (API_PERSISTED_SHEETS.indexOf(cacheKey) !== -1) {
    try {
      sessionStorage.setItem(_sessionKey(cacheKey), JSON.stringify(entry));
    } catch (e) { /* quota — harmless, memory cache still works */ }
  }
}

function _cacheIsFresh(entry) {
  return !!entry && (Date.now() - entry.fetchedAt) < API_CACHE_TTL_MS;
}

// Called after any write so the next read is guaranteed fresh. Clears
// the full-sheet cache AND every day-scoped cache ("sheet@YYYY-MM-DD").
function apiInvalidate(sheetName) {
  delete _apiMemoryCache[sheetName];
  const dayPrefix = sheetName + "@";
  Object.keys(_apiMemoryCache).forEach(function (k) {
    if (k.indexOf(dayPrefix) === 0) delete _apiMemoryCache[k];
  });
  try { sessionStorage.removeItem(_sessionKey(sheetName)); } catch (e) {}
}

function apiInvalidateAll() {
  Object.keys(_apiMemoryCache).forEach(function (k) { delete _apiMemoryCache[k]; });
  API_PERSISTED_SHEETS.forEach(function (s) {
    try { sessionStorage.removeItem(_sessionKey(s)); } catch (e) {}
  });
}

function _expandCompact(payload) {
  const headers = payload.headers || [];
  return (payload.values || []).map(function (row) {
    const obj = {};
    for (let i = 0; i < headers.length; i++) obj[headers[i]] = row[i];
    return obj;
  });
}

function _get(url) {
  return fetch(url, { method: "GET", redirect: "follow" }).then(function (res) {
    return res.json();
  });
}

// ------------------------------------------------------------------
// Reading
// ------------------------------------------------------------------

async function apiListRows(sheetName, options) {
  options = options || {};
  _requireBackend();

  const cached = _cacheRead(sheetName);

  if (!options.force && _cacheIsFresh(cached)) {
    return cached.rows;
  }

  if (!options.force && options.allowStale && cached) {
    _fetchSheet(sheetName).catch(function (err) {
      console.warn("Background refresh of " + sheetName + " failed:", err);
    });
    return cached.rows;
  }

  return _fetchSheet(sheetName);
}

function _fetchSheet(sheetName) {
  if (_apiInFlight[sheetName]) return _apiInFlight[sheetName];

  const url = APP_CONFIG.appsScriptUrl +
    "?action=list&compact=1&sheet=" + encodeURIComponent(sheetName);

  const promise = _get(url).then(function (data) {
    if (!data.success) throw new Error(data.message || "Could not load data from the sheet.");
    const rows = data.headers !== undefined ? _expandCompact(data) : (data.rows || []);
    _cacheWrite(sheetName, rows);
    return rows;
  }).finally(function () {
    delete _apiInFlight[sheetName];
  });

  _apiInFlight[sheetName] = promise;
  return promise;
}

/*
  NEW — only the rows on ONE calendar day, filtered on the server.

  apiListByDay("MilkInput", "2026-08-06")            // dateCol defaults to EntryDateTime
  apiListByDay("MilkInput", "2026-08-06", "EntryDateTime", { force: true })

  Returns the array of row objects for that day (same shape as
  apiListRows). Cached under "sheet@day" so it never collides with the
  full-sheet cache, and cleared whenever that sheet is written.
*/
async function apiListByDay(sheetName, day, dateCol, options) {
  options = options || {};
  dateCol = dateCol || "EntryDateTime";
  _requireBackend();

  const cacheKey = sheetName + "@" + day;
  const cached = _cacheRead(cacheKey);

  if (!options.force && _cacheIsFresh(cached)) {
    return cached.rows;
  }

  if (!options.force && options.allowStale && cached) {
    _fetchDay(sheetName, day, dateCol, cacheKey).catch(function (err) {
      console.warn("Background refresh of " + cacheKey + " failed:", err);
    });
    return cached.rows;
  }

  return _fetchDay(sheetName, day, dateCol, cacheKey);
}

function _fetchDay(sheetName, day, dateCol, cacheKey) {
  if (_apiInFlight[cacheKey]) return _apiInFlight[cacheKey];

  const url = APP_CONFIG.appsScriptUrl +
    "?action=listByDay&compact=1" +
    "&sheet=" + encodeURIComponent(sheetName) +
    "&dateCol=" + encodeURIComponent(dateCol) +
    "&day=" + encodeURIComponent(day);

  const promise = _get(url).then(function (data) {
    if (!data.success) throw new Error(data.message || "Could not load today's entries.");
    const rows = data.headers !== undefined ? _expandCompact(data) : (data.rows || []);
    _cacheWrite(cacheKey, rows);
    return rows;
  }).finally(function () {
    delete _apiInFlight[cacheKey];
  });

  _apiInFlight[cacheKey] = promise;
  return promise;
}

async function apiListMany(sheetNames, options) {
  options = options || {};
  _requireBackend();

  const out = {};
  const errors = {};
  const needed = [];
  let everyNeededSheetHasSomething = true;

  sheetNames.forEach(function (name) {
    const cached = _cacheRead(name);
    if (!options.force && _cacheIsFresh(cached)) {
      out[name] = cached.rows;
    } else {
      needed.push(name);
      if (cached) {
        out[name] = cached.rows;
      } else {
        everyNeededSheetHasSomething = false;
      }
    }
  });

  if (needed.length === 0) {
    out._errors = errors;
    return out;
  }

  if (options.allowStale && everyNeededSheetHasSomething) {
    _bulkFetch(needed).then(function (fetched) {
      if (typeof options.onRefreshed === "function") {
        let changed = false;
        needed.forEach(function (name) {
          if (errors[name]) return;
          if (JSON.stringify(fetched.rowsBySheet[name]) !== JSON.stringify(out[name])) changed = true;
        });
        options.onRefreshed(changed);
      }
    }).catch(function (err) {
      console.warn("Background refresh failed:", err);
    });
    out._errors = errors;
    return out;
  }

  const fetched = await _bulkFetch(needed);
  needed.forEach(function (name) {
    if (fetched.errors[name]) {
      errors[name] = fetched.errors[name];
      if (out[name] === undefined) out[name] = [];
    } else {
      out[name] = fetched.rowsBySheet[name];
    }
  });

  out._errors = errors;
  return out;
}

async function _bulkFetch(sheetNames) {
  const rowsBySheet = {};
  const errors = {};

  const url = APP_CONFIG.appsScriptUrl +
    "?action=bulk&compact=1&sheets=" + encodeURIComponent(sheetNames.join(","));

  try {
    const data = await _get(url);
    if (!data.success) throw new Error(data.message || "Could not load data from the sheets.");

    sheetNames.forEach(function (name) {
      const part = data.data ? data.data[name] : null;
      if (part && part.success) {
        const rows = part.headers !== undefined ? _expandCompact(part) : (part.rows || []);
        _cacheWrite(name, rows);
        rowsBySheet[name] = rows;
      } else {
        errors[name] = (part && part.message) || "Could not load " + name;
        rowsBySheet[name] = [];
      }
    });
  } catch (err) {
    sheetNames.forEach(function (name) {
      errors[name] = err.message;
      rowsBySheet[name] = [];
    });
  }

  return { rowsBySheet: rowsBySheet, errors: errors };
}

async function apiNextBillNo(prefix) {
  _requireBackend();
  const url = APP_CONFIG.appsScriptUrl + "?action=nextBillNo&prefix=" + encodeURIComponent(prefix);
  const data = await _get(url);
  if (!data.success) throw new Error(data.message || "Could not work out the bill number.");
  return data.billNo;
}

function apiWarmUp() {
  if (!isBackendConfigured()) return;
  try {
    fetch(APP_CONFIG.appsScriptUrl + "?action=ping", { method: "GET", redirect: "follow" })
      .catch(function () {});
  } catch (e) {}
}

// ------------------------------------------------------------------
// Writing
// ------------------------------------------------------------------

async function apiAddRows(sheetName, rows, options) {
  _requireBackend();
  if (!rows || rows.length === 0) return { success: true, written: 0 };

  const session = getSession();
  const payload = {
    action: "addBatch",
    sheet: sheetName,
    userId: session ? session.userId : "unknown",
    rows: rows,
    options: options || {}
  };

  // A plain string body keeps this a "simple request" so the browser
  // sends no CORS preflight (Apps Script cannot answer an OPTIONS call).
  // Do NOT add a Content-Type header here.
  const res = await fetch(APP_CONFIG.appsScriptUrl, {
    method: "POST",
    redirect: "follow",
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  if (!data.success) throw new Error(data.message || "Could not save data to the sheet.");

  apiInvalidate(sheetName);
  return data;
}

async function apiAddRow(sheetName, rowData) {
  return apiAddRows(sheetName, [rowData]);
}

/*
  products-made.js — logic for pages/products-made.html
  Sheet: "ProductsMade"
  Columns: EntryDateTime | StartTime | EndTime | ProductName | RawMaterialName |
           RawMaterialQuantity | RawMaterialUnit | QuantityProduced | ProducedUnit |
           MadeBy | Quality | Remarks | AddedBy | Timestamp

  ==================================================================
  PERFORMANCE REWRITE — the batch rules, validation, grouping and saved
  columns are unchanged. Three things were making the Product dropdown
  take several seconds to fill.

  1. FIVE SEPARATE REQUESTS. The old code fetched ProductMaster,
     EmployeeMaster, Units, RawMaterials and ProductsMade with
     Promise.allSettled. Those look parallel in the browser, but Apps
     Script runs one call per user at a time, so they queued on the
     server: five cold round trips before the Product dropdown filled.
     -> The four dropdown sheets now come back in ONE request.

  2. THE DROPDOWNS WAITED FOR THE ENTRY LIST. ProductsMade is the
     biggest sheet on the page and it was being awaited alongside the
     master data, so the Product dropdown could not fill until the whole
     list had also downloaded.
     -> The list is now fetched separately and the dropdowns no longer
        wait for it. The form is usable while the list is still loading.

  3. ONE HTTP REQUEST PER RAW MATERIAL ON SAVE. A batch using four raw
     materials meant four sequential saves.
     -> The whole batch is now saved in ONE request and one block write.

  Plus: the master data is cached, so coming back to this page in the
  same session fills every dropdown instantly with no network at all.
  ==================================================================
*/

const session = requireLogin("productsMade");

const MAX_RAW_MATERIALS = 10;

// --- caches (filled once by loadMasterData, reused everywhere) ---
let cachedProducts = [];
let cachedEmployees = [];
let cachedUnits = [];
let cachedRawMaterials = [];
let cachedProductsMade = [];
let productsMadeError = null;

// --- per-dropdown empty/error messages ---
let productEmptyMsg = "No products yet — add one in Product Master";
let employeeEmptyMsg = "No employees yet — add one in Employee Master";
let unitEmptyMsg = "No units yet — add one in Units";
let rawMaterialEmptyMsg = "No raw materials yet — add one in Raw Materials";

let blockCounter = 0;

// -------------------------------------------------------------------
// Small local helpers
// -------------------------------------------------------------------

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value === undefined || value === null ? "" : String(value);
  return div.innerHTML;
}

function roundTo3(num) {
  return Math.round(num * 1000) / 1000;
}

function setDefaultDateTime() {
  const now = new Date();
  const tzCorrected = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  document.getElementById("entryDateTime").value = tzCorrected.toISOString().slice(0, 16);
}

function fillSelect(selectEl, values, placeholder, emptyMessage, keepValue) {
  if (!selectEl) return;
  if (!values || values.length === 0) {
    selectEl.innerHTML = '<option value="">' + emptyMessage + "</option>";
    return;
  }
  const parts = ['<option value="">' + placeholder + "</option>"];
  for (let i = 0; i < values.length; i++) {
    const safe = escapeHtml(values[i]);
    parts.push('<option value="' + safe + '">' + safe + "</option>");
  }
  selectEl.innerHTML = parts.join("");
  if (keepValue) {
    selectEl.value = keepValue;
    if (selectEl.value !== keepValue) selectEl.value = "";
  }
}

function sameCalendarDate(value, dateStr) {
  if (!value || !dateStr) return false;
  const d = new Date(value);
  if (isNaN(d.getTime())) return false;
  const parts = dateStr.split("-");
  const y = Number(parts[0]), m = Number(parts[1]) - 1, day = Number(parts[2]);
  return d.getFullYear() === y && d.getMonth() === m && d.getDate() === day;
}

function formatDateForHeading(dateStr) {
  const parts = dateStr.split("-");
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// Recovers a clean "HH:MM" from a StartTime/EndTime cell — returns a bare
// "HH:MM" as-is, and repairs Sheets' garbled 1899-12-30 epoch representation
// (from any old rows saved before the Plain Text column fix) using UTC.
function formatTimeOfDay(value) {
  if (!value) return "";
  if (/^\d{1,2}:\d{2}$/.test(value)) return value;
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return hh + ":" + mm;
}

function distinct(rows, key) {
  const seen = {};
  const out = [];
  (rows || []).forEach(function (r) {
    const v = r[key];
    if (v && !seen[v]) { seen[v] = true; out.push(v); }
  });
  return out;
}

// -------------------------------------------------------------------
// Data loading
// -------------------------------------------------------------------

function setDropdownsLoading() {
  document.getElementById("productName").innerHTML = '<option value="">Loading...</option>';
  document.getElementById("madeBy").innerHTML = '<option value="">Loading...</option>';
  document.getElementById("producedUnit").innerHTML = '<option value="">Loading...</option>';
}

/*
  The four dropdown sheets in ONE request. `allowStale` lets a repeat
  visit paint from cache immediately while a fresh copy arrives quietly
  behind it.
*/
async function loadMasterData(force) {
  const data = await apiListMany(
    ["ProductMaster", "EmployeeMaster", "Units", "RawMaterials"],
    {
      force: !!force,
      allowStale: !force,
      // When the fresh copy lands behind a cache-first paint, refill the
      // dropdowns. `preserve = true` keeps whatever the user had already
      // chosen, so this is invisible unless Master genuinely changed.
      onRefreshed: function (changed) {
        if (!changed) return;
        loadMasterData(false).then(function () {
          fillTopDropdownsFromCache(true);
          refillBlocksFromCache();
        });
      }
    }
  );
  const errors = data._errors || {};

  cachedProducts = distinct(data.ProductMaster, "ProductName");
  productEmptyMsg = errors.ProductMaster ? "Could not load products" : "No products yet — add one in Product Master";

  cachedEmployees = distinct(data.EmployeeMaster, "EmployeeName");
  employeeEmptyMsg = errors.EmployeeMaster ? "Could not load employees" : "No employees yet — add one in Employee Master";

  cachedUnits = distinct(data.Units, "UnitName");
  unitEmptyMsg = errors.Units ? "Could not load units" : "No units yet — add one in Units";

  cachedRawMaterials = distinct(data.RawMaterials, "RawMaterialName");
  rawMaterialEmptyMsg = errors.RawMaterials ? "Could not load raw materials" : "No raw materials yet — add one in Raw Materials";

  Object.keys(errors).forEach(function (k) {
    console.error(k + " load failed:", errors[k]);
  });
}

// The entry list, fetched on its own so it never delays the dropdowns.
async function loadProductsMadeList(force) {
  try {
    cachedProductsMade = await apiListRows("ProductsMade", { force: !!force });
    productsMadeError = null;
  } catch (err) {
    cachedProductsMade = [];
    productsMadeError = err.message;
    console.error("ProductsMade load failed:", err);
  }
}

// -------------------------------------------------------------------
// Filling the dropdowns from cache (no network)
// -------------------------------------------------------------------

function fillTopDropdownsFromCache(preserve) {
  const productSel = document.getElementById("productName");
  const employeeSel = document.getElementById("madeBy");
  const producedUnitSel = document.getElementById("producedUnit");

  fillSelect(productSel, cachedProducts, "Select a product", productEmptyMsg, preserve ? productSel.value : "");
  fillSelect(employeeSel, cachedEmployees, "Select who made it", employeeEmptyMsg, preserve ? employeeSel.value : "");
  fillSelect(producedUnitSel, cachedUnits, "Select a unit", unitEmptyMsg, preserve ? producedUnitSel.value : "");
}

function refillBlocksFromCache() {
  document.querySelectorAll("#blocksContainer .repeatable-block").forEach(function (block) {
    const rmSel = block.querySelector(".blockRawMaterial");
    fillSelect(rmSel, cachedRawMaterials, "Select raw material", rawMaterialEmptyMsg, rmSel.value);
    const unitSel = block.querySelector(".blockUnit");
    fillSelect(unitSel, cachedUnits, "Select unit", unitEmptyMsg, unitSel.value);
  });
}

// -------------------------------------------------------------------
// Repeatable raw-material blocks (max 10) — all from cache, no network
// -------------------------------------------------------------------

function updateAddBlockButtonState() {
  const count = document.querySelectorAll("#blocksContainer .repeatable-block").length;
  const btn = document.getElementById("addBlockBtn");
  if (count >= MAX_RAW_MATERIALS) {
    btn.disabled = true;
    btn.textContent = "Maximum " + MAX_RAW_MATERIALS + " raw materials reached";
  } else {
    btn.disabled = false;
    btn.textContent = "+ Add Another Raw Material";
  }
}

function addBlock() {
  const container = document.getElementById("blocksContainer");
  if (container.children.length >= MAX_RAW_MATERIALS) {
    showFormStatus(document.getElementById("formStatus"), "Maximum " + MAX_RAW_MATERIALS + " raw materials per batch.", true);
    return;
  }

  blockCounter++;
  const wrapper = document.createElement("div");
  wrapper.className = "repeatable-block";
  wrapper.dataset.blockId = "block" + blockCounter;

  wrapper.innerHTML =
    '<button type="button" class="repeatable-block-remove" title="Remove this raw material">&times;</button>' +
    '<div class="form-group"><label>Raw Material</label><select class="blockRawMaterial" required></select></div>' +
    '<div class="form-group"><label>Quantity</label><input type="number" class="blockQuantity" inputmode="decimal" step="0.001" min="0.001" placeholder="e.g. 5.250" required></div>' +
    '<div class="form-group"><label>Unit</label><select class="blockUnit" required></select></div>';

  container.appendChild(wrapper);

  fillSelect(wrapper.querySelector(".blockRawMaterial"), cachedRawMaterials, "Select raw material", rawMaterialEmptyMsg, "");
  fillSelect(wrapper.querySelector(".blockUnit"), cachedUnits, "Select unit", unitEmptyMsg, "");

  updateAddBlockButtonState();
}

function resetBlocks() {
  document.getElementById("blocksContainer").innerHTML = "";
  addBlock();
}

// -------------------------------------------------------------------
// List (day view) rendered from cache — grouped into one card per batch
// -------------------------------------------------------------------

function renderListFromCache() {
  const listArea = document.getElementById("listArea");
  const totalArea = document.getElementById("totalArea");
  const dateHeading = document.getElementById("listDateHeading");
  totalArea.innerHTML = "";

  const entryDateTimeVal = document.getElementById("entryDateTime").value;
  const selectedDateStr = entryDateTimeVal ? entryDateTimeVal.slice(0, 10) : null;
  dateHeading.textContent = selectedDateStr ? ("Products Made — " + formatDateForHeading(selectedDateStr)) : "Products Made";

  if (productsMadeError) {
    listArea.innerHTML = '<p class="list-empty">' + escapeHtml(productsMadeError) + "</p>";
    return;
  }

  const filtered = selectedDateStr
    ? cachedProductsMade.filter(function (r) { return sameCalendarDate(r.EntryDateTime, selectedDateStr); })
    : cachedProductsMade.slice();

  if (filtered.length === 0) {
    listArea.innerHTML = '<p class="list-empty">No products made entries for this date yet.</p>';
    return;
  }

  // Group raw-material rows back into batches. A batch is uniquely identified
  // by EntryDateTime + ProductName + StartTime (repeated identically on every
  // row of the same submission).
  const batchesByKey = {};
  const order = [];
  filtered.forEach(function (r) {
    const key = r.EntryDateTime + "|" + r.ProductName + "|" + r.StartTime;
    if (!batchesByKey[key]) {
      batchesByKey[key] = {
        EntryDateTime: r.EntryDateTime,
        StartTime: r.StartTime,
        EndTime: r.EndTime,
        ProductName: r.ProductName,
        QuantityProduced: r.QuantityProduced,
        ProducedUnit: r.ProducedUnit,
        MadeBy: r.MadeBy,
        Quality: r.Quality,
        Remarks: r.Remarks,
        materials: []
      };
      order.push(key);
    }
    batchesByKey[key].materials.push({
      RawMaterialName: r.RawMaterialName,
      RawMaterialQuantity: r.RawMaterialQuantity,
      RawMaterialUnit: r.RawMaterialUnit
    });
  });

  const batches = order.map(function (k) { return batchesByKey[k]; });
  batches.sort(function (a, b) { return new Date(b.EntryDateTime) - new Date(a.EntryDateTime); });

  // Built as an array and joined once — a single DOM write for the panel.
  const parts = [];
  batches.forEach(function (batch) {
    const qv = (batch.Quality === "" || batch.Quality === undefined || batch.Quality === null) ? null : Number(batch.Quality);
    const qClass = qv === null ? "marks-na" : (qv >= 9 ? "marks-10" : qv >= 7 ? "marks-8" : "marks-0");
    const qLabel = qv === null ? "N/A" : qv;

    parts.push('<div class="batch-card">' +
      '<div class="batch-card-header">' +
        '<span class="batch-card-product">' + escapeHtml(batch.ProductName) + "</span>" +
        '<span class="batch-card-time">' + escapeHtml(formatTimeOfDay(batch.StartTime)) + " &ndash; " + escapeHtml(formatTimeOfDay(batch.EndTime)) + "</span>" +
      "</div>" +
      '<div class="batch-card-meta">Quantity Produced: <strong>' + escapeHtml(batch.QuantityProduced) + " " + escapeHtml(batch.ProducedUnit) + "</strong>" +
        " &middot; Made By: " + escapeHtml(batch.MadeBy) +
        ' &middot; Quality: <span class="marks-badge ' + qClass + '">' + escapeHtml(qLabel) + "</span></div>" +
      '<table class="data-table batch-card-materials"><thead><tr><th>Raw Material</th><th>Qty Used</th><th>Unit</th></tr></thead><tbody>');

    batch.materials.forEach(function (m) {
      parts.push("<tr><td>" + escapeHtml(m.RawMaterialName) + "</td><td>" + escapeHtml(m.RawMaterialQuantity) +
        "</td><td>" + escapeHtml(m.RawMaterialUnit) + "</td></tr>");
    });

    parts.push("</tbody></table>");
    if (batch.Remarks) {
      parts.push('<div class="batch-card-remarks">Remarks: ' + escapeHtml(batch.Remarks) + "</div>");
    }
    parts.push("</div>");
  });

  listArea.innerHTML = parts.join("");

  // Total quantity produced for the day, grouped by unit — one count per batch.
  const totals = {};
  batches.forEach(function (batch) {
    const qty = Number(batch.QuantityProduced) || 0;
    const unitKey = batch.ProducedUnit || "Unit";
    totals[unitKey] = (totals[unitKey] || 0) + qty;
  });
  const totalParts = Object.keys(totals).map(function (u) { return roundTo3(totals[u]) + " " + u; });
  if (totalParts.length > 0) {
    totalArea.innerHTML = '<div class="total-summary">Total Quantity Produced: ' + escapeHtml(totalParts.join(" + ")) + "</div>";
  }
}

// -------------------------------------------------------------------
// Page init
// -------------------------------------------------------------------

if (session) {
  setImage(document.getElementById("appLogo"), "appLogo");
  setImage(document.getElementById("logoutIcon"), "logoutIcon");
  const userLabel = document.getElementById("userLabel");
  if (userLabel) userLabel.textContent = session.name + " (" + session.role + ")";
  document.getElementById("logoutBtn").addEventListener("click", logout);

  apiWarmUp();

  setDefaultDateTime();
  setDropdownsLoading();
  document.getElementById("listArea").innerHTML = '<p class="list-loading">Loading...</p>';

  // "+ Add Another": pure cache, no network → instant.
  document.getElementById("addBlockBtn").addEventListener("click", function () {
    addBlock();
  });

  // One delegated handler for every block's remove button, now and in future.
  document.getElementById("blocksContainer").addEventListener("click", function (e) {
    if (!e.target.classList.contains("repeatable-block-remove")) return;
    const container = document.getElementById("blocksContainer");
    if (container.children.length > 1) {
      e.target.closest(".repeatable-block").remove();
      updateAddBlockButtonState();
    } else {
      showFormStatus(document.getElementById("formStatus"), "At least one raw material is required.", true);
    }
  });

  // Refresh: the only button that goes back to the sheet for the dropdowns.
  document.getElementById("refreshOptionsBtn").addEventListener("click", async function () {
    const btn = document.getElementById("refreshOptionsBtn");
    const statusEl = document.getElementById("formStatus");
    const label = "\u21BB Refresh Products / Raw Materials / Units / Employees";
    setButtonBusy(btn, true, "Refreshing...", label);

    // Both fetches go out together; the dropdowns repaint as soon as the
    // master data lands, without waiting for the list.
    const listJob = loadProductsMadeList(true).then(renderListFromCache);
    await loadMasterData(true);
    fillTopDropdownsFromCache(true);
    refillBlocksFromCache();
    await listJob;

    setButtonBusy(btn, false, "Refreshing...", label);
    showFormStatus(statusEl, "Refreshed.", false);
  });

  // Changing the date only re-filters the cached list → instant, no network.
  document.getElementById("entryDateTime").addEventListener("change", renderListFromCache);

  (async function init() {
    // Kick the list off first, but do NOT wait for it — the dropdowns are
    // what the user needs, and they come from a much smaller payload.
    const listJob = loadProductsMadeList(false).then(renderListFromCache);

    await loadMasterData(false);
    fillTopDropdownsFromCache(false);
    addBlock();

    await listJob;
  })();

  document.getElementById("productsMadeForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    const submitBtn = document.getElementById("submitBtn");
    const statusEl = document.getElementById("formStatus");

    const entryDateTime = document.getElementById("entryDateTime").value;
    const productName = document.getElementById("productName").value;
    const startTime = document.getElementById("startTime").value;
    const endTime = document.getElementById("endTime").value;
    const quantityProduced = document.getElementById("quantityProduced").value;
    const producedUnit = document.getElementById("producedUnit").value;
    const madeBy = document.getElementById("madeBy").value;
    const quality = document.getElementById("quality").value;
    const remarks = document.getElementById("remarks").value.trim();

    if (!entryDateTime || !productName || !startTime || !endTime || quantityProduced === "" ||
        Number(quantityProduced) <= 0 || !producedUnit || !madeBy || !quality || !remarks) {
      showFormStatus(statusEl, "Please fill in every field (Quantity Produced must be greater than 0).", true);
      return;
    }

    const blockEls = Array.from(document.querySelectorAll("#blocksContainer .repeatable-block"));
    const rowsToSave = [];
    const errors = [];

    blockEls.forEach(function (block, index) {
      const label = "Raw material #" + (index + 1);
      const rawMaterialName = block.querySelector(".blockRawMaterial").value;
      const quantity = block.querySelector(".blockQuantity").value;
      const unit = block.querySelector(".blockUnit").value;

      if (!rawMaterialName || quantity === "" || !unit) {
        errors.push(label + ": please select a raw material and fill Quantity and Unit.");
        return;
      }
      const qtyNum = Number(quantity);
      if (qtyNum <= 0) {
        errors.push(label + ": Quantity must be greater than 0.");
        return;
      }

      rowsToSave.push({
        EntryDateTime: entryDateTime,
        StartTime: startTime,
        EndTime: endTime,
        ProductName: productName,
        RawMaterialName: rawMaterialName,
        RawMaterialQuantity: roundTo3(qtyNum),
        RawMaterialUnit: unit,
        QuantityProduced: roundTo3(Number(quantityProduced)),
        ProducedUnit: producedUnit,
        MadeBy: madeBy,
        Quality: Number(quality),
        Remarks: remarks
      });
    });

    if (errors.length > 0) {
      showFormStatus(statusEl, errors.join(" "), true);
      return;
    }
    if (rowsToSave.length === 0) {
      showFormStatus(statusEl, "Please add at least one raw material.", true);
      return;
    }

    setButtonBusy(submitBtn, true, "Saving...", "Save Entry");
    try {
      // ONE request for the whole batch, instead of one per raw material.
      await apiAddRows("ProductsMade", rowsToSave);
      showFormStatus(statusEl, "Batch saved (" + rowsToSave.length + " raw material row(s)).", false);

      const keepDate = document.getElementById("entryDateTime").value;
      document.getElementById("productsMadeForm").reset();
      document.getElementById("entryDateTime").value = keepDate;

      // Dropdowns keep their cached options — no refetch needed.
      fillTopDropdownsFromCache(false);
      resetBlocks();

      // Only the list needs fresh data.
      await loadProductsMadeList(true);
      renderListFromCache();
    } catch (err) {
      showFormStatus(statusEl, err.message, true);
    } finally {
      setButtonBusy(submitBtn, false, "Saving...", "Save Entry");
    }
  });
}

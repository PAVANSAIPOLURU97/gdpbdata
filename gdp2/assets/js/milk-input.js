/*
  milk-input.js — logic for pages/milk-input.html
  Sheet: "MilkInput"
  Columns: EntryDateTime | Shift | MilkType | Quantity | Unit | Quality | Fat | SNF | Marks | AddedBy | Timestamp

  ==================================================================
  Grading rules, validation and saved columns are byte-for-byte the
  same as before. What changed, and why the tab feels slow:

  1. The list now shows TODAY ONLY, filtered on the server. Previously it
     downloaded every MilkInput row ever saved on each load AND again
     after every save — a payload and a table that grew every day. Now it
     ships only today's handful of rows, so it stays fast forever.

  2. Saving no longer re-downloads the sheet. The rows you just saved are
     already in hand, so they're added to today's list locally. A save is
     now exactly ONE network round trip.

  3. The first milk-type block paints immediately with a "Loading..."
     placeholder instead of waiting for the master sheets, then fills in
     as soon as they arrive.

  4. The background master refresh no longer re-triggers itself.
  ==================================================================
*/

const session = requireLogin("milkInput");

let cachedMilkTypes = [];
let cachedUnits = [];
let milkTypeEmptyMessage = "Loading milk types...";
let unitEmptyMessage = "Loading units...";
let blockCounter = 0;

// Today's entries, held locally so a save can update the list without
// another network call.
let todayRows = [];

// -------------------------------------------------------------------
// Grading rules — unchanged
// -------------------------------------------------------------------

function classifyMilkCategory(milkTypeName) {
  const name = (milkTypeName || "").toLowerCase();
  if (name.indexOf("buff") !== -1) return "buffalo";
  if (name.indexOf("cow") !== -1) return "cow";
  return "unknown";
}

function calculateMarks(milkTypeName, quality, fat, snf, quantity) {
  const qty = Number(quantity);

  if (qty === 0) {
    return { accepted: true, marks: 0, rejectReason: null };
  }

  const category = classifyMilkCategory(milkTypeName);
  const fatNum = Number(fat);
  const snfNum = Number(snf);

  if (category === "buffalo") {
    if (snfNum < 8.3) {
      return { accepted: false, marks: null, rejectReason: "SNF below 8.3 for Buffalo milk — not accepted." };
    }
    if (quality === "OK" && fatNum > 5 && snfNum >= 9) {
      return { accepted: true, marks: 10, rejectReason: null };
    }
    if (quality === "OK" && fatNum >= 5 && fatNum <= 6 && snfNum >= 8.3 && snfNum <= 9) {
      return { accepted: true, marks: 8, rejectReason: null };
    }
    return { accepted: true, marks: 0, rejectReason: null };
  }

  if (category === "cow") {
    if (snfNum < 7.8) {
      return { accepted: false, marks: null, rejectReason: "SNF below 7.8 for Cow milk — not accepted." };
    }
    if (quality === "OK" && fatNum > 4 && snfNum >= 8) {
      return { accepted: true, marks: 10, rejectReason: null };
    }
    if (quality === "OK" && fatNum >= 3 && fatNum <= 4 && snfNum >= 7.8 && snfNum <= 8) {
      return { accepted: true, marks: 8, rejectReason: null };
    }
    return { accepted: true, marks: 0, rejectReason: null };
  }

  return { accepted: true, marks: null, rejectReason: null };
}

// -------------------------------------------------------------------
// Small local helpers
// -------------------------------------------------------------------

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value === undefined || value === null ? "" : String(value);
  return div.innerHTML;
}

function showFormStatus(statusElement, message, isError) {
  statusElement.textContent = message;
  statusElement.className = "form-status " + (isError ? "form-status-error" : "form-status-success");
  statusElement.style.display = message ? "block" : "none";
}

function setButtonBusy(button, isBusy, busyLabel, normalLabel) {
  button.disabled = isBusy;
  button.textContent = isBusy ? busyLabel : normalLabel;
}

function roundNicely(num) {
  return Math.round(num * 100) / 100;
}

function formatDateTimeDisplay(value) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Local "today" as YYYY-MM-DD — matches the day the server filters on.
function todayStr() {
  const now = new Date();
  const tzCorrected = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return tzCorrected.toISOString().slice(0, 10);
}

// The calendar day (YYYY-MM-DD) of a saved row's EntryDateTime, so we
// only add rows to the list that actually belong to today.
function rowDayStr(entryDateTime) {
  if (!entryDateTime) return "";
  const s = String(entryDateTime);
  // "2026-08-06T14:30" / "2026-08-06 14:30" -> first 10 chars.
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (isNaN(d.getTime())) return "";
  const tzCorrected = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return tzCorrected.toISOString().slice(0, 10);
}

function setDefaultDateTime() {
  const now = new Date();
  const tzCorrected = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  document.getElementById("entryDateTime").value = tzCorrected.toISOString().slice(0, 16);
}

function fillSelectOptions(selectEl, values, placeholder, emptyMessage, keepValue) {
  if (values.length === 0) {
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

// -------------------------------------------------------------------
// Loading dropdown data — both master sheets in ONE request
// -------------------------------------------------------------------

// Turns a freshly-fetched master payload into the cached arrays.
function applyMasterData(data) {
  const errors = data._errors || {};

  const seen = {};
  cachedMilkTypes = [];
  (data.MilkMaster || []).forEach(function (r) {
    if (r.MilkType && !seen[r.MilkType]) {
      seen[r.MilkType] = true;
      cachedMilkTypes.push(r.MilkType);
    }
  });
  milkTypeEmptyMessage = errors.MilkMaster
    ? "Could not load milk types: " + errors.MilkMaster
    : "No milk types yet — add one in Milk Master";

  cachedUnits = (data.Units || []).map(function (r) { return r.UnitName; }).filter(Boolean);
  unitEmptyMessage = errors.Units
    ? "Could not load units: " + errors.Units
    : "No units yet — add one in Units";

  Object.keys(errors).forEach(function (k) {
    console.error("loadMasterOptions (" + k + ") failed:", errors[k]);
  });
}

async function loadMasterOptions(force) {
  const data = await apiListMany(["MilkMaster", "Units"], {
    force: !!force,
    allowStale: !force,
    // Cache-first paint, then quietly correct itself if Master changed.
    // The background read below uses no onRefreshed, so it can't loop.
    onRefreshed: function (changed) {
      if (!changed) return;
      apiListMany(["MilkMaster", "Units"], {}).then(function (fresh) {
        applyMasterData(fresh);
        refillBlocksFromCache();
      });
    }
  });
  applyMasterData(data);
}

async function refreshMasterOptionsAndBlocks() {
  const statusEl = document.getElementById("formStatus");
  showFormStatus(statusEl, "Refreshing milk types and units...", false);
  await loadMasterOptions(true);
  refillBlocksFromCache();
  showFormStatus(statusEl, "Milk types: " + cachedMilkTypes.length + " found. Units: " + cachedUnits.length + " found.", cachedUnits.length === 0);
}

function refillBlocksFromCache() {
  document.querySelectorAll("#blocksContainer .repeatable-block").forEach(function (block) {
    const milkSelect = block.querySelector(".blockMilkType");
    fillSelectOptions(milkSelect, cachedMilkTypes, "Select milk type", milkTypeEmptyMessage, milkSelect.value);
    const unitSelect = block.querySelector(".blockUnit");
    fillSelectOptions(unitSelect, cachedUnits, "Select unit", unitEmptyMessage, unitSelect.value);
  });
}

// -------------------------------------------------------------------
// Repeatable milk-type blocks — filled from cache, no network
// -------------------------------------------------------------------

function addBlock() {
  blockCounter++;
  const container = document.getElementById("blocksContainer");

  const wrapper = document.createElement("div");
  wrapper.className = "repeatable-block";
  wrapper.dataset.blockId = "block" + blockCounter;

  wrapper.innerHTML =
    '<button type="button" class="repeatable-block-remove" title="Remove this milk type">&times;</button>' +
    '<div class="form-group"><label>Milk Type</label><select class="blockMilkType" required></select></div>' +
    '<div class="form-group"><label>Quantity</label><input type="number" class="blockQuantity" inputmode="decimal" step="0.01" min="0" placeholder="e.g. 20" required></div>' +
    '<div class="form-group"><label>Unit</label><select class="blockUnit" required></select></div>' +
    '<div class="form-group"><label>Quality</label><select class="blockQuality"><option value="">Select</option><option value="OK">OK</option><option value="Not OK">Not OK</option></select></div>' +
    '<div class="form-group"><label>Fat</label><input type="number" class="blockFat" inputmode="decimal" step="0.01" min="0" placeholder="e.g. 5.5"></div>' +
    '<div class="form-group"><label>SNF</label><input type="number" class="blockSnf" inputmode="decimal" step="0.01" min="0" placeholder="e.g. 8.7"></div>';

  container.appendChild(wrapper);

  fillSelectOptions(wrapper.querySelector(".blockMilkType"), cachedMilkTypes, "Select milk type", milkTypeEmptyMessage, "");
  fillSelectOptions(wrapper.querySelector(".blockUnit"), cachedUnits, "Select unit", unitEmptyMessage, "");
}

function resetBlocks() {
  document.getElementById("blocksContainer").innerHTML = "";
  addBlock();
}

// -------------------------------------------------------------------
// List + totals — TODAY only
// -------------------------------------------------------------------

// Renders whatever is in todayRows. No network — used on load and after
// every save.
function renderTodayEntries() {
  const listArea = document.getElementById("listArea");
  const totalArea = document.getElementById("totalArea");

  if (todayRows.length === 0) {
    listArea.innerHTML = '<p class="list-empty">No milk input entries for today yet.</p>';
    totalArea.innerHTML = "";
    return;
  }

  const sorted = todayRows.slice().sort(function (a, b) {
    return new Date(b.EntryDateTime) - new Date(a.EntryDateTime);
  });

  const parts = ['<div class="table-scroll"><table class="data-table"><thead><tr>' +
    "<th>Date/Time</th><th>Shift</th><th>Milk Type</th><th>Qty</th><th>Unit</th><th>Quality</th><th>Fat</th><th>SNF</th><th>Marks</th>" +
    "</tr></thead><tbody>"];

  const totals = {};

  sorted.forEach(function (r) {
    const marksVal = (r.Marks === "" || r.Marks === undefined || r.Marks === null) ? null : Number(r.Marks);
    const marksClass = marksVal === 10 ? "marks-10" : marksVal === 8 ? "marks-8" : (marksVal === null ? "marks-na" : "marks-0");
    const marksLabel = marksVal === null ? "N/A" : marksVal;

    parts.push("<tr><td>" + escapeHtml(formatDateTimeDisplay(r.EntryDateTime)) + "</td><td>" + escapeHtml(r.Shift) +
      "</td><td>" + escapeHtml(r.MilkType) + "</td><td>" + escapeHtml(r.Quantity) +
      "</td><td>" + escapeHtml(r.Unit) + "</td><td>" + escapeHtml(r.Quality) +
      "</td><td>" + escapeHtml(r.Fat) + "</td><td>" + escapeHtml(r.SNF) +
      '</td><td><span class="marks-badge ' + marksClass + '">' + escapeHtml(marksLabel) + "</span></td></tr>");

    const qty = Number(r.Quantity) || 0;
    const unitKey = r.Unit || "Unit";
    totals[unitKey] = (totals[unitKey] || 0) + qty;
  });

  parts.push("</tbody></table></div>");
  listArea.innerHTML = parts.join("");

  const totalParts = Object.keys(totals).map(function (u) {
    return roundNicely(totals[u]) + " " + u;
  });
  totalArea.innerHTML = '<div class="total-summary">Today\'s Total Milk Quantity: ' + escapeHtml(totalParts.join(" + ")) + "</div>";
}

async function refreshEntriesList(force) {
  const listArea = document.getElementById("listArea");
  if (listArea.innerHTML.indexOf("data-table") === -1) {
    listArea.innerHTML = '<p class="list-loading">Loading...</p>';
  }

  try {
    todayRows = await apiListByDay("MilkInput", todayStr(), "EntryDateTime", { force: !!force });
    renderTodayEntries();
  } catch (err) {
    listArea.innerHTML = '<p class="list-empty">' + escapeHtml(err.message) + "</p>";
  }
}

// -------------------------------------------------------------------
// Page init
// -------------------------------------------------------------------

if (session) {
  setImage(document.getElementById("appLogo"), "appLogo");
  setImage(document.getElementById("logoutIcon"), "logoutIcon");
  document.getElementById("logoutBtn").addEventListener("click", logout);

  apiWarmUp();

  document.getElementById("addBlockBtn").addEventListener("click", function () {
    addBlock();
  });

  document.getElementById("blocksContainer").addEventListener("click", function (e) {
    if (!e.target.classList.contains("repeatable-block-remove")) return;
    const container = document.getElementById("blocksContainer");
    if (container.children.length > 1) {
      e.target.closest(".repeatable-block").remove();
    } else {
      showFormStatus(document.getElementById("formStatus"), "At least one milk type is required.", true);
    }
  });

  document.getElementById("refreshOptionsBtn").addEventListener("click", refreshMasterOptionsAndBlocks);

  setDefaultDateTime();

  (async function init() {
    // Paint the form's first block right away with a "Loading..."
    // placeholder — don't make the user wait on the network to see it.
    addBlock();

    // Today's list and the master dropdowns load in parallel.
    const listJob = refreshEntriesList(false);
    await loadMasterOptions(false);
    refillBlocksFromCache();   // fill the block that's already on screen
    await listJob;
  })();

  document.getElementById("milkInputForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    const submitBtn = document.getElementById("submitBtn");
    const statusEl = document.getElementById("formStatus");

    const entryDateTime = document.getElementById("entryDateTime").value;
    const shift = document.getElementById("shift").value;

    if (!entryDateTime || !shift) {
      showFormStatus(statusEl, "Please set the date/time and shift.", true);
      return;
    }

    const blockEls = Array.from(document.querySelectorAll("#blocksContainer .repeatable-block"));
    const rowsToSave = [];
    const errors = [];

    blockEls.forEach(function (block, index) {
      const label = "Milk type #" + (index + 1);
      const milkType = block.querySelector(".blockMilkType").value;
      const quantity = block.querySelector(".blockQuantity").value;
      const unit = block.querySelector(".blockUnit").value;
      const quality = block.querySelector(".blockQuality").value;
      const fat = block.querySelector(".blockFat").value;
      const snf = block.querySelector(".blockSnf").value;

      if (!milkType || quantity === "" || !unit) {
        errors.push(label + ": please fill Milk Type, Quantity, and Unit.");
        return;
      }

      const qtyNum = Number(quantity);

      if (qtyNum !== 0 && (!quality || fat === "" || snf === "")) {
        errors.push(label + ": Quality, Fat, and SNF are required when quantity is more than 0.");
        return;
      }

      const result = calculateMarks(milkType, quality, fat, snf, qtyNum);
      if (!result.accepted) {
        errors.push(label + " (" + milkType + "): " + result.rejectReason);
        return;
      }

      rowsToSave.push({
        EntryDateTime: entryDateTime,
        Shift: shift,
        MilkType: milkType,
        Quantity: qtyNum,
        Unit: unit,
        Quality: quality || "",
        Fat: fat === "" ? "" : Number(fat),
        SNF: snf === "" ? "" : Number(snf),
        Marks: result.marks === null ? "" : result.marks
      });
    });

    if (errors.length > 0) {
      showFormStatus(statusEl, errors.join(" "), true);
      return;
    }

    setButtonBusy(submitBtn, true, "Saving...", "Save Entry");
    try {
      // ONE request for every block. No re-download afterwards — the rows
      // we just saved are added to today's list locally.
      await apiAddRows("MilkInput", rowsToSave);

      const today = todayStr();
      rowsToSave.forEach(function (r) {
        if (rowDayStr(r.EntryDateTime) === today) todayRows.push(r);
      });
      renderTodayEntries();

      showFormStatus(statusEl, rowsToSave.length + " milk entry(ies) saved.", false);
      resetBlocks();
      refillBlocksFromCache();
      setDefaultDateTime();
      document.getElementById("shift").value = "";
    } catch (err) {
      showFormStatus(statusEl, err.message, true);
    } finally {
      setButtonBusy(submitBtn, false, "Saving...", "Save Entry");
    }
  });
}

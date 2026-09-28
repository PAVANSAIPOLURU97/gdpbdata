/*
  rawmaterial-procurement.js — logic for pages/rawmaterial-procurement.html
  Sheet: "RawMaterialProcurement"
  Columns: EntryDateTime | RawMaterialName | Quantity | Unit | Supplier | Rate | Amount | AddedBy | Timestamp

  ==================================================================
  PERFORMANCE REWRITE — the amount calculation, validation and saved
  columns are unchanged. What changed:

  1. The Raw Material and Unit dropdowns were two separate requests, and
     the entry list a third — three queued round trips on every load.
     -> The two dropdown sheets now come back in ONE request, and the
        list is fetched alongside them instead of after them.

  2. After every save the page refetched BOTH dropdowns from the sheet,
     even though neither can have changed as a result of a procurement
     entry. That was two pointless round trips per save.
     -> They are refilled from cache now, which is instant. Only the
        entry list actually goes back to the sheet.
  ==================================================================
*/

const session = requireLogin("procurement");

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value === undefined || value === null ? "" : String(value);
  return div.innerHTML;
}

function roundNicely(num) {
  return Math.round(num * 100) / 100;
}

function setDefaultDateTime() {
  const now = new Date();
  const tzCorrected = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  document.getElementById("entryDateTime").value = tzCorrected.toISOString().slice(0, 16);
}

// Keeps the read-only Amount field equal to Quantity x Rate at all times.
function recalcAmount() {
  const qty = Number(document.getElementById("quantity").value) || 0;
  const rate = Number(document.getElementById("rate").value) || 0;
  document.getElementById("amount").value = (qty > 0 && rate >= 0) ? roundNicely(qty * rate) : "";
}

// Both dropdowns from a single request.
function loadBothDropdowns(force) {
  return loadDropdowns([
    { element: document.getElementById("rawMaterialName"), source: "rawMaterials" },
    { element: document.getElementById("unit"), source: "units" }
  ], force);
}

async function refreshProcurementList(force) {
  const listArea = document.getElementById("listArea");
  const totalArea = document.getElementById("totalArea");
  if (listArea.innerHTML.indexOf("data-table") === -1) {
    listArea.innerHTML = '<p class="list-loading">Loading...</p>';
  }
  totalArea.innerHTML = "";

  try {
    const rows = await apiListRows("RawMaterialProcurement", { force: !!force });
    if (rows.length === 0) {
      listArea.innerHTML = '<p class="list-empty">No procurement entries yet. Add your first one on the left.</p>';
      return;
    }

    const sorted = rows.slice().sort(function (a, b) {
      return new Date(b.EntryDateTime) - new Date(a.EntryDateTime);
    });

    const parts = ['<div class="table-scroll"><table class="data-table"><thead><tr>' +
      "<th>Date/Time</th><th>Raw Material</th><th>Qty</th><th>Unit</th><th>Procured From</th><th>Rate</th><th>Amount</th>" +
      "</tr></thead><tbody>"];

    let totalSpent = 0;

    sorted.forEach(function (r) {
      parts.push("<tr><td>" + escapeHtml(formatTimestamp(r.EntryDateTime)) + "</td><td>" + escapeHtml(r.RawMaterialName) +
        "</td><td>" + escapeHtml(r.Quantity) + "</td><td>" + escapeHtml(r.Unit) +
        "</td><td>" + escapeHtml(r.Supplier) + "</td><td>" + escapeHtml(r.Rate) +
        "</td><td>" + escapeHtml(r.Amount) + "</td></tr>");

      totalSpent += Number(r.Amount) || 0;
    });

    parts.push("</tbody></table></div>");
    listArea.innerHTML = parts.join("");

    totalArea.innerHTML = '<div class="total-summary">Total Amount Spent: \u20B9' + roundNicely(totalSpent) + "</div>";
  } catch (err) {
    listArea.innerHTML = '<p class="list-empty">' + escapeHtml(err.message) + "</p>";
  }
}

if (session) {
  setImage(document.getElementById("appLogo"), "appLogo");
  setImage(document.getElementById("logoutIcon"), "logoutIcon");
  const userLabel = document.getElementById("userLabel");
  if (userLabel) userLabel.textContent = session.name + " (" + session.role + ")";
  document.getElementById("logoutBtn").addEventListener("click", logout);

  apiWarmUp();
  setDefaultDateTime();

  // Dropdowns and list go out together instead of one after the other.
  loadBothDropdowns(false);
  refreshProcurementList(false);

  document.getElementById("quantity").addEventListener("input", recalcAmount);
  document.getElementById("rate").addEventListener("input", recalcAmount);

  document.getElementById("refreshOptionsBtn").addEventListener("click", async function () {
    const btn = document.getElementById("refreshOptionsBtn");
    const label = "\u21BB Refresh Raw Materials / Units";
    setButtonBusy(btn, true, "Refreshing...", label);
    await loadBothDropdowns(true);
    setButtonBusy(btn, false, "Refreshing...", label);
  });

  document.getElementById("procurementForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    const submitBtn = document.getElementById("submitBtn");
    const statusEl = document.getElementById("formStatus");

    const entryDateTime = document.getElementById("entryDateTime").value;
    const rawMaterialName = document.getElementById("rawMaterialName").value;
    const quantity = document.getElementById("quantity").value;
    const unit = document.getElementById("unit").value;
    const supplier = document.getElementById("supplier").value.trim();
    const rate = document.getElementById("rate").value;

    if (!entryDateTime || !rawMaterialName || quantity === "" || Number(quantity) <= 0 || !unit || !supplier || rate === "" || Number(rate) < 0) {
      showFormStatus(statusEl, "Please fill in every field. Quantity must be greater than 0.", true);
      return;
    }

    const qtyNum = Number(quantity);
    const rateNum = Number(rate);
    const amountNum = roundNicely(qtyNum * rateNum);

    setButtonBusy(submitBtn, true, "Saving...", "Save Entry");
    try {
      await apiAddRow("RawMaterialProcurement", {
        EntryDateTime: entryDateTime,
        RawMaterialName: rawMaterialName,
        Quantity: qtyNum,
        Unit: unit,
        Supplier: supplier,
        Rate: rateNum,
        Amount: amountNum
      });
      showFormStatus(statusEl, "Procurement entry saved.", false);
      document.getElementById("procurementForm").reset();
      setDefaultDateTime();
      document.getElementById("amount").value = "";

      // Refilled from cache — no network, because a procurement entry
      // cannot have changed the Raw Materials or Units masters.
      loadBothDropdowns(false);
      refreshProcurementList(true);
    } catch (err) {
      showFormStatus(statusEl, err.message, true);
    } finally {
      setButtonBusy(submitBtn, false, "Saving...", "Save Entry");
    }
  });
}

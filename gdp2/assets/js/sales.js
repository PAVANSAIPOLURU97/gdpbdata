/*
  sales.js — logic for pages/sales.html
  Sheet: "Sales"
  Columns: BillNo | EntryDateTime | BillerName | ProductName | Quantity | Unit |
           MasterPrice | MasterQty | MasterUnit | EntryMode | SalePrice | Discount |
           LineTotal | CashPaid | OnlinePaid | BillTotal | AddedBy | Timestamp

  (EntryMode is the ONLY new column vs. the previous version. Everything
   else the sheet already had.)

  ==================================================================
  WHAT CHANGED IN THIS VERSION — the till flow, not the plumbing.

  The old screen showed every product as a card in a grid and treated
  "has a quantity typed into it" as "is on the bill". That works for a
  handful of products and falls apart past a screenful.

  Now: pick one product, enter EITHER a quantity + unit OR a rupee
  amount, press "Add product to bill". The line lands in the summary on
  the right. Repeat for as many products as the customer is buying.

  THE EITHER/OR RULE
    * Type a quantity -> the Amount box fills in and locks.
    * Type an amount  -> the Quantity box fills in and locks, worked out
                         against whichever unit is selected.
    * Change the unit at any time -> whichever box was auto-filled is
                         recalculated. The one the user typed is never
                         touched.
    * "Clear both" unlocks the pair so the user can switch method.
    * The unit defaults to the product's own unit from Product Master,
      and only units of the same family (weight/volume/count) are
      offered, so an impossible conversion can't be picked at all.

  PERFORMANCE — all of it kept from the previous version, unchanged:
    * ProductMaster + Units + EmployeeMaster arrive in ONE request, and
      are served instantly from cache on a revisit (stale-while-
      revalidate; a background refresh only redraws if a bill isn't
      already in progress).
    * The bill number comes from action=nextBillNo, which reads one
      column, so page load never downloads the Sales sheet.
    * A bill is written in ONE request, ONE block write.
    * Saving happens on a background queue: the counter is free for the
      next customer immediately, failures retry, and nothing can be
      lost silently.
    * Everything from choosing a product to pressing Save is pure local
      arithmetic — zero network calls mid-sale.
  ==================================================================
*/

const session = requireLogin("sales");

/*
  Sale prices are rounded to whole rupees, which is what the previous
  version did and what the counter actually deals in. Set this to false
  if you'd rather keep paise on quantity-entered lines. An amount the
  user types by hand is always honoured exactly as typed.
*/
const ROUND_SALE_TO_RUPEE = true;

// --- master data caches ---
let cachedProducts = [];      // available products only (StatusAvailability === "Yes")
let cachedUnitsRaw = [];      // full unit rows: {UnitName, Factor, Family}
let cachedEmployees = [];
let unitByName = {};          // UnitName -> {factor, family}
let productsByName = {};      // ProductName -> product row
let productError = null;

// --- the bill being built (lives only in the browser until Save) ---
let billLines = [];
let editingIndex = -1;        // -1 = adding a new line

// --- entry pair state: null | "qty" | "amount" ---
let entryMode = null;

// --- bill numbering ---
let currentPrefix = "";
let nextSerial = 1;

// --- background save queue ---
let pendingSaves = [];
let saveWorkerRunning = false;

// -------------------------------------------------------------------
// small helpers
// -------------------------------------------------------------------

function el(id) { return document.getElementById(id); }

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value === undefined || value === null ? "" : String(value);
  return div.innerHTML;
}

function round2(num) { return Math.round(num * 100) / 100; }
function round3(num) { return Math.round(num * 1000) / 1000; }

// Drops trailing zeros so 0.500 shows as 0.5 and 2.000 as 2.
function tidyNumber(num) {
  if (num === null || num === undefined || isNaN(num)) return "";
  return String(round3(num));
}

function money(num) { return "\u20B9" + round2(num); }

function setDefaultDateTime() {
  const now = new Date();
  const tzCorrected = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  el("entryDateTime").value = tzCorrected.toISOString().slice(0, 16);
}

function ddmmyy(dateVal) {
  const d = new Date(dateVal);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return dd + mm + yy;
}

// -------------------------------------------------------------------
// master data — ONE request for all three sheets
// -------------------------------------------------------------------

async function loadAllData(force) {
  const data = await apiListMany(
    ["ProductMaster", "Units", "EmployeeMaster"],
    {
      force: !!force,
      allowStale: !force,
      // A stale-first paint must never leave the till on yesterday's
      // price list. When the fresh copy lands and something actually
      // differs, redraw — but only if no bill is part-built, so a
      // cashier mid-sale never loses what they've keyed in.
      onRefreshed: function (changed) {
        if (!changed) return;
        if (billLines.length > 0) return;
        loadAllData(false).then(function () {
          fillBiller();
          fillProductDropdown();
          onProductChange();
        });
      }
    }
  );

  if (data._errors && data._errors.ProductMaster) {
    cachedProducts = [];
    productError = data._errors.ProductMaster;
    console.error("ProductMaster load failed:", productError);
  } else {
    cachedProducts = (data.ProductMaster || []).filter(function (p) {
      return String(p.StatusAvailability).trim().toLowerCase() === "yes";
    });
    productError = null;
  }

  productsByName = {};
  cachedProducts.forEach(function (p) { productsByName[p.ProductName] = p; });

  cachedUnitsRaw = data.Units || [];
  unitByName = {};
  cachedUnitsRaw.forEach(function (u) {
    if (!u.UnitName) return;
    unitByName[u.UnitName] = {
      factor: Number(u.Factor),
      family: (u.Family === undefined || u.Family === null) ? "" : String(u.Family).trim().toLowerCase()
    };
  });

  cachedEmployees = (data.EmployeeMaster || [])
    .map(function (e) { return e.EmployeeName; })
    .filter(Boolean);
}

// -------------------------------------------------------------------
// bill number: GDP + DDMMYY + "-" + serial, serial restarts each day
// -------------------------------------------------------------------

function prefixForCurrentDate() {
  const dtVal = el("entryDateTime").value;
  if (!dtVal) return "";
  return "GDP" + ddmmyy(dtVal) + "-";
}

function computeBillNo() {
  return currentPrefix ? currentPrefix + nextSerial : "";
}

function showBillNo() {
  const no = computeBillNo();
  el("billNo").value = no;
  el("billNoTag").textContent = no;
}

/*
  Asks the server for the next serial for the selected date. Reads one
  column, not the sheet. Runs on load and on a date change only — never
  per bill, so it is never in the cashier's way.
*/
async function syncBillNoFromServer() {
  const prefix = prefixForCurrentDate();
  if (!prefix) return;

  if (prefix !== currentPrefix) {
    currentPrefix = prefix;
    nextSerial = 1;
    showBillNo();
  }

  try {
    const serverBillNo = await apiNextBillNo(prefix);
    if (serverBillNo && serverBillNo.indexOf(prefix) === 0) {
      const serial = parseInt(serverBillNo.slice(prefix.length), 10);
      // Never move backwards — a queued bill may not have landed yet.
      if (!isNaN(serial) && serial > nextSerial) {
        nextSerial = serial;
        showBillNo();
      }
    }
  } catch (err) {
    console.warn("Could not sync bill number, using local counter:", err);
  }
}

// -------------------------------------------------------------------
// the price maths
//
//   base units of the master pack = MasterQty x factor(MasterUnit)
//   price per base unit           = MasterPrice / that
//
//   amount = pricePerBase x enteredQty x factor(enteredUnit)
//   qty    = amount / (pricePerBase x factor(enteredUnit))
//
// Same formula the old version used, now solvable in both directions.
// -------------------------------------------------------------------

function pricePerBaseUnit(product) {
  const mp = Number(product.Price);
  const mq = Number(product.Quantity);
  if (!mp || !mq) return { ok: false, error: "This product has no price or pack size in Product Master." };

  const mu = unitByName[product.Unit];
  if (!mu || isNaN(mu.factor) || mu.factor <= 0) {
    return { ok: false, error: "Unit \u201C" + product.Unit + "\u201D has no factor. Set it in Master \u203A Units." };
  }
  return { ok: true, value: mp / (mq * mu.factor) };
}

function amountFromQty(product, qty, unitName) {
  const ppb = pricePerBaseUnit(product);
  if (!ppb.ok) return { ok: false, error: ppb.error };

  const u = unitByName[unitName];
  if (!u || isNaN(u.factor) || u.factor <= 0) {
    return { ok: false, error: "Unit \u201C" + unitName + "\u201D has no factor. Set it in Master \u203A Units." };
  }

  const raw = ppb.value * Number(qty) * u.factor;
  return { ok: true, value: ROUND_SALE_TO_RUPEE ? Math.round(raw) : round2(raw) };
}

function qtyFromAmount(product, amount, unitName) {
  const ppb = pricePerBaseUnit(product);
  if (!ppb.ok) return { ok: false, error: ppb.error };

  const u = unitByName[unitName];
  if (!u || isNaN(u.factor) || u.factor <= 0) {
    return { ok: false, error: "Unit \u201C" + unitName + "\u201D has no factor. Set it in Master \u203A Units." };
  }

  const perSelectedUnit = ppb.value * u.factor;
  if (!perSelectedUnit) return { ok: false, error: "Cannot work out a quantity for this product." };

  return { ok: true, value: round3(Number(amount) / perSelectedUnit) };
}

// -------------------------------------------------------------------
// entry form
// -------------------------------------------------------------------

function currentProduct() {
  return productsByName[el("productName").value] || null;
}

function fillProductDropdown() {
  const sel = el("productName");
  const keep = sel.value;

  if (productError) {
    sel.innerHTML = '<option value="">' + escapeHtml(productError) + "</option>";
    return;
  }
  if (cachedProducts.length === 0) {
    sel.innerHTML = '<option value="">No products available. Add them in Master \u203A Product Master and set Available = Yes.</option>';
    return;
  }

  let html = '<option value="">Select a product</option>';
  cachedProducts.forEach(function (p) {
    const name = escapeHtml(p.ProductName);
    html += '<option value="' + name + '">' + name + "</option>";
  });
  sel.innerHTML = html;

  if (keep && productsByName[keep]) sel.value = keep;
}

/*
  Offers only units the product can actually be sold in — same family as
  its Product Master unit. A unit with no family set is always offered,
  so a half-configured Units sheet never blocks a sale.
*/
function fillUnitDropdown(product) {
  const sel = el("unit");
  if (!product) { sel.innerHTML = '<option value="">Unit</option>'; return; }

  const masterUnit = unitByName[product.Unit];
  const masterFamily = masterUnit ? masterUnit.family : "";

  let html = "";
  cachedUnitsRaw.forEach(function (u) {
    if (!u.UnitName) return;
    const info = unitByName[u.UnitName];
    if (!info || isNaN(info.factor) || info.factor <= 0) return;
    if (masterFamily && info.family && info.family !== masterFamily) return;

    const name = escapeHtml(u.UnitName);
    html += '<option value="' + name + '">' + name + "</option>";
  });

  sel.innerHTML = html || '<option value="">No usable units</option>';
  sel.value = product.Unit;                      // default from Product Master
  if (sel.value !== product.Unit) sel.selectedIndex = 0;
}

function showRateStrip(product) {
  const strip = el("rateStrip");
  if (!product) { strip.textContent = "Pick a product to see its rate."; strip.classList.remove("bad"); return; }

  const ppb = pricePerBaseUnit(product);
  if (!ppb.ok) {
    strip.textContent = ppb.error;
    strip.classList.add("bad");
    return;
  }
  strip.classList.remove("bad");

  let text = money(product.Price) + " per " + tidyNumber(Number(product.Quantity)) + " " + product.Unit;

  // If the cashier has switched to a different unit, show what that unit costs.
  const chosenUnit = el("unit").value;
  if (chosenUnit && chosenUnit !== product.Unit) {
    const u = unitByName[chosenUnit];
    if (u && u.factor > 0) {
      text += "  \u2022  " + money(ppb.value * u.factor) + " per 1 " + chosenUnit;
    }
  }
  strip.textContent = text;
}

function setLineError(message) {
  const box = el("lineError");
  box.textContent = message || "";
  box.style.display = message ? "block" : "none";
}

function setLinePrice(value) {
  el("linePriceValue").textContent = value === null ? "\u20B90" : money(value);
}

function lockField(input, locked) {
  input.disabled = locked;
  input.classList.toggle("is-derived", locked);
}

// Nothing typed in either box yet — both open.
function unlockPair() {
  entryMode = null;
  lockField(el("quantity"), false);
  lockField(el("amount"), false);
}

function clearEntryPair() {
  el("quantity").value = "";
  el("amount").value = "";
  unlockPair();
  setLinePrice(null);
  setLineError("");
}

/*
  The heart of the either/or rule. `source` says which box the user just
  touched: "qty", "amount", or "unit" (a unit change recalculates
  whichever box was auto-filled, never the one that was typed).
*/
function recalcEntry(source) {
  const product = currentProduct();
  const qtyEl = el("quantity");
  const amountEl = el("amount");
  const unitName = el("unit").value;

  setLineError("");

  if (!product) { setLinePrice(null); return; }

  if (source === "qty") {
    if (qtyEl.value === "") { clearEntryPair(); showRateStrip(product); return; }
    entryMode = "qty";
    lockField(amountEl, true);
    lockField(qtyEl, false);
  } else if (source === "amount") {
    if (amountEl.value === "") { clearEntryPair(); showRateStrip(product); return; }
    entryMode = "amount";
    lockField(qtyEl, true);
    lockField(amountEl, false);
  }

  showRateStrip(product);

  if (entryMode === "qty") {
    const qty = Number(qtyEl.value);
    if (!(qty > 0)) { amountEl.value = ""; setLinePrice(null); return; }

    const res = amountFromQty(product, qty, unitName);
    if (!res.ok) { amountEl.value = ""; setLinePrice(null); setLineError(res.error); return; }

    amountEl.value = round2(res.value);
    setLinePrice(res.value);

  } else if (entryMode === "amount") {
    const amount = Number(amountEl.value);
    if (!(amount > 0)) { qtyEl.value = ""; setLinePrice(null); return; }

    const res = qtyFromAmount(product, amount, unitName);
    if (!res.ok) { qtyEl.value = ""; setLinePrice(null); setLineError(res.error); return; }

    qtyEl.value = res.value;
    setLinePrice(round2(amount));          // honour the typed amount exactly

  } else {
    setLinePrice(null);
  }
}

function onProductChange() {
  const product = currentProduct();
  fillUnitDropdown(product);
  clearEntryPair();
  showRateStrip(product);
}

// -------------------------------------------------------------------
// adding a line to the bill
// -------------------------------------------------------------------

function addOrUpdateLine() {
  const product = currentProduct();

  if (!product) { setLineError("Choose a product first."); return; }
  if (!entryMode) { setLineError("Enter a quantity or an amount."); return; }

  const qty = Number(el("quantity").value);
  const unitName = el("unit").value;
  const amount = Number(el("amount").value);

  if (!(qty > 0)) { setLineError("Quantity works out to zero. Check the amount or the unit."); return; }
  if (!unitName) { setLineError("Choose a unit."); return; }
  if (!(amount > 0)) { setLineError("Price works out to zero. Check the quantity or the unit."); return; }

  const line = {
    productName: product.ProductName,
    quantity: round3(qty),
    unit: unitName,
    masterPrice: Number(product.Price),
    masterQty: Number(product.Quantity),
    masterUnit: product.Unit,
    entryMode: entryMode,
    salePrice: round2(amount),
    // Keep the discount when a line is edited rather than silently zeroing it.
    discount: editingIndex >= 0 ? billLines[editingIndex].discount : 0
  };

  if (editingIndex >= 0) {
    billLines[editingIndex] = line;
    stopEditing();
  } else {
    billLines.push(line);
  }

  renderBill();

  // Reset for the next product and put the cursor back at the top.
  el("productName").value = "";
  onProductChange();
  el("productName").focus();
}

function startEditing(index) {
  const line = billLines[index];
  if (!line) return;

  editingIndex = index;
  el("entryHeading").textContent = "Edit line " + (index + 1);
  el("addProductBtn").textContent = "Update this line";
  el("cancelEditBtn").style.display = "block";

  el("productName").value = line.productName;
  const product = currentProduct();
  fillUnitDropdown(product);
  el("unit").value = line.unit;

  // Put the value back into the box the cashier originally typed into,
  // then let the normal recalculation fill and lock the other one.
  clearEntryPair();
  if (line.entryMode === "amount") {
    el("amount").value = line.salePrice;
    recalcEntry("amount");
  } else {
    el("quantity").value = line.quantity;
    recalcEntry("qty");
  }

  el("quantity").scrollIntoView({ block: "center", behavior: "smooth" });
}

function stopEditing() {
  editingIndex = -1;
  el("entryHeading").textContent = "Add a product to this bill";
  el("addProductBtn").textContent = "+ Add product to bill";
  el("cancelEditBtn").style.display = "none";
}

function removeLine(index) {
  if (editingIndex === index) stopEditing();
  billLines.splice(index, 1);
  renderBill();
}

// -------------------------------------------------------------------
// bill summary — this bill only
// -------------------------------------------------------------------

function lineFinal(line) {
  return round2(Math.max(0, line.salePrice - (Number(line.discount) || 0)));
}

function currentBillTotal() {
  let total = 0;
  billLines.forEach(function (ln) { total += lineFinal(ln); });
  return round2(total);
}

function renderBill() {
  const body = el("billBody");
  const foot = el("billFoot");

  if (billLines.length === 0) {
    body.innerHTML = '<tr><td colspan="8" class="bill-empty">Nothing on this bill yet. Add a product on the left.</td></tr>';
    foot.innerHTML = "";
    el("billTotalBox").textContent = "Bill total: \u20B90";
    updatePaymentCheck(0);
    return;
  }

  const parts = [];
  billLines.forEach(function (ln, i) {
    parts.push("<tr>" +
      '<td class="bill-rownum">' + (i + 1) + "</td>" +
      "<td>" + escapeHtml(ln.productName) + "</td>" +
      '<td class="num">' + escapeHtml(tidyNumber(ln.quantity)) + "</td>" +
      "<td>" + escapeHtml(ln.unit) + "</td>" +
      '<td class="num">' + round2(ln.salePrice) + "</td>" +
      '<td class="num"><input type="number" class="discount-input" data-line="' + i +
        '" step="0.01" min="0" value="' + (Number(ln.discount) || 0) + '" aria-label="Discount for ' + escapeHtml(ln.productName) + '"></td>' +
      '<td class="num line-final" data-role="lineTotal" data-line="' + i + '">' + round2(lineFinal(ln)) + "</td>" +
      '<td class="bill-actions">' +
        '<button type="button" class="row-button" data-act="edit" data-line="' + i + '" title="Edit this line">\u270E</button>' +
        '<button type="button" class="row-button danger" data-act="remove" data-line="' + i + '" title="Remove this line">\u2715</button>' +
      "</td>" +
    "</tr>");
  });

  body.innerHTML = parts.join("");
  updateBillTotals();
}

/*
  Footer + total + payment check only. This is what a discount keystroke
  runs — no table rebuild, so the caret never jumps.
*/
function updateBillTotals() {
  let totalSale = 0, totalDisc = 0, totalFinal = 0;

  billLines.forEach(function (ln) {
    totalSale += Number(ln.salePrice) || 0;
    totalDisc += Number(ln.discount) || 0;
    totalFinal += lineFinal(ln);
  });

  el("billFoot").innerHTML = "<tr>" +
    '<td colspan="4">Total &mdash; ' + billLines.length + " item" + (billLines.length === 1 ? "" : "s") + "</td>" +
    '<td class="num">' + round2(totalSale) + "</td>" +
    '<td class="num">' + round2(totalDisc) + "</td>" +
    '<td class="num">' + round2(totalFinal) + "</td>" +
    "<td></td>" +
  "</tr>";

  el("billTotalBox").textContent = "Bill total: " + money(totalFinal);
  updatePaymentCheck(round2(totalFinal));
}

// -------------------------------------------------------------------
// payment: cash + UPI must equal the bill total
// -------------------------------------------------------------------

function updatePaymentCheck(billTotal) {
  const cash = Number(el("cashPaid").value) || 0;
  const online = Number(el("onlinePaid").value) || 0;
  const paid = round2(cash + online);
  const box = el("paymentCheck");

  if (billTotal <= 0) { box.textContent = ""; box.className = "payment-check"; return; }

  if (paid === billTotal) {
    box.className = "payment-check ok";
    box.textContent = "\u2713 Cash + UPI matches the bill total (" + money(billTotal) + ")";
  } else {
    box.className = "payment-check bad";
    const diff = round2(billTotal - paid);
    box.textContent = diff > 0
      ? "Short by " + money(diff) + " \u2014 " + money(paid) + " entered against " + money(billTotal)
      : "Over by " + money(Math.abs(diff)) + " \u2014 " + money(paid) + " entered against " + money(billTotal);
  }
}

function fillBiller() {
  const sel = el("billerName");
  const keep = sel.value;

  // The logged-in user is always an option, even if they aren't in
  // Employee Master, so the biller box is never empty on a fresh login.
  const names = cachedEmployees.slice();
  if (session && session.name && names.indexOf(session.name) === -1) names.unshift(session.name);

  if (names.length === 0) {
    sel.innerHTML = '<option value="">No employees yet \u2014 add them in Master \u203A Employee Master</option>';
    return;
  }

  let html = "";
  names.forEach(function (name) {
    html += '<option value="' + escapeHtml(name) + '">' + escapeHtml(name) + "</option>";
  });
  sel.innerHTML = html;

  if (keep && names.indexOf(keep) !== -1) {
    sel.value = keep;
  } else if (session && session.name && names.indexOf(session.name) !== -1) {
    sel.value = session.name;              // default: whoever is logged in
  }
}

// -------------------------------------------------------------------
// background save queue
// -------------------------------------------------------------------

function pendingCountLabel() {
  if (pendingSaves.length === 0) return "";
  return " (" + pendingSaves.length + " bill" + (pendingSaves.length > 1 ? "s" : "") + " still saving)";
}

function queueBillSave(job) {
  pendingSaves.push(job);
  runSaveWorker();
}

async function runSaveWorker() {
  if (saveWorkerRunning) return;
  saveWorkerRunning = true;

  const statusEl = el("formStatus");

  while (pendingSaves.length > 0) {
    const job = pendingSaves[0];
    try {
      const result = await apiAddRows("Sales", job.rows, {
        billNoField: "BillNo",
        billNoPrefix: job.prefix
      });

      pendingSaves.shift();

      // The server may have bumped the serial (another till saved first).
      const savedNo = result.billNo || job.billNo;
      if (result.billNo && result.billNo !== job.billNo) {
        const serial = parseInt(String(result.billNo).slice(job.prefix.length), 10);
        if (!isNaN(serial) && serial >= nextSerial) {
          nextSerial = serial + 1;
          showBillNo();
        }
      }

      showFormStatus(
        statusEl,
        "Bill " + savedNo + " saved \u2014 " + job.rows.length + " item(s), " + money(job.billTotal) + "." + pendingCountLabel(),
        false
      );
    } catch (err) {
      job.attempts = (job.attempts || 0) + 1;

      if (job.attempts < 3) {
        showFormStatus(statusEl, "Bill " + job.billNo + " is retrying (" + err.message + ")...", true);
        await new Promise(function (r) { setTimeout(r, 1200 * job.attempts); });
        continue;
      }

      // Give up automatically but KEEP the bill queued so it can be
      // retried by hand — nothing is thrown away.
      showFormStatus(
        statusEl,
        "Bill " + job.billNo + " could not be saved: " + err.message +
        " It is still held on this page \u2014 press \u201CRetry pending bills\u201D once the connection is back. Do not close this tab.",
        true
      );
      showRetryButton();
      break;
    }
  }

  saveWorkerRunning = false;
  if (pendingSaves.length === 0) hideRetryButton();
}

function showRetryButton() {
  let btn = el("retryPendingBtn");
  if (btn) { btn.style.display = "block"; return; }

  btn = document.createElement("button");
  btn.id = "retryPendingBtn";
  btn.type = "button";
  btn.className = "secondary-button";
  btn.style.marginTop = "var(--space-sm)";
  btn.textContent = "\u21BB Retry pending bills";
  btn.addEventListener("click", function () {
    pendingSaves.forEach(function (j) { j.attempts = 0; });
    runSaveWorker();
  });

  const statusEl = el("formStatus");
  statusEl.parentNode.insertBefore(btn, statusEl.nextSibling);
}

function hideRetryButton() {
  const btn = el("retryPendingBtn");
  if (btn) btn.style.display = "none";
}

window.addEventListener("beforeunload", function (e) {
  if (pendingSaves.length > 0) {
    e.preventDefault();
    e.returnValue = "";
    return "";
  }
});

// -------------------------------------------------------------------
// save the bill
// -------------------------------------------------------------------

function onSaveBill() {
  const statusEl = el("formStatus");

  const entryDateTime = el("entryDateTime").value;
  const billerName = el("billerName").value;
  const cashPaid = Number(el("cashPaid").value) || 0;
  const onlinePaid = Number(el("onlinePaid").value) || 0;

  if (!entryDateTime) { showFormStatus(statusEl, "Set the date and time for this bill.", true); return; }
  if (!billerName) { showFormStatus(statusEl, "Choose who is billing.", true); return; }
  if (billLines.length === 0) { showFormStatus(statusEl, "Add at least one product before saving.", true); return; }

  if (editingIndex >= 0) {
    showFormStatus(statusEl, "Finish editing line " + (editingIndex + 1) + " first \u2014 press \u201CUpdate this line\u201D or \u201CCancel edit\u201D.", true);
    return;
  }

  const billTotal = currentBillTotal();
  const paid = round2(cashPaid + onlinePaid);
  if (paid !== billTotal) {
    showFormStatus(statusEl,
      "Cash " + money(cashPaid) + " + UPI " + money(onlinePaid) + " = " + money(paid) +
      ", but the bill total is " + money(billTotal) + ". Correct the split before saving.", true);
    return;
  }

  const prefix = prefixForCurrentDate();
  const billNo = el("billNo").value || computeBillNo();

  const rows = billLines.map(function (ln) {
    return {
      BillNo: billNo,
      EntryDateTime: entryDateTime,
      BillerName: billerName,
      ProductName: ln.productName,
      Quantity: ln.quantity,
      Unit: ln.unit,
      MasterPrice: ln.masterPrice,
      MasterQty: ln.masterQty,
      MasterUnit: ln.masterUnit,
      EntryMode: ln.entryMode,
      SalePrice: round2(ln.salePrice),
      Discount: round2(Number(ln.discount) || 0),
      LineTotal: lineFinal(ln),
      CashPaid: round2(cashPaid),
      OnlinePaid: round2(onlinePaid),
      BillTotal: billTotal
    };
  });

  // Hand the bill to the background queue and free the counter now.
  queueBillSave({ rows: rows, billNo: billNo, prefix: prefix, billTotal: billTotal, attempts: 0 });

  showFormStatus(statusEl, "Bill " + billNo + " sent to the sheet. Ready for the next customer." + pendingCountLabel(), false);

  nextSerial = nextSerial + 1;
  resetBill();
}

function resetBill() {
  billLines = [];
  stopEditing();
  el("productName").value = "";
  onProductChange();
  el("cashPaid").value = "0";
  el("onlinePaid").value = "0";
  setDefaultDateTime();
  showBillNo();
  renderBill();
}

// -------------------------------------------------------------------
// init
// -------------------------------------------------------------------

if (session) {
  setImage(el("appLogo"), "appLogo");
  setImage(el("logoutIcon"), "logoutIcon");
  el("userLabel").textContent = session.name + " (" + session.role + ")";
  el("logoutBtn").addEventListener("click", logout);

  // Wake the Apps Script container while the page is still drawing.
  apiWarmUp();

  setDefaultDateTime();
  currentPrefix = prefixForCurrentDate();
  showBillNo();
  el("productName").innerHTML = '<option value="">Loading products...</option>';
  renderBill();

  // --- entry form ---
  el("productName").addEventListener("change", onProductChange);
  el("quantity").addEventListener("input", function () { recalcEntry("qty"); });
  el("amount").addEventListener("input", function () { recalcEntry("amount"); });
  el("unit").addEventListener("change", function () { recalcEntry("unit"); });
  el("clearEntryBtn").addEventListener("click", function () {
    clearEntryPair();
    showRateStrip(currentProduct());
    el("quantity").focus();
  });
  el("addProductBtn").addEventListener("click", addOrUpdateLine);
  el("cancelEditBtn").addEventListener("click", function () {
    stopEditing();
    el("productName").value = "";
    onProductChange();
  });

  // Enter anywhere in the entry pair adds the line — keeps the till on keyboard.
  ["quantity", "amount", "unit"].forEach(function (id) {
    el(id).addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); addOrUpdateLine(); }
    });
  });

  // --- bill summary: delegated, bound once ---
  el("billBody").addEventListener("input", function (e) {
    if (!e.target.classList.contains("discount-input")) return;

    const i = Number(e.target.dataset.line);
    const ln = billLines[i];
    if (!ln) return;

    const raw = e.target.value === "" ? 0 : Number(e.target.value);
    ln.discount = isNaN(raw) ? 0 : Math.max(0, raw);

    const cell = document.querySelector('[data-role="lineTotal"][data-line="' + i + '"]');
    if (cell) cell.textContent = round2(lineFinal(ln));

    updateBillTotals();
  });

  el("billBody").addEventListener("click", function (e) {
    const btn = e.target.closest(".row-button");
    if (!btn) return;
    const i = Number(btn.dataset.line);
    if (btn.dataset.act === "remove") removeLine(i);
    else if (btn.dataset.act === "edit") startEditing(i);
  });

  // --- payment ---
  el("cashPaid").addEventListener("input", function () { updatePaymentCheck(currentBillTotal()); });
  el("onlinePaid").addEventListener("input", function () { updatePaymentCheck(currentBillTotal()); });
  el("allCashBtn").addEventListener("click", function () {
    el("cashPaid").value = currentBillTotal();
    el("onlinePaid").value = 0;
    updatePaymentCheck(currentBillTotal());
  });
  el("allUpiBtn").addEventListener("click", function () {
    el("onlinePaid").value = currentBillTotal();
    el("cashPaid").value = 0;
    updatePaymentCheck(currentBillTotal());
  });

  el("entryDateTime").addEventListener("change", syncBillNoFromServer);
  el("submitBtn").addEventListener("click", onSaveBill);

  el("refreshBtn").addEventListener("click", async function () {
    const btn = el("refreshBtn");
    const label = "\u21BB Refresh products / units / employees";
    setButtonBusy(btn, true, "Refreshing...", label);
    await loadAllData(true);
    fillBiller();
    fillProductDropdown();
    onProductChange();
    await syncBillNoFromServer();
    setButtonBusy(btn, false, "Refreshing...", label);
  });

  (async function init() {
    // Draw the till as soon as the master data lands...
    await loadAllData(false);
    fillBiller();
    fillProductDropdown();
    onProductChange();

    // ...then settle the bill number in the background. The cashier can
    // already start ringing items up while this finishes.
    syncBillNoFromServer();
  })();
}

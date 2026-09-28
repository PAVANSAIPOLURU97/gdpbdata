/*
  orders.js — logic for pages/orders.html
  Sheet: "Orders"
  Columns: OrderRef | OrderDateTime | CustomerName | DeliveryDateTime |
           ProductName | Quantity | Unit | MasterPrice | MasterQty | MasterUnit |
           Amount | Discount | FinalAmount | OrderTotal | AdvanceAmount |
           BalancePayable | AddedBy | Timestamp
           + NEW (appended at the end of the sheet):
           CustomerMobile | CustomerAddress | RatePrice | RateUnit |
           MasterRate | RateDiscount | ManualDiscount

  ==================================================================
  WHAT THIS SCREEN DOES

  A customer orders goods now for delivery later. The user records:
    * when the order was taken, who ordered, their mobile number(s),
      the delivery address, and when it is to be delivered
    * one line per product: product, quantity, unit, and the rate

  THE PRICE MATHS — unchanged from before:
      base units in the master pack = MasterQty x factor(MasterUnit)
      price per base unit           = MasterPrice / that
      amount = pricePerBase x quantity x factor(chosen unit)

  ------------------------------------------------------------------
  NEW IN THIS VERSION — the editable rate

  Under Quantity/Unit there is now a "Price per unit" pair. It opens
  showing the master rate expressed per ONE unit (a 350 per 0.5 Kg
  master shows as 700 per Kg) and BOTH boxes can be changed.

  The line is then priced at the entered rate, converted through the
  unit factors exactly the way the master rate is:

      rate per base unit = RatePrice / factor(RateUnit)
      charged amount     = rate per base unit x quantity x factor(Unit)

  So on a 100/Kg master:
      50 per Kg   -> 1 Kg costs  50
      10 per gms  -> 1 Kg costs  10,000   (10 x 1000)

  The Amount column still shows what the MASTER price says the line is
  worth. The gap between that and the charged amount drops straight
  into the Discount box:

      Discount = Amount (master) - Amount (entered rate)

  so Amount - Discount = what the customer actually pays. Raising the
  rate above master gives a NEGATIVE discount, i.e. a surcharge, and
  the Final column still reads correctly.

  The Discount box stays fully editable. Anything typed there on top of
  the auto figure is remembered as an extra discount and survives a
  later edit of the line's quantity or rate.
  ------------------------------------------------------------------

  PERFORMANCE — the same pattern the rest of the app uses:
    * ProductMaster + Units arrive in ONE request and are served
      instantly from cache on a revisit.
    * Everything from picking a product to pressing Save is local
      arithmetic — no network calls in between.
    * The whole order is written in ONE request, ONE block write.
  ==================================================================
*/

const session = requireLogin("orders");

// Whole rupees, same as the till. Set to false to keep paise.
const ROUND_PRICE_TO_RUPEE = true;

// Set to false if an order should be saveable without a phone number.
const REQUIRE_MOBILE = true;
// Set to true to make the delivery address compulsory.
const REQUIRE_ADDRESS = false;

// --- master data caches ---
let cachedProducts = [];      // available products only (StatusAvailability === "Yes")
let cachedUnitsRaw = [];      // full unit rows: {UnitName, Factor, Family}
let unitByName = {};          // UnitName -> {factor, family}
let productsByName = {};      // ProductName -> product row
let productError = null;

// --- the order being built (lives only in the browser until Save) ---
let orderLines = [];
let editingIndex = -1;        // -1 = adding a new line

/*
  The rate box holds a rounded string, but the number behind it can have
  more decimals than that (a 350 per 0.5 Kg master is 0.35 per gm, and a
  33.333 per Kg master is 0.033333 per gm). We keep the exact figure here
  so that merely switching the rate unit never invents a stray discount.
  It is dropped the moment the user types their own price.
*/
let exactRatePrice = null;

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
function round4(num) { return Math.round(num * 10000) / 10000; }

// Whole rupees or paise, depending on ROUND_PRICE_TO_RUPEE.
function roundMoney(num) {
  return ROUND_PRICE_TO_RUPEE ? Math.round(num) : round2(num);
}

// Drops trailing zeros so 0.500 shows as 0.5 and 2.000 as 2.
function tidyNumber(num) {
  if (num === null || num === undefined || isNaN(num)) return "";
  return String(round3(num));
}

// Same idea, but for a rate, which needs finer detail than 3 decimals.
function tidyRate(num) {
  if (num === null || num === undefined || isNaN(num)) return "";
  return String(round4(num));
}

function money(num) { return "\u20B9" + round2(num); }

function localNow() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000);
}

function setDefaultOrderDateTime() {
  el("orderDateTime").value = localNow().toISOString().slice(0, 16);
}

// Delivery starts a day ahead — the common case, and easy to change.
function setDefaultDeliveryDateTime() {
  const tomorrow = new Date(localNow().getTime() + 24 * 60 * 60 * 1000);
  el("deliveryDateTime").value = tomorrow.toISOString().slice(0, 16);
}

function ddmmyy(dateVal) {
  const d = new Date(dateVal);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return dd + mm + yy;
}

// A reference that ties every row of one order together in the sheet.
// Built from the clock, so it needs no server round trip.
function makeOrderRef() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return "ORD" + ddmmyy(d) + "-" + hh + mi + ss;
}

function prettyDateTime(value) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/*
  Customer can leave several numbers in one box, separated by commas,
  slashes, spaces or new lines. Everything that is not a digit or a
  leading + is treated as a separator.
*/
function parseMobiles(raw) {
  return String(raw || "")
    .split(/[^0-9+]+/)
    .filter(function (t) { return t.length > 0; });
}

function digitsOnly(value) {
  return String(value || "").replace(/[^0-9]/g, "");
}

// Permissive on purpose: 7 to 15 digits covers landlines, mobiles and
// numbers written with a country code.
function mobilesProblem(list) {
  for (let i = 0; i < list.length; i++) {
    const d = digitsOnly(list[i]);
    if (d.length < 7 || d.length > 15) {
      return "\u201C" + list[i] + "\u201D does not look like a phone number. " +
        "Separate several numbers with a comma.";
    }
  }
  return null;
}

// -------------------------------------------------------------------
// master data — ONE request for both sheets
// -------------------------------------------------------------------

async function loadAllData(force) {
  const data = await apiListMany(
    ["ProductMaster", "Units"],
    {
      force: !!force,
      allowStale: !force,
      // A stale-first paint must never leave this screen on yesterday's
      // price list. When the fresh copy lands and something differs,
      // redraw — but only if no order is part-built, so nothing the
      // user has already keyed in is lost.
      onRefreshed: function (changed) {
        if (!changed) return;
        if (orderLines.length > 0) return;
        loadAllData(false).then(function () {
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
}

// -------------------------------------------------------------------
// the price maths
// -------------------------------------------------------------------

function factorOf(unitName) {
  const u = unitByName[unitName];
  if (!u || isNaN(u.factor) || u.factor <= 0) return null;
  return u.factor;
}

function pricePerBaseUnit(product) {
  const mp = Number(product.Price);
  const mq = Number(product.Quantity);
  if (!mp || !mq) return { ok: false, error: "This product has no price or pack size in Product Master." };

  const f = factorOf(product.Unit);
  if (f === null) {
    return { ok: false, error: "Unit \u201C" + product.Unit + "\u201D has no factor. Set it in Master \u203A Units." };
  }
  return { ok: true, value: mp / (mq * f) };
}

function amountFromQty(product, qty, unitName) {
  const ppb = pricePerBaseUnit(product);
  if (!ppb.ok) return { ok: false, error: ppb.error };

  const f = factorOf(unitName);
  if (f === null) {
    return { ok: false, error: "Unit \u201C" + unitName + "\u201D has no factor. Set it in Master \u203A Units." };
  }

  return { ok: true, value: roundMoney(ppb.value * Number(qty) * f) };
}

// What the master price works out to for ONE of `unitName`.
// 350 per 0.5 Kg -> 700 per Kg -> 0.7 per gm.
function masterRatePerUnit(product, unitName) {
  const ppb = pricePerBaseUnit(product);
  if (!ppb.ok) return null;
  const f = factorOf(unitName);
  if (f === null) return null;
  return ppb.value * f;
}

/*
  The heart of the change. Prices one line twice — once at the master
  rate, once at the rate the user typed — and reports the gap between
  them, which is the discount.

  Both amounts are rounded the same way before subtracting, so
  Amount - Discount always lands exactly on the charged figure and no
  stray paise can appear.
*/
function computeLine(product, qty, qtyUnit, ratePrice, rateUnit) {
  const ppb = pricePerBaseUnit(product);
  if (!ppb.ok) return { ok: false, error: ppb.error };

  const fq = factorOf(qtyUnit);
  if (fq === null) {
    return { ok: false, error: "Unit \u201C" + qtyUnit + "\u201D has no factor. Set it in Master \u203A Units." };
  }

  const fr = factorOf(rateUnit);
  if (fr === null) {
    return { ok: false, error: "Unit \u201C" + rateUnit + "\u201D has no factor. Set it in Master \u203A Units." };
  }

  const rate = Number(ratePrice);
  if (isNaN(rate) || rate < 0) {
    return { ok: false, error: "Enter a price of 0 or more." };
  }

  const baseQty = Number(qty) * fq;              // quantity in base units
  const masterAmount = roundMoney(ppb.value * baseQty);
  const chargedAmount = roundMoney((rate / fr) * baseQty);

  return {
    ok: true,
    masterAmount: masterAmount,
    chargedAmount: chargedAmount,
    rateDiscount: round2(masterAmount - chargedAmount),
    masterRate: ppb.value * fr                    // master price per 1 rateUnit
  };
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
  Offers only units the product can actually be ordered in — same family
  as its Product Master unit. A unit with no family set is always
  offered, so a half-configured Units sheet never blocks an order.
*/
function unitOptionsHtml(product) {
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
  return html;
}

// Every usable unit, with no family filter. Used before a product has
// been picked, so the "Per 1" box is never an empty dropdown.
function allUnitOptionsHtml() {
  let html = "";
  cachedUnitsRaw.forEach(function (u) {
    if (!u.UnitName) return;
    if (factorOf(u.UnitName) === null) return;
    const name = escapeHtml(u.UnitName);
    html += '<option value="' + name + '">' + name + "</option>";
  });
  return html;
}

function fillUnitDropdown(product) {
  const sel = el("unit");
  if (!sel) return;
  if (!product) { sel.innerHTML = '<option value="">Unit</option>'; return; }

  sel.innerHTML = unitOptionsHtml(product) || '<option value="">No usable units</option>';
  sel.value = product.Unit;                      // default from Product Master
  if (sel.value !== product.Unit) sel.selectedIndex = 0;
}

/*
  The rate's own unit list — same family rules as the quantity unit, and
  it defaults to the product's master unit so the box opens on familiar
  ground.

  With no product chosen yet it falls back to every usable unit rather
  than being left blank, and it always records the unit it is showing in
  dataset.prev so a later change can convert the money across correctly.
*/
function fillRateUnitDropdown(product, preferredUnit) {
  const sel = el("rateUnit");
  if (!sel) return;

  const html = product ? unitOptionsHtml(product) : allUnitOptionsHtml();
  sel.innerHTML = html ||
    '<option value="">No units set up \u2014 add them in Master \u203A Units</option>';

  const wanted = preferredUnit || (product ? product.Unit : "");
  if (wanted) {
    sel.value = wanted;
    if (sel.value !== wanted) sel.selectedIndex = 0;
  }
  sel.dataset.prev = sel.value;
}

// Puts the master rate into the price box for whatever rate unit is
// currently selected. Called on product change and on "Reset to master".
function resetRateToMaster(product, keepUnit) {
  // The unit list is filled either way — an empty "Per 1" box was the
  // bug this guards against.
  fillRateUnitDropdown(product, keepUnit);

  if (!product) {
    el("ratePrice").value = "";
    exactRatePrice = null;
    return;
  }

  const rate = masterRatePerUnit(product, el("rateUnit").value);
  exactRatePrice = rate;
  el("ratePrice").value = (rate === null) ? "" : tidyRate(rate);
}

/*
  Reading the rate back. If the box still holds exactly what we put in
  it, use the full-precision number instead of the rounded one on screen
  — that is what stops "switch to gms and switch back" from creating a
  one-rupee discount out of nowhere.
*/
function currentRatePrice() {
  const typed = el("ratePrice").value;
  if (typed === "") return null;
  const num = Number(typed);
  if (isNaN(num)) return null;
  if (exactRatePrice !== null && round4(exactRatePrice) === round4(num)) return exactRatePrice;
  return num;
}

// Rate unit changed — carry the SAME money across to the new unit so the
// discount stays where it was. 350/Kg becomes 0.35/gms, not 350/gms.
function onRateUnitChange() {
  const product = currentProduct();
  if (!product) return;

  const oldRate = currentRatePrice();
  const oldUnit = el("rateUnit").dataset.prev || "";
  const fOld = factorOf(oldUnit);
  const fNew = factorOf(el("rateUnit").value);

  if (oldRate !== null && fOld !== null && fNew !== null) {
    const converted = (oldRate / fOld) * fNew;
    exactRatePrice = converted;
    el("ratePrice").value = tidyRate(converted);
  } else {
    resetRateToMaster(product, el("rateUnit").value);
  }

  el("rateUnit").dataset.prev = el("rateUnit").value;
  recalcPrice();
}

// Shows the master pack exactly as Product Master holds it, plus what
// one of the currently chosen unit costs.
function showRateStrip(product) {
  const strip = el("rateStrip");
  if (!product) { strip.textContent = "Pick a product to see its price."; strip.classList.remove("bad"); return; }

  const ppb = pricePerBaseUnit(product);
  if (!ppb.ok) {
    strip.textContent = ppb.error;
    strip.classList.add("bad");
    return;
  }
  strip.classList.remove("bad");

  let text = "Master price: " + money(product.Price) + " per " +
    tidyNumber(Number(product.Quantity)) + " " + product.Unit;

  const chosenUnit = el("unit").value;
  if (chosenUnit && chosenUnit !== product.Unit) {
    const f = factorOf(chosenUnit);
    if (f !== null) {
      text += "  \u2022  " + money(ppb.value * f) + " per 1 " + chosenUnit;
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
  el("linePriceValue").textContent = (value === null) ? "\u20B90" : money(value);
}

function setRateHint(text, isWarning) {
  const hint = el("rateHint");
  hint.textContent = text || "";
  hint.className = "rate-editor-hint" + (isWarning ? " warn" : "");
}

// Quantity, unit or rate changed — work the amount out again.
function recalcPrice() {
  const product = currentProduct();
  setLineError("");

  if (!product) { setLinePrice(null); setRateHint(""); return; }

  showRateStrip(product);

  const qty = Number(el("quantity").value);
  const unitName = el("unit").value;
  const ratePrice = currentRatePrice();
  const rateUnit = el("rateUnit").value;

  // With no rate typed there is nothing to price the line at.
  if (ratePrice === null) {
    setLinePrice(null);
    setRateHint("Enter a price per unit.", true);
    return;
  }

  const masterRate = masterRatePerUnit(product, rateUnit);
  if (masterRate !== null) {
    let hint = "Master rate: " + money(masterRate) + " per 1 " + rateUnit + ".";
    const gap = round2(masterRate - ratePrice);
    if (gap > 0) hint += "  You are charging " + money(gap) + " less per " + rateUnit + ".";
    else if (gap < 0) hint += "  You are charging " + money(-gap) + " MORE per " + rateUnit + ".";
    setRateHint(hint, gap < 0);
  } else {
    setRateHint("");
  }

  if (el("quantity").value === "" || !(qty > 0)) { setLinePrice(null); return; }

  const res = computeLine(product, qty, unitName, ratePrice, rateUnit);
  if (!res.ok) { setLinePrice(null); setLineError(res.error); return; }

  setLinePrice(res.chargedAmount);

  if (res.rateDiscount !== 0) {
    const label = res.rateDiscount > 0
      ? "Discount of " + money(res.rateDiscount) + " will be filled in on the right."
      : "Extra " + money(-res.rateDiscount) + " above master will show as a negative discount.";
    setRateHint(el("rateHint").textContent + "  " + label, res.rateDiscount < 0);
  }
}

function clearEntry() {
  el("quantity").value = "";
  setLinePrice(null);
  setLineError("");
}

function onProductChange() {
  const product = currentProduct();
  fillUnitDropdown(product);
  resetRateToMaster(product, null);
  el("rateUnit").dataset.prev = el("rateUnit").value;
  clearEntry();
  showRateStrip(product);
  recalcPrice();
}

// -------------------------------------------------------------------
// adding a line to the order
// -------------------------------------------------------------------

function addOrUpdateLine() {
  const product = currentProduct();

  if (!product) { setLineError("Choose a product first."); return; }

  const qty = Number(el("quantity").value);
  const unitName = el("unit").value;
  const ratePrice = currentRatePrice();
  const rateUnit = el("rateUnit").value;

  if (el("quantity").value === "" || !(qty > 0)) { setLineError("Enter a quantity greater than 0."); return; }
  if (!unitName) { setLineError("Choose a unit."); return; }
  if (ratePrice === null) { setLineError("Enter the price per unit."); return; }
  if (!rateUnit) { setLineError("Choose the unit the price is for."); return; }

  const res = computeLine(product, qty, unitName, ratePrice, rateUnit);
  if (!res.ok) { setLineError(res.error); return; }
  if (!(res.masterAmount > 0)) { setLineError("Amount works out to zero. Check the quantity or the unit."); return; }

  // An extra discount typed into the table earlier is intent, not noise
  // — carry it across when the line is edited.
  const manualExtra = editingIndex >= 0 ? (Number(orderLines[editingIndex].manualExtra) || 0) : 0;

  const line = {
    productName: product.ProductName,
    quantity: round3(qty),
    unit: unitName,
    masterPrice: Number(product.Price),
    masterQty: Number(product.Quantity),
    masterUnit: product.Unit,

    // the editable rate and what master says it should have been
    ratePrice: round4(ratePrice),
    rateUnit: rateUnit,
    masterRate: round4(res.masterRate),

    amount: res.masterAmount,          // what master says this line is worth
    chargedAmount: res.chargedAmount,  // what the customer is being asked for
    rateDiscount: res.rateDiscount,    // the gap between the two
    manualExtra: manualExtra,
    discount: round2(res.rateDiscount + manualExtra)
  };

  if (editingIndex >= 0) {
    orderLines[editingIndex] = line;
    stopEditing();
  } else {
    orderLines.push(line);
  }

  renderOrder();

  el("productName").value = "";
  onProductChange();
  el("productName").focus();
}

function startEditing(index) {
  const line = orderLines[index];
  if (!line) return;

  editingIndex = index;
  el("entryHeading").textContent = "Edit line " + (index + 1);
  el("addProductBtn").textContent = "Update this line";
  el("cancelEditBtn").style.display = "block";

  el("productName").value = line.productName;
  const product = currentProduct();
  fillUnitDropdown(product);
  el("unit").value = line.unit;
  el("quantity").value = line.quantity;

  fillRateUnitDropdown(product, line.rateUnit);
  el("rateUnit").dataset.prev = el("rateUnit").value;
  el("ratePrice").value = tidyRate(line.ratePrice);
  exactRatePrice = line.ratePrice;

  recalcPrice();

  el("quantity").scrollIntoView({ block: "center", behavior: "smooth" });
}

function stopEditing() {
  editingIndex = -1;
  el("entryHeading").textContent = "Add a product to this order";
  el("addProductBtn").textContent = "+ Add product to order";
  el("cancelEditBtn").style.display = "none";
}

function removeLine(index) {
  if (editingIndex === index) stopEditing();
  orderLines.splice(index, 1);
  renderOrder();
}

// -------------------------------------------------------------------
// order summary — this order only
// -------------------------------------------------------------------

// A negative discount (rate above master) legitimately pushes the final
// ABOVE the master amount, so only the lower end is clamped.
function lineFinal(line) {
  return round2(Math.max(0, line.amount - (Number(line.discount) || 0)));
}

function currentOrderTotal() {
  let total = 0;
  orderLines.forEach(function (ln) { total += lineFinal(ln); });
  return round2(total);
}

function currentAdvance() {
  const raw = Number(el("advanceAmount").value);
  return isNaN(raw) ? 0 : Math.max(0, round2(raw));
}

function currentBalance() {
  return round2(currentOrderTotal() - currentAdvance());
}

// The "@ 50/Kg (master 100/Kg)" note under a product name, shown only
// when the rate was actually changed.
function rateNoteHtml(ln) {
  if (ln.ratePrice === undefined || ln.ratePrice === null) return "";
  if (Math.abs(ln.ratePrice - ln.masterRate) < 0.00005) return "";
  return '<div class="line-sub">@ ' + money(ln.ratePrice) + " / " + escapeHtml(ln.rateUnit) +
    " <span>(master " + money(ln.masterRate) + ")</span></div>";
}

function renderOrder() {
  const body = el("billBody");
  const foot = el("billFoot");

  if (orderLines.length === 0) {
    body.innerHTML = '<tr><td colspan="8" class="bill-empty">Nothing on this order yet. Add a product on the left.</td></tr>';
    foot.innerHTML = "";
    el("orderTotalBox").textContent = "Order total: \u20B90";
    updateBalance();
    return;
  }

  const parts = [];
  orderLines.forEach(function (ln, i) {
    parts.push("<tr>" +
      '<td class="bill-rownum">' + (i + 1) + "</td>" +
      "<td>" + escapeHtml(ln.productName) + rateNoteHtml(ln) + "</td>" +
      '<td class="num">' + escapeHtml(tidyNumber(ln.quantity)) + "</td>" +
      "<td>" + escapeHtml(ln.unit) + "</td>" +
      '<td class="num">' + round2(ln.amount) + "</td>" +
      '<td class="num"><input type="number" class="discount-input" data-line="' + i +
        '" step="0.01" value="' + round2(Number(ln.discount) || 0) + '" aria-label="Discount for ' + escapeHtml(ln.productName) + '"></td>' +
      '<td class="num line-final" data-role="lineTotal" data-line="' + i + '">' + round2(lineFinal(ln)) + "</td>" +
      '<td class="bill-actions">' +
        '<button type="button" class="row-button" data-act="edit" data-line="' + i + '" title="Edit this line">\u270E</button>' +
        '<button type="button" class="row-button danger" data-act="remove" data-line="' + i + '" title="Remove this line">\u2715</button>' +
      "</td>" +
    "</tr>");
  });

  body.innerHTML = parts.join("");
  updateOrderTotals();
}

/*
  Footer + totals only. This is what a discount keystroke runs — no
  table rebuild, so the caret never jumps.
*/
function updateOrderTotals() {
  let totalAmount = 0, totalDisc = 0, totalFinal = 0;

  orderLines.forEach(function (ln) {
    totalAmount += Number(ln.amount) || 0;
    totalDisc += Number(ln.discount) || 0;
    totalFinal += lineFinal(ln);
  });

  el("billFoot").innerHTML = "<tr>" +
    '<td colspan="4">Total &mdash; ' + orderLines.length + " item" + (orderLines.length === 1 ? "" : "s") + "</td>" +
    '<td class="num">' + round2(totalAmount) + "</td>" +
    '<td class="num">' + round2(totalDisc) + "</td>" +
    '<td class="num">' + round2(totalFinal) + "</td>" +
    "<td></td>" +
  "</tr>";

  el("orderTotalBox").textContent = "Order total: " + money(totalFinal);
  updateBalance();
}

// Balance = every Final amount added up, minus the advance.
function updateBalance() {
  const total = currentOrderTotal();
  const advance = currentAdvance();
  const balance = round2(total - advance);
  const check = el("advanceCheck");

  el("balanceBox").textContent = "Balance to collect: " + money(Math.max(0, balance));

  if (orderLines.length === 0) { check.textContent = ""; check.className = "payment-check"; return; }

  if (advance > total) {
    check.className = "payment-check bad";
    check.textContent = "Advance " + money(advance) + " is more than the order total " + money(total) +
      ". Lower the advance before saving.";
  } else if (advance === 0) {
    check.className = "payment-check";
    check.textContent = "";
  } else if (balance === 0) {
    check.className = "payment-check ok";
    check.textContent = "\u2713 Paid in full \u2014 nothing to collect on delivery.";
  } else {
    check.className = "payment-check ok";
    check.textContent = "\u2713 " + money(advance) + " taken as advance, " + money(balance) + " on delivery.";
  }
}

function updateCustomerTag() {
  el("customerTag").textContent = el("customerName").value.trim();
}

// -------------------------------------------------------------------
// save
// -------------------------------------------------------------------

async function onSaveOrder() {
  const statusEl = el("formStatus");
  const submitBtn = el("submitBtn");

  const orderDateTime = el("orderDateTime").value;
  const customerName = el("customerName").value.trim();
  const deliveryDateTime = el("deliveryDateTime").value;
  const customerAddress = el("customerAddress").value.trim();

  const mobileList = parseMobiles(el("customerMobile").value);
  const customerMobile = mobileList.join(", ");

  if (!orderDateTime) { showFormStatus(statusEl, "Set the order date and time.", true); return; }
  if (!customerName) { showFormStatus(statusEl, "Enter the customer's name.", true); return; }

  if (REQUIRE_MOBILE && mobileList.length === 0) {
    showFormStatus(statusEl, "Enter at least one mobile number for the customer.", true);
    return;
  }
  if (mobileList.length > 0) {
    const problem = mobilesProblem(mobileList);
    if (problem) { showFormStatus(statusEl, problem, true); return; }
  }
  if (REQUIRE_ADDRESS && !customerAddress) {
    showFormStatus(statusEl, "Enter the delivery address.", true);
    return;
  }

  if (!deliveryDateTime) { showFormStatus(statusEl, "Choose the delivery date and time.", true); return; }
  if (new Date(deliveryDateTime) < new Date(orderDateTime)) {
    showFormStatus(statusEl, "Delivery is before the order time. Check the delivery date.", true);
    return;
  }
  if (orderLines.length === 0) { showFormStatus(statusEl, "Add at least one product before saving.", true); return; }

  if (editingIndex >= 0) {
    showFormStatus(statusEl, "Finish editing line " + (editingIndex + 1) + " first \u2014 press \u201CUpdate this line\u201D or \u201CCancel edit\u201D.", true);
    return;
  }

  const orderTotal = currentOrderTotal();
  const advance = currentAdvance();

  if (advance > orderTotal) {
    showFormStatus(statusEl,
      "Advance " + money(advance) + " is more than the order total " + money(orderTotal) + ". Correct it before saving.", true);
    return;
  }

  const balance = round2(orderTotal - advance);
  const ref = makeOrderRef();

  const rows = orderLines.map(function (ln) {
    return {
      OrderRef: ref,
      OrderDateTime: orderDateTime,
      CustomerName: customerName,
      DeliveryDateTime: deliveryDateTime,
      ProductName: ln.productName,
      Quantity: ln.quantity,
      Unit: ln.unit,
      MasterPrice: ln.masterPrice,
      MasterQty: ln.masterQty,
      MasterUnit: ln.masterUnit,
      Amount: round2(ln.amount),
      Discount: round2(Number(ln.discount) || 0),
      FinalAmount: lineFinal(ln),
      OrderTotal: orderTotal,
      AdvanceAmount: advance,
      BalancePayable: balance,

      // --- new columns, appended at the end of the sheet ---
      CustomerMobile: customerMobile,
      CustomerAddress: customerAddress,
      RatePrice: ln.ratePrice,
      RateUnit: ln.rateUnit,
      MasterRate: ln.masterRate,
      RateDiscount: round2(Number(ln.rateDiscount) || 0),
      ManualDiscount: round2(Number(ln.manualExtra) || 0)
    };
  });

  setButtonBusy(submitBtn, true, "Saving...", "Save order");
  try {
    await apiAddRows("Orders", rows);
    showFormStatus(statusEl,
      "Order " + ref + " saved \u2014 " + rows.length + " item(s), " + money(balance) +
      " to collect on delivery (" + prettyDateTime(deliveryDateTime) + ").", false);
    resetOrder();
  } catch (err) {
    // Nothing is thrown away — the lines stay on screen so Save can be
    // pressed again once the connection is back.
    showFormStatus(statusEl, "Could not save: " + err.message + " Nothing was lost — press Save again.", true);
  } finally {
    setButtonBusy(submitBtn, false, "Saving...", "Save order");
  }
}

function resetOrder() {
  orderLines = [];
  stopEditing();
  el("productName").value = "";
  onProductChange();
  el("customerName").value = "";
  el("customerMobile").value = "";
  el("customerAddress").value = "";
  el("advanceAmount").value = "0";
  setDefaultOrderDateTime();
  setDefaultDeliveryDateTime();
  updateCustomerTag();
  renderOrder();
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

  setDefaultOrderDateTime();
  setDefaultDeliveryDateTime();
  el("productName").innerHTML = '<option value="">Loading products...</option>';
  el("rateUnit").innerHTML = '<option value="">Loading units...</option>';
  renderOrder();

  // --- entry form ---
  el("productName").addEventListener("change", onProductChange);
  el("quantity").addEventListener("input", recalcPrice);
  el("unit").addEventListener("change", recalcPrice);

  // --- the editable rate ---
  el("ratePrice").addEventListener("input", function () {
    exactRatePrice = null;   // the user owns this number now
    recalcPrice();
  });
  el("rateUnit").addEventListener("change", onRateUnitChange);
  el("resetRateBtn").addEventListener("click", function () {
    resetRateToMaster(currentProduct(), el("rateUnit").value);
    el("rateUnit").dataset.prev = el("rateUnit").value;
    recalcPrice();
  });

  el("addProductBtn").addEventListener("click", addOrUpdateLine);
  el("cancelEditBtn").addEventListener("click", function () {
    stopEditing();
    el("productName").value = "";
    onProductChange();
  });

  // Enter anywhere in the entry area adds the line.
  ["quantity", "unit", "ratePrice", "rateUnit"].forEach(function (id) {
    el(id).addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); addOrUpdateLine(); }
    });
  });

  // --- header fields ---
  el("customerName").addEventListener("input", updateCustomerTag);

  // --- order summary: delegated, bound once ---
  el("billBody").addEventListener("input", function (e) {
    if (!e.target.classList.contains("discount-input")) return;

    const i = Number(e.target.dataset.line);
    const ln = orderLines[i];
    if (!ln) return;

    const raw = e.target.value === "" ? 0 : Number(e.target.value);
    // Negative is allowed here: it is how a rate above master is carried.
    ln.discount = isNaN(raw) ? 0 : raw;
    // Whatever was typed beyond the automatic figure is the user's own
    // extra discount, and is kept if the line is edited later.
    ln.manualExtra = round2(ln.discount - (Number(ln.rateDiscount) || 0));

    const cell = document.querySelector('[data-role="lineTotal"][data-line="' + i + '"]');
    if (cell) cell.textContent = round2(lineFinal(ln));

    updateOrderTotals();
  });

  el("billBody").addEventListener("click", function (e) {
    const btn = e.target.closest(".row-button");
    if (!btn) return;
    const i = Number(btn.dataset.line);
    if (btn.dataset.act === "remove") removeLine(i);
    else if (btn.dataset.act === "edit") startEditing(i);
  });

  // --- advance ---
  el("advanceAmount").addEventListener("input", updateBalance);
  el("noAdvanceBtn").addEventListener("click", function () {
    el("advanceAmount").value = "0";
    updateBalance();
  });
  el("fullAdvanceBtn").addEventListener("click", function () {
    el("advanceAmount").value = currentOrderTotal();
    updateBalance();
  });

  el("submitBtn").addEventListener("click", onSaveOrder);

  el("refreshBtn").addEventListener("click", async function () {
    const btn = el("refreshBtn");
    const label = "\u21BB Refresh products / units";
    setButtonBusy(btn, true, "Refreshing...", label);
    await loadAllData(true);
    fillProductDropdown();
    onProductChange();
    setButtonBusy(btn, false, "Refreshing...", label);
  });

  (async function init() {
    await loadAllData(false);
    fillProductDropdown();
    onProductChange();
  })();
}

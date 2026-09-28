/*
  dashboards.js — logic for pages/dashboards.html
  ==================================================================
  Reads Sales, Orders, PaymentPending, ProductMaster and Units and
  shows the Business Sales dashboard.

  NOTHING ELSE IN THE APP CHANGES. This file only reads, through the
  existing api.js helpers, and never writes.

  THE ONE RULE THAT MATTERS
  ------------------------------------------------------------------
  Every one of these sheets stores ONE ROW PER LINE ITEM, and repeats
  the bill-level totals on each of those rows:

    Sales           BillTotal, CashPaid, OnlinePaid   repeat per line
    Orders          OrderTotal, AdvanceAmount, BalancePayable
    PaymentPending  SubTotal, BillDiscount, TotalPending

  So a three-item bill of 500 would report 1500 if those columns were
  simply added up. Line-level columns (LineTotal / FinalAmount /
  SalePrice, Quantity, Discount) are summed; bill-level columns are
  counted ONCE per distinct BillNo / OrderRef / PendingRef.

  Discount is already RateDiscount + ManualDiscount (see orders.js and
  payment-pending.js), so only Discount is added — never all three.
  ==================================================================
*/

const session = requireLogin("dashboards");

/* ------------------------------------------------------------------
   Settings you may want to change
   ------------------------------------------------------------------ */

// 'BLOCK7'  -> days 1-7 = week 1, 8-14 = week 2, ... 29-31 = week 5
// 'CALENDAR'-> weeks break on Monday inside the month
const DASH_WEEK_MODE = "BLOCK7";

const DASH_MIN_YEAR = 2026;          // dropdown starts here
const DASH_SHEETS = ["Sales", "Orders", "PaymentPending", "ProductMaster", "Units"];

const DASH_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DASH_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Bright series colours for a dark panel. Same hues as the tab accents
// in variables.css, lifted so they read on cocoa.
const DASH_SERIES = ["#F2B33D", "#3FD9C0", "#5AB4F0", "#7FD46A", "#D07FCB",
                     "#FF8A5B", "#8C9BFF", "#FFD166", "#5BE7C4", "#FF9FB2"];

/* ------------------------------------------------------------------
   State
   ------------------------------------------------------------------ */

let DASH_RAW = null;        // { sales, orders, pending, products, units }
let DASH_RESULT = null;     // last aggregate() output
let DASH_FILTERS = {};      // MultiSelect instances
let DASH_SORT = { key: "netSales", dir: -1 };
let DASH_SERVER_MODE = null; // true once the server aggregator is known to work

/* ------------------------------------------------------------------
   Small helpers
   ------------------------------------------------------------------ */

function dNum(v) {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return isFinite(v) ? v : 0;
  const s = String(v).replace(/[₹\s,]/g, "").replace(/[^0-9.\-]/g, "");
  if (s === "" || s === "-" || s === ".") return 0;
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}

function dMoney(n) {
  const v = Math.round(dNum(n));
  try { return "\u20B9" + v.toLocaleString("en-IN"); }
  catch (e) { return "\u20B9" + v; }
}

function dMoneyShort(n) {
  n = dNum(n);
  if (Math.abs(n) >= 1e7) return "\u20B9" + (n / 1e7).toFixed(2) + " Cr";
  if (Math.abs(n) >= 1e5) return "\u20B9" + (n / 1e5).toFixed(2) + " L";
  return dMoney(n);
}

function dCount(n) {
  try { return Math.round(dNum(n)).toLocaleString("en-IN"); }
  catch (e) { return String(Math.round(dNum(n))); }
}

function dQty(n, unit) {
  n = dNum(n);
  let s;
  if (Math.round(n) === n) s = String(Math.round(n));
  else if (Math.abs(n) < 100) s = n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  else s = n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return unit ? s + " " + unit : s;
}

function dPct(n) { return dNum(n).toFixed(1) + "%"; }

// Accepts a Date, "2026-08-27T14:30" (what datetime-local saves) and
// "2026-08-27T09:00:00.000Z" (what the sheet returns for a real Date
// cell). Both land on the right local day as long as the browser and
// the spreadsheet share a timezone, which is what formatTimestamp in
// master-common.js already assumes.
function dWhen(v) {
  if (!v && v !== 0) return null;
  if (Object.prototype.toString.call(v) === "[object Date]") {
    return isNaN(v.getTime()) ? null : v;
  }
  const s = String(v).trim();
  if (!s) return null;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return null;
}

function dWeekOfMonth(date) {
  const day = date.getDate();
  if (DASH_WEEK_MODE === "CALENDAR") {
    const first = new Date(date.getFullYear(), date.getMonth(), 1).getDay();
    const offset = (first - 1 + 7) % 7;   // week starts Monday
    return Math.floor((day + offset - 1) / 7) + 1;
  }
  return Math.ceil(day / 7);
}

function dDayKey(date) {
  const m = date.getMonth() + 1, d = date.getDate();
  return date.getFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (d < 10 ? "0" : "") + d;
}

function dDaysInMonth(year, month) { return new Date(year, month, 0).getDate(); }

/* ------------------------------------------------------------------
   Units — real conversion, straight from the Units master
   ------------------------------------------------------------------ */

function buildUnitIndex(unitRows) {
  const byName = {};
  const familyDisplay = {};   // family -> {name, factor}  (the biggest unit)
  (unitRows || []).forEach(function (u) {
    const name = String(u.UnitName || "").trim();
    if (!name) return;
    const factor = dNum(u.Factor) || 1;
    const family = String(u.Family || "").trim().toLowerCase() || "other";
    byName[name.toLowerCase()] = { name: name, factor: factor, family: family };
    if (!familyDisplay[family] || factor > familyDisplay[family].factor) {
      familyDisplay[family] = { name: name, factor: factor };
    }
  });
  return { byName: byName, familyDisplay: familyDisplay };
}

function unitInfo(idx, unitName) {
  if (!unitName) return null;
  return idx.byName[String(unitName).trim().toLowerCase()] || null;
}

// Quantity in the family's base units (gms, ml, pieces), or null when
// the unit is not in the Units master.
function toBaseQty(idx, qty, unitName) {
  const info = unitInfo(idx, unitName);
  if (!info) return null;
  return { base: dNum(qty) * info.factor, family: info.family };
}

// Base units back into a named unit for display.
function fromBaseQty(idx, base, unitName) {
  const info = unitInfo(idx, unitName);
  if (!info || !info.factor) return base;
  return base / info.factor;
}

/* ------------------------------------------------------------------
   Loading
   ------------------------------------------------------------------ */

async function loadDashboardData(force) {
  const data = await apiListMany(DASH_SHEETS, { force: !!force });
  const errors = [];
  DASH_SHEETS.forEach(function (s) {
    if (data._errors && data._errors[s]) errors.push(s + ": " + data._errors[s]);
  });
  return {
    sales: data.Sales || [],
    orders: data.Orders || [],
    pending: data.PaymentPending || [],
    products: data.ProductMaster || [],
    units: data.Units || [],
    errors: errors
  };
}

/* ------------------------------------------------------------------
   Filtering
   ------------------------------------------------------------------ */

// An empty list, "*", "ALL" or "0" all mean "do not filter on this".
function makeFilterSet(list, mapper) {
  if (!list || !list.length) return null;
  const out = {};
  let any = false;
  for (let i = 0; i < list.length; i++) {
    const s = String(list[i]).trim();
    if (s === "") continue;
    if (s === "*" || s === "0" || s.toUpperCase() === "ALL") return null;
    const v = mapper ? mapper(s) : s;
    if (v === null || v === undefined || (typeof v === "number" && isNaN(v))) continue;
    out[v] = true; any = true;
  }
  return any ? out : null;
}

function normaliseFilters(f) {
  return {
    years:    makeFilterSet(f.years, function (s) { return parseInt(s, 10); }),
    months:   makeFilterSet(f.months, function (s) {
                const n = parseInt(s, 10);
                if (!isNaN(n)) return n;
                const i = DASH_MONTHS.indexOf(s.slice(0, 3));
                return i === -1 ? null : i + 1;
              }),
    weeks:    makeFilterSet(f.weeks, function (s) { return parseInt(s, 10); }),
    days:     makeFilterSet(f.days, function (s) { return parseInt(s, 10); }),
    dayNames: makeFilterSet(f.dayNames, function (s) {
                const i = DASH_DAYS.indexOf(s.slice(0, 3));
                return i === -1 ? null : i;
              }),
    products: makeFilterSet(f.products, function (s) { return s.trim().toLowerCase(); })
  };
}

function dateMatches(fs, when) {
  if (!when) return false;
  if (fs.years && !fs.years[when.getFullYear()]) return false;
  if (fs.months && !fs.months[when.getMonth() + 1]) return false;
  if (fs.weeks && !fs.weeks[dWeekOfMonth(when)]) return false;
  if (fs.days && !fs.days[when.getDate()]) return false;
  if (fs.dayNames && !fs.dayNames[when.getDay()]) return false;
  return true;
}

function productMatches(fs, name) {
  if (!fs.products) return true;
  return !!fs.products[String(name || "").trim().toLowerCase()];
}

/* ------------------------------------------------------------------
   Aggregation — the heart of it. Pure function, no DOM.
   ------------------------------------------------------------------ */

function aggregate(raw, filters) {
  const fs = normaliseFilters(filters || {});
  const idx = buildUnitIndex(raw.units);
  const allProducts = !fs.products;
  const warnings = [];
  const unknownUnits = {};

  // --- product shells, from the Product Master ---
  const byKey = {};
  const products = [];
  function shell(name) {
    const key = String(name || "").trim().toLowerCase();
    if (!key) return null;
    if (byKey[key]) return byKey[key];
    const p = {
      name: String(name).trim(), key: key, unit: "", masterUnit: "",
      bills: {}, billCount: 0,
      grossSales: 0, discount: 0, netSales: 0,
      qtyBase: 0, family: "", qtyDisplay: 0,
      orderedBase: 0, orderedQtyDisplay: 0, orderAmt: 0, orderDiscount: 0,
      dueBase: 0, dueQtyDisplay: 0,
      pendingAmt: 0,
      pctSales: 0, pctCustomers: 0, avgPerBill: 0,
      lossQty: 0, lossAmt: 0,
      inMaster: false
    };
    byKey[key] = p; products.push(p);
    return p;
  }

  // Seed from the Product Master so a product that sold nothing still shows
  // as a zero row — but only for products the filter actually asked for.
  (raw.products || []).forEach(function (r) {
    if (!productMatches(fs, r.ProductName)) return;
    const p = shell(r.ProductName);
    if (!p) return;
    p.inMaster = true;
    p.masterUnit = String(r.Unit || "").trim();
    p.unit = p.masterUnit;
  });

  // --- Sales -------------------------------------------------------
  const allBills = {};
  let billsMatched = 0;
  const trend = {};
  const paymentByBill = {};

  (raw.sales || []).forEach(function (r) {
    const when = dWhen(r.EntryDateTime);
    if (!dateMatches(fs, when)) return;
    if (!productMatches(fs, r.ProductName)) return;

    const p = shell(r.ProductName);
    if (!p) return;

    const gross = dNum(r.SalePrice);
    const disc = dNum(r.Discount);
    const net = (r.LineTotal === undefined || r.LineTotal === "")
      ? Math.max(0, gross - disc) : dNum(r.LineTotal);

    p.grossSales += gross;
    p.discount += disc;
    p.netSales += net;

    const q = toBaseQty(idx, r.Quantity, r.Unit);
    if (q) {
      p.qtyBase += q.base;
      if (!p.family) p.family = q.family;
    } else if (r.Unit) {
      unknownUnits[String(r.Unit)] = true;
    }

    const bill = String(r.BillNo || "");
    if (bill) {
      if (!p.bills[bill]) { p.bills[bill] = true; p.billCount++; }
      if (!allBills[bill]) { allBills[bill] = true; billsMatched++; }
      // Bill-level money: recorded once, keyed by bill number.
      if (!paymentByBill[bill]) {
        paymentByBill[bill] = {
          total: dNum(r.BillTotal), cash: dNum(r.CashPaid), online: dNum(r.OnlinePaid)
        };
      }
    }

    const key = dDayKey(when);
    if (!trend[key]) trend[key] = { key: key, when: when, netSales: 0, bills: {}, billCount: 0 };
    trend[key].netSales += net;
    if (bill && !trend[key].bills[bill]) { trend[key].bills[bill] = true; trend[key].billCount++; }
  });

  // --- Orders ------------------------------------------------------
  const orderRefs = {};
  const now = new Date();
  let ordersMatched = 0;

  (raw.orders || []).forEach(function (r) {
    const when = dWhen(r.OrderDateTime);
    if (!dateMatches(fs, when)) return;
    if (!productMatches(fs, r.ProductName)) return;

    const p = shell(r.ProductName);
    if (!p) return;

    p.orderAmt += dNum(r.FinalAmount);
    p.orderDiscount += dNum(r.Discount);

    const q = toBaseQty(idx, r.Quantity, r.Unit);
    if (q) {
      p.orderedBase += q.base;
      if (!p.family) p.family = q.family;
    } else if (r.Unit) {
      unknownUnits[String(r.Unit)] = true;
    }

    const due = dWhen(r.DeliveryDateTime);
    if (due && due <= now && q) p.dueBase += q.base;

    const ref = String(r.OrderRef || "");
    if (ref && !orderRefs[ref]) {
      orderRefs[ref] = {
        total: dNum(r.OrderTotal),
        advance: dNum(r.AdvanceAmount),
        balance: dNum(r.BalancePayable)
      };
      ordersMatched++;
    }
  });

  // --- Payment pending --------------------------------------------
  // The bill discount lives on the ref, not the line, so it is spread
  // across that ref's lines in proportion to their Sale Price. The
  // product figures then add up to exactly TotalPending.
  const pendingRefs = {};
  (raw.pending || []).forEach(function (r) {
    const ref = String(r.PendingRef || "");
    if (!ref) return;
    if (!pendingRefs[ref]) {
      pendingRefs[ref] = {
        subTotal: dNum(r.SubTotal), billDiscount: dNum(r.BillDiscount),
        total: dNum(r.TotalPending), lineSum: 0, matched: false
      };
    }
    pendingRefs[ref].lineSum += dNum(r.SalePrice);
  });

  let pendingMatched = 0;
  (raw.pending || []).forEach(function (r) {
    const when = dWhen(r.EntryDateTime);
    if (!dateMatches(fs, when)) return;
    if (!productMatches(fs, r.ProductName)) return;

    const p = shell(r.ProductName);
    if (!p) return;

    const ref = pendingRefs[String(r.PendingRef || "")];
    const line = dNum(r.SalePrice);
    let share = line;
    if (ref) {
      const base = ref.subTotal || ref.lineSum;
      if (base > 0 && ref.billDiscount) share = line * (1 - (ref.billDiscount / base));
      if (!ref.matched) { ref.matched = true; pendingMatched++; }
    }
    p.pendingAmt += Math.max(0, share);
  });

  // --- Totals ------------------------------------------------------
  const familyTotals = {};      // family -> base units sold
  const familyOrdered = {};
  const totals = {
    customers: billsMatched,
    grossSales: 0, discount: 0, netSales: 0,
    orderedAmt: 0, orderDiscount: 0, pendingAmt: 0,
    cash: 0, online: 0, collected: 0,
    orderTotal: 0, advance: 0, balance: 0,
    lossQty: 0, lossAmt: 0, profit: 1,
    bills: billsMatched, orders: ordersMatched, pendingBills: pendingMatched
  };

  products.forEach(function (p) {
    totals.grossSales += p.grossSales;
    totals.discount += p.discount;
    totals.netSales += p.netSales;
    totals.orderedAmt += p.orderAmt;
    totals.orderDiscount += p.orderDiscount;
    totals.pendingAmt += p.pendingAmt;

    if (p.qtyBase) {
      const fam = p.family || "other";
      familyTotals[fam] = (familyTotals[fam] || 0) + p.qtyBase;
    }
    if (p.orderedBase) {
      const fam = p.family || "other";
      familyOrdered[fam] = (familyOrdered[fam] || 0) + p.orderedBase;
    }

    // Show each product's own quantity in its Product Master unit.
    p.qtyDisplay = p.masterUnit ? fromBaseQty(idx, p.qtyBase, p.masterUnit) : p.qtyBase;
    p.orderedQtyDisplay = p.masterUnit ? fromBaseQty(idx, p.orderedBase, p.masterUnit) : p.orderedBase;
    p.dueQtyDisplay = p.masterUnit ? fromBaseQty(idx, p.dueBase, p.masterUnit) : p.dueBase;
    p.unit = p.masterUnit || "";
  });

  // Cash / UPI and the order totals belong to a whole bill, not to a line, so
  // they are only meaningful when no product filter is on. Under a filter they
  // stay at zero and the cards show a dash — a part-bill figure would be wrong,
  // not merely imprecise.
  if (allProducts) {
    Object.keys(paymentByBill).forEach(function (b) {
      totals.cash += paymentByBill[b].cash;
      totals.online += paymentByBill[b].online;
    });
    Object.keys(orderRefs).forEach(function (ref) {
      totals.orderTotal += orderRefs[ref].total;
      totals.advance += orderRefs[ref].advance;
      totals.balance += orderRefs[ref].balance;
    });
  }
  totals.collected = totals.cash + totals.online;

  products.forEach(function (p) {
    p.pctSales = totals.netSales ? (p.netSales / totals.netSales) * 100 : 0;
    p.pctCustomers = totals.customers ? (p.billCount / totals.customers) * 100 : 0;
    p.avgPerBill = p.billCount ? p.netSales / p.billCount : 0;
  });
  products.sort(function (a, b) { return b.netSales - a.netSales; });

  // Quantity by family, converted into that family's largest unit.
  const quantityByFamily = Object.keys(familyTotals).map(function (fam) {
    const disp = idx.familyDisplay[fam];
    return {
      family: fam,
      unit: disp ? disp.name : "",
      value: disp ? familyTotals[fam] / disp.factor : familyTotals[fam],
      ordered: disp ? (familyOrdered[fam] || 0) / disp.factor : (familyOrdered[fam] || 0)
    };
  }).sort(function (a, b) { return b.value - a.value; });

  // Trend, oldest first.
  const trendRows = Object.keys(trend).sort().map(function (k) {
    return { key: k, when: trend[k].when, netSales: trend[k].netSales, bills: trend[k].billCount };
  });

  // --- Notes -------------------------------------------------------
  if (!(raw.products || []).length) {
    warnings.push("The Product Master came back with no rows, so the product filter is empty. " +
      "Open Master \u203A Product Master and check the list loads there, then press Reload data.");
  }
  if (!(raw.units || []).length) {
    warnings.push("The Units master came back with no rows, so no quantity can be converted. " +
      "Open Master \u203A Units and check the list loads there.");
  }
  if (!(raw.sales || []).length && !(raw.orders || []).length && !(raw.pending || []).length) {
    warnings.push("No sales, orders or pending entries were returned at all. If the Sales page " +
      "shows entries, press Reload data; if it does not, the backend is the place to look.");
  }

  if (!billsMatched && !ordersMatched && !pendingMatched) {
    warnings.push("No entries match these filters. Widen a filter or press Reset.");

    // The commonest cause: Date (dd) and Day both switched on, asking for a
    // date that never falls on that weekday. Say which, rather than leaving
    // the reader to work out why every tile reads zero.
    if (fs.days && fs.dayNames) {
      const years = fs.years ? Object.keys(fs.years).map(Number) : [new Date().getFullYear()];
      const months = fs.months ? Object.keys(fs.months).map(Number)
                               : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
      const days = Object.keys(fs.days).map(Number);
      let possible = false, example = null;
      years.forEach(function (y) {
        months.forEach(function (m) {
          days.forEach(function (d) {
            const dt = new Date(y, m - 1, d);
            if (dt.getMonth() !== m - 1) return;      // e.g. 31 February
            if (!example) example = dt;
            if (fs.dayNames[dt.getDay()]) possible = true;
          });
        });
      });
      if (!possible && example) {
        const wanted = Object.keys(fs.dayNames).map(function (i) { return DASH_DAYS[i]; }).join(" or ");
        warnings.push("Date (dd) and Day are both on and they contradict each other: " +
          example.getDate() + " " + DASH_MONTHS[example.getMonth()] + " " + example.getFullYear() +
          " is a " + DASH_DAYS[example.getDay()] + ", not a " + wanted +
          ". Set one of the two to 0 \u2014 they are rarely useful together.");
      }
    }
  }
  const unknown = Object.keys(unknownUnits);
  if (unknown.length) {
    warnings.push("These units are used in entries but are not in the Units master, so their quantity could not be converted: " +
      unknown.join(", ") + ". Add them under Master \u203A Units.");
  }
  const noMaster = products.filter(function (p) { return !p.inMaster && (p.netSales || p.billCount); });
  if (noMaster.length) {
    warnings.push("Sold but no longer in the Product Master: " +
      noMaster.map(function (p) { return p.name; }).join(", ") + ".");
  }
  if (!allProducts) {
    warnings.push("A product filter is on, so the cash / UPI split and the order totals are hidden \u2014 those are recorded per bill, not per product.");
  }

  return {
    generatedAt: new Date(),
    allProducts: allProducts,
    products: products,
    totals: totals,
    quantityByFamily: quantityByFamily,
    trend: trendRows,
    warnings: warnings,
    counts: {
      salesRows: (raw.sales || []).length,
      orderRows: (raw.orders || []).length,
      pendingRows: (raw.pending || []).length,
      productRows: (raw.products || []).length,
      unitRows: (raw.units || []).length,
      productsShown: products.length,
      days: trendRows.length
    }
  };
}

/* ==================================================================
   Multi-select control
   ================================================================== */

function DashSelect(hostId, cfg) {
  this.host = document.getElementById(hostId);
  this.cfg = cfg;
  this.mode = "all";        // all | ignore | some
  this.chosen = {};
  this.build();
}

DashSelect.prototype.build = function () {
  const self = this;
  this.host.innerHTML =
    '<div class="ds">' +
      '<button type="button" class="ds-button" id="ds-' + this.cfg.id + '-btn" aria-expanded="false"></button>' +
      '<div class="ds-pop">' +
        (this.cfg.searchable ? '<input type="text" class="ds-search" placeholder="Search..." aria-label="Search">' : "") +
        '<div class="ds-quick">' +
          '<button type="button" data-act="all">Select all</button>' +
          '<button type="button" data-act="none">Clear</button>' +
        "</div>" +
        '<div class="ds-list"></div>' +
        '<label class="ds-option ds-ignore"><input type="checkbox" data-ignore="1">' +
          "<span>0 &mdash; don't use this filter</span></label>" +
      "</div>" +
    "</div>";

  this.root = this.host.firstChild;
  this.button = this.root.querySelector(".ds-button");
  this.list = this.root.querySelector(".ds-list");
  this.search = this.root.querySelector(".ds-search");
  this.ignoreBox = this.root.querySelector("[data-ignore]");

  this.button.addEventListener("click", function (e) {
    e.stopPropagation();
    const open = !self.root.classList.contains("is-open");
    closeAllSelects();
    if (open) {
      self.root.classList.add("is-open");
      self.button.setAttribute("aria-expanded", "true");
      // Anchor the panel to whichever edge keeps it on screen. The Products
      // filter sits at the right of the row, so left-anchoring pushed it off
      // the page and gave the whole screen a horizontal scrollbar.
      const pop = self.root.querySelector(".ds-pop");
      pop.classList.remove("is-right");
      const box = pop.getBoundingClientRect();
      if (box.right > document.documentElement.clientWidth - 8) pop.classList.add("is-right");
      if (self.search) self.search.focus();
    }
  });
  this.root.querySelector(".ds-pop").addEventListener("click", function (e) { e.stopPropagation(); });

  this.root.querySelectorAll(".ds-quick button").forEach(function (b) {
    b.addEventListener("click", function () {
      self.mode = b.getAttribute("data-act") === "all" ? "all" : "some";
      self.chosen = {};
      if (self.mode === "all") self.cfg.options.forEach(function (o) { self.chosen[o.v] = true; });
      self.render();
      self.changed();
    });
  });

  this.ignoreBox.addEventListener("change", function () {
    self.mode = self.ignoreBox.checked ? "ignore" : "all";
    self.chosen = {};
    if (self.mode === "all") self.cfg.options.forEach(function (o) { self.chosen[o.v] = true; });
    self.render();
    self.changed();
  });

  if (this.search) {
    this.search.addEventListener("input", function () { self.renderList(); });
  }

  this.setOptions(this.cfg.options, this.cfg.selected);
};

DashSelect.prototype.changed = function () {
  if (typeof this.cfg.onChange === "function") this.cfg.onChange(this);
};

DashSelect.prototype.setOptions = function (options, selected) {
  const self = this;
  this.cfg.options = options || [];
  if (selected === "all") {
    this.mode = "all"; this.chosen = {};
    this.cfg.options.forEach(function (o) { self.chosen[o.v] = true; });
  } else if (selected === "ignore") {
    this.mode = "ignore"; this.chosen = {};
  } else if (Object.prototype.toString.call(selected) === "[object Array]") {
    const keep = {};
    selected.forEach(function (v) { keep[String(v)] = true; });
    this.chosen = {}; let any = false;
    this.cfg.options.forEach(function (o) {
      if (keep[String(o.v)]) { self.chosen[o.v] = true; any = true; }
    });
    this.mode = any ? "some" : "all";
    if (!any) this.cfg.options.forEach(function (o) { self.chosen[o.v] = true; });
  } else {
    const prev = this.chosen;
    this.chosen = {};
    this.cfg.options.forEach(function (o) { if (prev[o.v]) self.chosen[o.v] = true; });
    if (this.mode === "all") this.cfg.options.forEach(function (o) { self.chosen[o.v] = true; });
  }
  this.render();
};

DashSelect.prototype.renderList = function () {
  const self = this;
  const q = this.search ? this.search.value.trim().toLowerCase() : "";
  let html = "";
  this.cfg.options.forEach(function (o) {
    if (q && String(o.t).toLowerCase().indexOf(q) === -1) return;
    const on = self.mode !== "ignore" && self.chosen[o.v];
    html += '<label class="ds-option"><input type="checkbox" value="' + mcEscape(o.v) + '"' +
      (on ? " checked" : "") + "><span>" + mcEscape(o.t) + "</span>" +
      (o.note ? '<em class="ds-note">' + mcEscape(o.note) + "</em>" : "") + "</label>";
  });
  this.list.innerHTML = html || '<p class="ds-none">Nothing matches that.</p>';

  this.list.querySelectorAll("input").forEach(function (cb) {
    cb.addEventListener("change", function () {
      if (self.mode === "ignore") { self.mode = "some"; self.chosen = {}; }
      if (cb.checked) self.chosen[cb.value] = true; else delete self.chosen[cb.value];
      const n = Object.keys(self.chosen).length;
      self.mode = (n > 0 && n === self.cfg.options.length) ? "all" : "some";
      self.ignoreBox.checked = false;
      self.renderButton();
      self.changed();
    });
  });
};

DashSelect.prototype.renderButton = function () {
  const n = Object.keys(this.chosen).length;
  const total = this.cfg.options.length;
  let text, muted = false;
  if (this.mode === "ignore") { text = "Not used"; muted = true; }
  else if (this.mode === "all" || (total > 0 && n === total)) text = "All (" + total + ")";
  else if (n === 0) { text = "Nothing picked"; muted = true; }
  else if (n === 1) {
    const k = Object.keys(this.chosen)[0];
    const hit = this.cfg.options.filter(function (o) { return String(o.v) === String(k); })[0];
    text = hit ? hit.t : k;
  } else text = n + " picked";
  this.button.textContent = text;
  this.button.className = "ds-button" + (muted ? " is-muted" : "");
};

DashSelect.prototype.render = function () {
  this.ignoreBox.checked = (this.mode === "ignore");
  this.renderList();
  this.renderButton();
};

DashSelect.prototype.value = function () {
  if (this.mode === "ignore") return ["0"];
  if (this.mode === "all") return ["*"];
  const keys = Object.keys(this.chosen);
  return keys.length ? keys : ["*"];
};

DashSelect.prototype.picked = function () {
  if (this.mode !== "some") return null;
  return Object.keys(this.chosen);
};

function closeAllSelects() {
  document.querySelectorAll(".ds.is-open").forEach(function (el) {
    el.classList.remove("is-open");
    const b = el.querySelector(".ds-button");
    if (b) b.setAttribute("aria-expanded", "false");
  });
}

/* ==================================================================
   Charts — plain SVG, no library, no CDN
   ================================================================== */

function svgBarLine(rows) {
  if (!rows.length) return '<p class="dash-empty">Nothing to plot for these filters.</p>';

  const W = 760, H = 260, L = 54, R = 44, T = 16, B = 40;
  const iw = W - L - R, ih = H - T - B;
  const maxSales = Math.max.apply(null, rows.map(function (r) { return r.netSales; }).concat([1]));
  const maxBills = Math.max.apply(null, rows.map(function (r) { return r.bills; }).concat([1]));
  const step = iw / rows.length;
  const barW = Math.max(3, Math.min(44, step * 0.6));

  let bars = "", line = "", dots = "", labels = "";
  const every = Math.ceil(rows.length / 12);

  rows.forEach(function (r, i) {
    const cx = L + step * i + step / 2;
    const h = (r.netSales / maxSales) * ih;
    bars += '<rect x="' + (cx - barW / 2).toFixed(1) + '" y="' + (T + ih - h).toFixed(1) +
      '" width="' + barW.toFixed(1) + '" height="' + Math.max(0, h).toFixed(1) +
      '" rx="3" class="dash-bar"><title>' + mcEscape(dDayLabel(r.when, true)) + " \u2014 " +
      mcEscape(dMoney(r.netSales)) + ", " + r.bills + " bill(s)</title></rect>";

    const ly = T + ih - (r.bills / maxBills) * ih;
    line += (i === 0 ? "M" : "L") + cx.toFixed(1) + " " + ly.toFixed(1) + " ";
    if (rows.length <= 40) {
      dots += '<circle cx="' + cx.toFixed(1) + '" cy="' + ly.toFixed(1) + '" r="3" class="dash-dot"/>';
    }
    if (i % every === 0 || i === rows.length - 1) {
      labels += '<text x="' + cx.toFixed(1) + '" y="' + (H - 14) +
        '" class="dash-axis" text-anchor="middle">' + mcEscape(dDayLabel(r.when)) + "</text>";
    }
  });

  let grid = "";
  for (let g = 0; g <= 3; g++) {
    const y = T + (ih / 3) * g;
    const v = maxSales * (1 - g / 3);
    grid += '<line x1="' + L + '" y1="' + y.toFixed(1) + '" x2="' + (W - R) + '" y2="' + y.toFixed(1) + '" class="dash-grid"/>' +
      '<text x="' + (L - 8) + '" y="' + (y + 4).toFixed(1) + '" class="dash-axis" text-anchor="end">' +
      mcEscape(dMoneyShort(v)) + "</text>" +
      '<text x="' + (W - R + 8) + '" y="' + (y + 4).toFixed(1) + '" class="dash-axis dash-axis-alt">' +
      Math.round(maxBills * (1 - g / 3)) + "</text>";
  }

  return '<svg viewBox="0 0 ' + W + " " + H + '" class="dash-svg" role="img" ' +
    'aria-label="Sales and customers over time">' + grid + bars +
    '<path d="' + line.trim() + '" class="dash-line"/>' + dots + labels + "</svg>";
}

function dDayLabel(when, full) {
  if (!when) return "";
  const d = when.getDate();
  const m = DASH_MONTHS[when.getMonth()];
  if (!full) return d + " " + m;
  return DASH_DAYS[when.getDay()] + ", " + d + " " + m + " " + when.getFullYear();
}

function svgDonut(slices, formatter) {
  const total = slices.reduce(function (s, x) { return s + x.value; }, 0);
  if (!slices.length || total <= 0) return '<p class="dash-empty">Nothing to show yet.</p>';

  const S = 200, c = S / 2, rOuter = 88, rInner = 54;
  let angle = -Math.PI / 2, paths = "";

  slices.forEach(function (s, i) {
    const sweep = (s.value / total) * Math.PI * 2;
    const colour = DASH_SERIES[i % DASH_SERIES.length];
    if (sweep >= Math.PI * 2 - 0.0001) {
      paths += '<circle cx="' + c + '" cy="' + c + '" r="' + ((rOuter + rInner) / 2) +
        '" fill="none" stroke="' + colour + '" stroke-width="' + (rOuter - rInner) + '"><title>' +
        mcEscape(s.name + " \u2014 " + formatter(s.value) + " (100%)") + "</title></circle>";
      return;
    }
    const a1 = angle, a2 = angle + sweep;
    const large = sweep > Math.PI ? 1 : 0;
    const p = [
      "M", (c + rOuter * Math.cos(a1)).toFixed(2), (c + rOuter * Math.sin(a1)).toFixed(2),
      "A", rOuter, rOuter, 0, large, 1, (c + rOuter * Math.cos(a2)).toFixed(2), (c + rOuter * Math.sin(a2)).toFixed(2),
      "L", (c + rInner * Math.cos(a2)).toFixed(2), (c + rInner * Math.sin(a2)).toFixed(2),
      "A", rInner, rInner, 0, large, 0, (c + rInner * Math.cos(a1)).toFixed(2), (c + rInner * Math.sin(a1)).toFixed(2),
      "Z"
    ].join(" ");
    paths += '<path d="' + p + '" fill="' + colour + '"><title>' +
      mcEscape(s.name + " \u2014 " + formatter(s.value) + " (" + (s.value / total * 100).toFixed(1) + "%)") +
      "</title></path>";
    angle = a2;
  });

  let legend = "";
  slices.forEach(function (s, i) {
    legend += '<li><i style="background:' + DASH_SERIES[i % DASH_SERIES.length] + '"></i>' +
      "<span>" + mcEscape(s.name) + "</span><b>" + mcEscape((s.value / total * 100).toFixed(1) + "%") + "</b></li>";
  });

  return '<div class="dash-donut-wrap">' +
    '<svg viewBox="0 0 ' + S + " " + S + '" class="dash-donut" role="img" aria-label="Share chart">' + paths + "</svg>" +
    '<ul class="dash-legend">' + legend + "</ul></div>";
}

function topSlices(products, key, max) {
  const list = products.filter(function (p) { return p[key] > 0; })
    .sort(function (a, b) { return b[key] - a[key]; })
    .map(function (p) { return { name: p.name, value: p[key] }; });
  if (list.length <= max) return list;
  const head = list.slice(0, max);
  const rest = list.slice(max).reduce(function (s, x) { return s + x.value; }, 0);
  head.push({ name: "Other (" + (list.length - max) + ")", value: rest });
  return head;
}

/* ==================================================================
   Rendering
   ================================================================== */

function renderKpis(res) {
  const t = res.totals;
  const qtyBits = res.quantityByFamily.filter(function (q) { return q.value; });
  const qtyMain = qtyBits.length ? dQty(qtyBits[0].value, qtyBits[0].unit) : "0";
  const qtyRest = qtyBits.slice(1).map(function (q) { return dQty(q.value, q.unit); }).join(" \u00B7 ");

  const cards = [
    { label: "Customers", value: dCount(t.customers), sub: "Separate bills",
      note: t.customers ? "Average bill " + dMoney(t.netSales / t.customers) : "No bills yet", tone: "blue" },
    { label: "Total sales", value: dMoney(t.netSales), sub: "After line discounts",
      note: "Before discount " + dMoney(t.grossSales), tone: "gold" },
    { label: "Quantity sold", value: qtyMain, sub: qtyRest || "Converted through the Units master",
      note: res.counts.days + " day(s) with sales", tone: "green" },
    { label: "Discounts", value: dMoney(t.discount), sub: "Given on sales lines",
      note: t.grossSales ? dPct(t.discount / t.grossSales * 100) + " of gross" : "\u2014", tone: "rust" },
    { label: "Ordered value", value: dMoney(t.orderedAmt), sub: t.orders + " order(s)",
      note: "Advance " + (res.allProducts ? dMoney(t.advance) : "\u2014"), tone: "indigo" },
    { label: "Balance on orders", value: res.allProducts ? dMoney(t.balance) : "\u2014",
      sub: "To collect on delivery", note: res.allProducts ? "" : "Hidden while a product filter is on", tone: "plum" },
    { label: "Payment pending", value: dMoney(t.pendingAmt), sub: t.pendingBills + " pending bill(s)",
      note: "After bill discount", tone: "rust" },
    { label: "Cash / UPI", value: res.allProducts ? dMoney(t.collected) : "\u2014",
      sub: res.allProducts ? dMoney(t.cash) + " cash \u00B7 " + dMoney(t.online) + " UPI" : "Per bill, not per product",
      note: "", tone: "teal" },
    { label: "Losses", value: "0", sub: dMoney(0),
      note: "Not tracked yet", tone: "muted" },
    { label: "Profit", value: "1", sub: "Placeholder",
      note: "Needs costs from Procurement", tone: "muted" }
  ];

  document.getElementById("dashKpis").innerHTML = cards.map(function (c) {
    return '<article class="kpi kpi-' + c.tone + '">' +
      '<h3 class="kpi-label">' + mcEscape(c.label) + "</h3>" +
      '<p class="kpi-value">' + mcEscape(c.value) + "</p>" +
      '<p class="kpi-sub">' + mcEscape(c.sub) + "</p>" +
      (c.note ? '<p class="kpi-note">' + mcEscape(c.note) + "</p>" : "") +
      "</article>";
  }).join("");
}

function renderLadder(res) {
  const list = res.products.filter(function (p) { return p.netSales > 0 || p.billCount > 0; });
  const host = document.getElementById("dashLadder");
  if (!list.length) {
    host.innerHTML = '<p class="dash-empty">No sales to rank for these filters.</p>';
    return;
  }
  const max = Math.max.apply(null, list.map(function (p) {
    return Math.max(p.pctSales, p.pctCustomers);
  }).concat([1]));

  host.innerHTML = list.slice(0, 40).map(function (p) {
    const w = Math.max(1.5, (p.pctSales / max) * 100);
    const c = Math.min(100, (p.pctCustomers / max) * 100);
    return '<div class="rung">' +
      '<span class="rung-name">' + mcEscape(p.name) + "</span>" +
      '<span class="rung-track"><span class="rung-fill" style="width:' + w.toFixed(1) + '%"></span>' +
        '<span class="rung-mark" style="left:' + c.toFixed(1) + '%" title="Customer share ' + dPct(p.pctCustomers) + '"></span></span>' +
      '<span class="rung-value">' + mcEscape(dMoney(p.netSales)) +
        "<small>" + dPct(p.pctSales) + " sales \u00B7 " + dPct(p.pctCustomers) + " customers</small></span>" +
      "</div>";
  }).join("");
}

const DASH_COLUMNS = [
  { k: "name", t: "Product", type: "text" },
  { k: "billCount", t: "Customers", type: "count" },
  { k: "pctCustomers", t: "% customers", type: "pctc" },
  { k: "netSales", t: "Sales", type: "money" },
  { k: "pctSales", t: "% sales", type: "pcts" },
  { k: "qtyDisplay", t: "Quantity", type: "qty" },
  { k: "discount", t: "Discount", type: "money" },
  { k: "avgPerBill", t: "Avg / bill", type: "money" },
  { k: "orderedQtyDisplay", t: "Ordered qty", type: "qty" },
  { k: "orderAmt", t: "Order value", type: "money" },
  { k: "dueQtyDisplay", t: "Delivery due", type: "qty" },
  { k: "pendingAmt", t: "Pending", type: "money" },
  { k: "lossQty", t: "Loss qty", type: "count" },
  { k: "lossAmt", t: "Loss value", type: "money" }
];

function renderTable(res) {
  const head = DASH_COLUMNS.map(function (c) {
    const on = DASH_SORT.key === c.k;
    return '<th data-key="' + c.k + '" class="' + (on ? "is-sorted" : "") + '" scope="col">' +
      mcEscape(c.t) + (on ? (DASH_SORT.dir < 0 ? " \u2193" : " \u2191") : "") + "</th>";
  }).join("");
  document.getElementById("dashTableHead").innerHTML = head;

  const rows = res.products.slice().sort(function (a, b) {
    if (DASH_SORT.key === "name") return DASH_SORT.dir * a.name.localeCompare(b.name);
    return DASH_SORT.dir * ((a[DASH_SORT.key] || 0) - (b[DASH_SORT.key] || 0));
  });

  document.getElementById("dashTableBody").innerHTML = rows.map(function (p) {
    return "<tr>" + DASH_COLUMNS.map(function (c) {
      const v = p[c.k] || 0;
      let cell;
      if (c.type === "text") cell = mcEscape(p.name) + (p.unit ? '<em class="unit">' + mcEscape(p.unit) + "</em>" : "");
      else if (c.type === "money") cell = v ? mcEscape(dMoney(v)) : '<span class="nil">&mdash;</span>';
      else if (c.type === "qty") cell = v ? mcEscape(dQty(v, p.unit)) : '<span class="nil">&mdash;</span>';
      else if (c.type === "count") cell = v ? mcEscape(dCount(v)) : '<span class="nil">&mdash;</span>';
      else if (c.type === "pctc") cell = '<span class="chip chip-cust">' + dPct(v) + "</span>";
      else cell = '<span class="chip chip-sales">' + dPct(v) + "</span>";
      return '<td class="' + (c.type === "text" ? "cell-name" : "num") + '">' + cell + "</td>";
    }).join("") + "</tr>";
  }).join("") ||
    '<tr><td colspan="' + DASH_COLUMNS.length + '" class="dash-empty">No products match these filters.</td></tr>';

  const t = res.totals;
  const qtyBits = res.quantityByFamily.filter(function (q) { return q.value; })
    .map(function (q) { return dQty(q.value, q.unit); }).join(" + ") || "\u2014";
  document.getElementById("dashTableFoot").innerHTML = "<tr>" + [
    "<td>All selected products</td>",
    "<td>" + dCount(t.customers) + "</td>",
    "<td>100%</td>",
    "<td>" + dMoney(t.netSales) + "</td>",
    "<td>100%</td>",
    "<td>" + mcEscape(qtyBits) + "</td>",
    "<td>" + dMoney(t.discount) + "</td>",
    "<td>" + dMoney(t.customers ? t.netSales / t.customers : 0) + "</td>",
    "<td>&mdash;</td>",
    "<td>" + dMoney(t.orderedAmt) + "</td>",
    "<td>&mdash;</td>",
    "<td>" + dMoney(t.pendingAmt) + "</td>",
    "<td>0</td>",
    "<td>" + dMoney(0) + "</td>"
  ].join("") + "</tr>";

  document.getElementById("dashTableHead").querySelectorAll("th").forEach(function (th) {
    th.addEventListener("click", function () {
      const k = th.getAttribute("data-key");
      if (DASH_SORT.key === k) DASH_SORT.dir = -DASH_SORT.dir;
      else { DASH_SORT.key = k; DASH_SORT.dir = (k === "name") ? 1 : -1; }
      renderTable(DASH_RESULT);
    });
  });
}

function renderNotes(res) {
  const box = document.getElementById("dashNotes");
  if (!res.warnings.length) { box.innerHTML = ""; return; }
  box.innerHTML = '<div class="dash-note-card"><h3>Worth knowing</h3><ul>' +
    res.warnings.map(function (w) { return "<li>" + mcEscape(w) + "</li>"; }).join("") +
    "</ul></div>";
}

function renderAll(res) {
  DASH_RESULT = res;
  renderKpis(res);
  document.getElementById("dashTrend").innerHTML = svgBarLine(res.trend);
  document.getElementById("dashSalesShare").innerHTML =
    svgDonut(topSlices(res.products, "netSales", 8), dMoney);
  document.getElementById("dashCustomerShare").innerHTML =
    svgDonut(topSlices(res.products, "billCount", 8), function (v) { return dCount(v) + " bills"; });
  renderLadder(res);
  renderTable(res);
  renderNotes(res);

  document.getElementById("dashFootnote").textContent =
    "Loaded \u2014 Sales " + dCount(res.counts.salesRows) + " lines \u00B7 Orders " +
    dCount(res.counts.orderRows) + " \u00B7 Pending " + dCount(res.counts.pendingRows) +
    " \u00B7 Products " + dCount(res.counts.productRows) + " \u00B7 Units " +
    dCount(res.counts.unitRows) + ". " +
    "Refreshed " + formatTimestamp(res.generatedAt) + ". " +
    "A customer who buys two products counts once overall but once under each product, so the product percentages add up to more than 100.";
}

/* ==================================================================
   Filters and boot
   ================================================================== */

function dayOptions(year, month) {
  const n = (year && month) ? dDaysInMonth(year, month) : 31;
  const out = [];
  for (let i = 1; i <= n; i++) out.push({ v: i, t: String(i) });
  return out;
}

function refreshDayOptions() {
  const y = DASH_FILTERS.year.picked();
  const m = DASH_FILTERS.month.picked();
  const oneYear = (y && y.length === 1) ? Number(y[0]) : null;
  const oneMonth = (m && m.length === 1) ? Number(m[0]) : null;
  DASH_FILTERS.day.setOptions(dayOptions(oneYear, oneMonth));
}

function currentFilters() {
  return {
    days: DASH_FILTERS.day.value(),
    dayNames: DASH_FILTERS.dow.value(),
    weeks: DASH_FILTERS.week.value(),
    months: DASH_FILTERS.month.value(),
    years: DASH_FILTERS.year.value(),
    products: DASH_FILTERS.product.value()
  };
}

function buildFilters(raw) {
  const now = new Date();
  const years = [];
  const maxYear = Math.max(now.getFullYear() + 1, DASH_MIN_YEAR + 1);
  for (let y = DASH_MIN_YEAR; y <= maxYear; y++) years.push({ v: y, t: String(y) });

  const productNames = [];
  const seen = {};
  (raw.products || []).forEach(function (p) {
    const n = String(p.ProductName || "").trim();
    if (n && !seen[n.toLowerCase()]) {
      seen[n.toLowerCase()] = true;
      productNames.push({ v: n, t: n, note: String(p.Unit || "") });
    }
  });
  productNames.sort(function (a, b) { return a.t.localeCompare(b.t); });

  DASH_FILTERS.day = new DashSelect("filterDay", {
    id: "day", options: dayOptions(now.getFullYear(), now.getMonth() + 1), selected: [now.getDate()]
  });
  DASH_FILTERS.dow = new DashSelect("filterDow", {
    id: "dow", options: DASH_DAYS.map(function (d) { return { v: d, t: d }; }),
    selected: [DASH_DAYS[now.getDay()]]
  });
  DASH_FILTERS.week = new DashSelect("filterWeek", {
    id: "week", options: [1, 2, 3, 4, 5, 6].map(function (w) { return { v: w, t: "Week " + w }; }),
    selected: [dWeekOfMonth(now)]
  });
  DASH_FILTERS.month = new DashSelect("filterMonth", {
    id: "month", options: DASH_MONTHS.map(function (m, i) { return { v: i + 1, t: m }; }),
    selected: [now.getMonth() + 1], onChange: refreshDayOptions
  });
  DASH_FILTERS.year = new DashSelect("filterYear", {
    id: "year", options: years, selected: [now.getFullYear()], onChange: refreshDayOptions
  });
  DASH_FILTERS.product = new DashSelect("filterProduct", {
    id: "product", options: productNames, selected: "all", searchable: true
  });
}

function resetFilters() {
  const now = new Date();
  DASH_FILTERS.day.setOptions(dayOptions(now.getFullYear(), now.getMonth() + 1), [now.getDate()]);
  DASH_FILTERS.dow.setOptions(DASH_FILTERS.dow.cfg.options, [DASH_DAYS[now.getDay()]]);
  DASH_FILTERS.week.setOptions(DASH_FILTERS.week.cfg.options, [dWeekOfMonth(now)]);
  DASH_FILTERS.month.setOptions(DASH_FILTERS.month.cfg.options, [now.getMonth() + 1]);
  DASH_FILTERS.year.setOptions(DASH_FILTERS.year.cfg.options, [now.getFullYear()]);
  DASH_FILTERS.product.setOptions(DASH_FILTERS.product.cfg.options, "all");
  markRange(null);
  apply();
}

function applyRange(range) {
  const now = new Date();
  const F = DASH_FILTERS;
  if (range === "today") {
    F.day.setOptions(dayOptions(now.getFullYear(), now.getMonth() + 1), [now.getDate()]);
    F.dow.setOptions(F.dow.cfg.options, "ignore");
    F.week.setOptions(F.week.cfg.options, "ignore");
    F.month.setOptions(F.month.cfg.options, [now.getMonth() + 1]);
    F.year.setOptions(F.year.cfg.options, [now.getFullYear()]);
  } else if (range === "week") {
    F.day.setOptions(F.day.cfg.options, "ignore");
    F.dow.setOptions(F.dow.cfg.options, "ignore");
    F.week.setOptions(F.week.cfg.options, [dWeekOfMonth(now)]);
    F.month.setOptions(F.month.cfg.options, [now.getMonth() + 1]);
    F.year.setOptions(F.year.cfg.options, [now.getFullYear()]);
  } else if (range === "month") {
    F.day.setOptions(F.day.cfg.options, "ignore");
    F.dow.setOptions(F.dow.cfg.options, "ignore");
    F.week.setOptions(F.week.cfg.options, "ignore");
    F.month.setOptions(F.month.cfg.options, [now.getMonth() + 1]);
    F.year.setOptions(F.year.cfg.options, [now.getFullYear()]);
  } else if (range === "year") {
    ["day", "dow", "week", "month"].forEach(function (k) { F[k].setOptions(F[k].cfg.options, "ignore"); });
    F.year.setOptions(F.year.cfg.options, [now.getFullYear()]);
  } else {
    ["day", "dow", "week", "month", "year"].forEach(function (k) { F[k].setOptions(F[k].cfg.options, "ignore"); });
  }
  markRange(range);
  apply();
}

function markRange(range) {
  document.querySelectorAll("#dashRanges button").forEach(function (b) {
    b.classList.toggle("is-on", b.getAttribute("data-range") === range);
  });
}

function setBusy(on) {
  document.getElementById("dashBusy").style.display = on ? "flex" : "none";
}

function showError(message) {
  document.getElementById("dashError").innerHTML =
    '<div class="dash-note-card is-error"><h3>Could not load the dashboard</h3><p>' +
    mcEscape(message) + "</p></div>";
}

function apply() {
  if (!DASH_RAW) return;
  setBusy(true);
  // Let the browser paint the spinner before the aggregation blocks it.
  // A load error stays on screen until the next Reload data — filtering does
  // not make a failed fetch untrue.
  setTimeout(function () {
    try {
      renderAll(aggregate(DASH_RAW, currentFilters()));
    } catch (err) {
      showError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }, 10);
}

async function boot(force) {
  setBusy(true);
  document.getElementById("dashError").innerHTML = "";
  try {
    DASH_RAW = await loadDashboardData(force);
    if (DASH_RAW.errors.length) showError(DASH_RAW.errors.join(" \u00B7 "));
    if (!DASH_FILTERS.day) buildFilters(DASH_RAW);
    else DASH_FILTERS.product.setOptions(DASH_FILTERS.product.cfg.options);
    renderAll(aggregate(DASH_RAW, currentFilters()));
  } catch (err) {
    showError(err.message || String(err));
  } finally {
    setBusy(false);
  }
}

if (session) {
  setImage(document.getElementById("appLogo"), "appLogo");
  setImage(document.getElementById("logoutIcon"), "logoutIcon");
  const label = document.getElementById("userLabel");
  if (label) label.textContent = session.name + " (" + session.role + ")";
  document.getElementById("logoutBtn").addEventListener("click", logout);

  document.addEventListener("click", closeAllSelects);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeAllSelects();
  });

  document.getElementById("applyBtn").addEventListener("click", apply);
  document.getElementById("resetBtn").addEventListener("click", resetFilters);
  document.getElementById("reloadBtn").addEventListener("click", function () { boot(true); });
  document.getElementById("dashRanges").addEventListener("click", function (e) {
    const b = e.target.closest("button[data-range]");
    if (b) applyRange(b.getAttribute("data-range"));
  });

  document.querySelectorAll(".dash-tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      document.querySelectorAll(".dash-tab").forEach(function (t) {
        t.classList.toggle("is-active", t === tab);
      });
      document.querySelectorAll(".dash-pane").forEach(function (p) {
        p.classList.toggle("is-active", p.id === "pane-" + tab.getAttribute("data-pane"));
      });
    });
  });

  apiWarmUp();
  boot(false);
}

/*
  master-common.js
  ==================================================================
  Shared helpers reused by every page under pages/master/ and by Raw
  Material Procurement / Products Made / Sales.

  PERFORMANCE REWRITE. Every function keeps its old name and arguments,
  so no calling page had to change. What changed:

    * A dropdown now fills INSTANTLY from api.js's cache when the sheet
      has already been read in this session, and only shows "Loading..."
      when there is genuinely nothing to show yet.

    * Dropdowns keep the value the user had selected when they are
      refilled, instead of silently resetting to blank.

    * loadDropdowns() fills several dropdowns from ONE network request
      instead of one request each.

    * Options are built as a single HTML string rather than by appending
      option elements one at a time, which avoids a layout pass per item
      on long lists.
  ==================================================================
*/

// Escapes text before it goes into an option/table cell.
function mcEscape(value) {
  const div = document.createElement("div");
  div.textContent = value === undefined || value === null ? "" : String(value);
  return div.innerHTML;
}

/*
  Fills a <select> from a list of strings in one assignment.
  Restores `keepValue` if it is still one of the options.
*/
function fillSelectFromList(selectElement, values, placeholder, emptyMessage, keepValue) {
  if (!selectElement) return;

  if (!values || values.length === 0) {
    selectElement.innerHTML = '<option value="">' + emptyMessage + "</option>";
    return;
  }

  let html = '<option value="">' + placeholder + "</option>";
  for (let i = 0; i < values.length; i++) {
    const safe = mcEscape(values[i]);
    html += '<option value="' + safe + '">' + safe + "</option>";
  }
  selectElement.innerHTML = html;

  if (keepValue) {
    selectElement.value = keepValue;
    // If the old value no longer exists, fall back to the placeholder.
    if (selectElement.value !== keepValue) selectElement.value = "";
  }
}

// Pulls the distinct, non-empty values of one column out of a row list.
function distinctColumn(rows, key) {
  const seen = {};
  const out = [];
  (rows || []).forEach(function (r) {
    const v = r[key];
    if (v !== undefined && v !== null && v !== "" && !seen[v]) {
      seen[v] = true;
      out.push(v);
    }
  });
  return out;
}

/*
  The generic loader behind all four of the named ones below.

  `force` (optional) makes it skip the cache — that is what the
  "Refresh" buttons pass.
*/
async function loadDropdownFromSheet(selectElement, config, force) {
  if (!selectElement) return;

  const keep = selectElement.value;

  // Only show a loading placeholder if the box is currently empty.
  // When we already have cached values, the user never sees a flicker.
  const hasOptions = selectElement.options.length > 1;
  if (!hasOptions) {
    selectElement.innerHTML = '<option value="">' + config.loadingLabel + "</option>";
  }

  try {
    const rows = await apiListRows(config.sheet, { force: !!force });
    const values = distinctColumn(rows, config.column);
    fillSelectFromList(selectElement, values, config.placeholder, config.emptyLabel, keep);
  } catch (err) {
    if (!hasOptions) {
      selectElement.innerHTML = '<option value="">' + config.errorLabel + "</option>";
    }
    console.error(config.sheet + " dropdown load failed:", err);
  }
}

const DROPDOWN_SOURCES = {
  units: {
    sheet: "Units",
    column: "UnitName",
    loadingLabel: "Loading units...",
    placeholder: "Select a unit",
    emptyLabel: "No units added yet — add one in Units first",
    errorLabel: "Could not load units"
  },
  rawMaterials: {
    sheet: "RawMaterials",
    column: "RawMaterialName",
    loadingLabel: "Loading raw materials...",
    placeholder: "Select a raw material",
    emptyLabel: "No raw materials added yet — add one in Raw Materials first",
    errorLabel: "Could not load raw materials"
  },
  products: {
    sheet: "ProductMaster",
    column: "ProductName",
    loadingLabel: "Loading products...",
    placeholder: "Select a product",
    emptyLabel: "No products added yet — add one in Product Master first",
    errorLabel: "Could not load products"
  },
  employees: {
    sheet: "EmployeeMaster",
    column: "EmployeeName",
    loadingLabel: "Loading employees...",
    placeholder: "Select who made it",
    emptyLabel: "No employees added yet — add one in Employee Master first",
    errorLabel: "Could not load employees"
  }
};

// --- The four original loaders. Same names, same arguments. ---

async function loadUnitsDropdown(selectElement, force) {
  return loadDropdownFromSheet(selectElement, DROPDOWN_SOURCES.units, force);
}

async function loadRawMaterialsDropdown(selectElement, force) {
  return loadDropdownFromSheet(selectElement, DROPDOWN_SOURCES.rawMaterials, force);
}

async function loadProductNamesDropdown(selectElement, force) {
  return loadDropdownFromSheet(selectElement, DROPDOWN_SOURCES.products, force);
}

async function loadEmployeeNamesDropdown(selectElement, force) {
  return loadDropdownFromSheet(selectElement, DROPDOWN_SOURCES.employees, force);
}

/*
  NEW — fills several dropdowns from ONE round trip.

  Instead of:
      loadRawMaterialsDropdown(a);   // request 1
      loadUnitsDropdown(b);          // request 2
  write:
      loadDropdowns([
        { element: a, source: "rawMaterials" },
        { element: b, source: "units" }
      ]);
  which is a single request for both sheets.
*/
async function loadDropdowns(specs, force) {
  const sheets = [];
  specs.forEach(function (spec) {
    const cfg = DROPDOWN_SOURCES[spec.source];
    if (cfg && sheets.indexOf(cfg.sheet) === -1) sheets.push(cfg.sheet);
  });

  // Show placeholders only where there is nothing to display yet.
  const keeps = specs.map(function (spec) {
    const cfg = DROPDOWN_SOURCES[spec.source];
    if (!spec.element || !cfg) return "";
    const keep = spec.element.value;
    if (spec.element.options.length <= 1) {
      spec.element.innerHTML = '<option value="">' + cfg.loadingLabel + "</option>";
    }
    return keep;
  });

  const data = await apiListMany(sheets, { force: !!force });

  specs.forEach(function (spec, i) {
    const cfg = DROPDOWN_SOURCES[spec.source];
    if (!spec.element || !cfg) return;

    if (data._errors && data._errors[cfg.sheet]) {
      if (spec.element.options.length <= 1) {
        spec.element.innerHTML = '<option value="">' + cfg.errorLabel + "</option>";
      }
      return;
    }

    const values = distinctColumn(data[cfg.sheet], cfg.column);
    fillSelectFromList(
      spec.element,
      values,
      spec.placeholder || cfg.placeholder,
      cfg.emptyLabel,
      keeps[i]
    );
  });

  return data;
}

// --- Unchanged UI helpers ---

// Shows a success/error message under a form. Pass isError=true for errors.
function showFormStatus(statusElement, message, isError) {
  if (!statusElement) return;
  statusElement.textContent = message;
  statusElement.className = "form-status " + (isError ? "form-status-error" : "form-status-success");
  statusElement.style.display = message ? "block" : "none";
}

// Disables/enables a submit button and swaps its label while a save runs.
function setButtonBusy(button, isBusy, busyLabel, normalLabel) {
  if (!button) return;
  button.disabled = isBusy;
  button.textContent = isBusy ? busyLabel : normalLabel;
}

// Formats a Timestamp (ISO string or Date) into a short, readable date.
function formatTimestamp(value) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

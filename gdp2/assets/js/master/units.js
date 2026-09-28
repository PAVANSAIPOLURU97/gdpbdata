/*
  units.js — logic for pages/master/units.html
  Sheet: "Units"   Columns: UnitName | Factor | Family | AddedBy | Timestamp

  PERFORMANCE NOTE: the list is now built as one string and written to the
  DOM once, and the reload after a save is the only network call the page
  makes beyond its first load. Units is also one of the sheets api.js keeps
  in sessionStorage, so every other page that needs a Unit dropdown gets it
  from here with no request at all.
*/

const session = requireLogin("master");

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value === undefined || value === null ? "" : String(value);
  return div.innerHTML;
}

async function refreshUnitsList(force) {
  const listArea = document.getElementById("listArea");
  if (listArea.innerHTML.indexOf("data-table") === -1) {
    listArea.innerHTML = '<p class="list-loading">Loading...</p>';
  }
  try {
    const rows = await apiListRows("Units", { force: !!force });
    if (rows.length === 0) {
      listArea.innerHTML = '<p class="list-empty">No units added yet. Add your first one on the left.</p>';
      return;
    }
    const parts = ['<table class="data-table"><thead><tr><th>Unit Name</th><th>Factor</th><th>Family</th><th>Added</th></tr></thead><tbody>'];
    rows.forEach(function (r) {
      const factor = (r.Factor === "" || r.Factor === undefined || r.Factor === null) ? "\u2014" : r.Factor;
      const family = (r.Family === "" || r.Family === undefined || r.Family === null) ? "\u2014" : r.Family;
      parts.push("<tr><td>" + escapeHtml(r.UnitName) + "</td><td>" + escapeHtml(factor) +
        "</td><td>" + escapeHtml(family) + "</td><td>" + escapeHtml(formatTimestamp(r.Timestamp)) + "</td></tr>");
    });
    parts.push("</tbody></table>");
    listArea.innerHTML = parts.join("");
  } catch (err) {
    listArea.innerHTML = '<p class="list-empty">' + escapeHtml(err.message) + "</p>";
  }
}

if (session) {
  setImage(document.getElementById("appLogo"), "appLogo");
  setImage(document.getElementById("logoutIcon"), "logoutIcon");
  document.getElementById("logoutBtn").addEventListener("click", logout);

  apiWarmUp();
  refreshUnitsList(false);

  document.getElementById("unitForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    const submitBtn = document.getElementById("submitBtn");
    const statusEl = document.getElementById("formStatus");
    const unitName = document.getElementById("unitName").value.trim();
    const factor = document.getElementById("factor").value;
    const family = document.getElementById("family").value;

    if (!unitName) {
      showFormStatus(statusEl, "Please enter a unit name.", true);
      return;
    }
    if (factor === "" || Number(factor) <= 0) {
      showFormStatus(statusEl, "Please enter a factor greater than 0 (e.g. Kg=1000, gms=1).", true);
      return;
    }
    if (!family) {
      showFormStatus(statusEl, "Please select a family.", true);
      return;
    }

    setButtonBusy(submitBtn, true, "Saving...", "Add Unit");
    try {
      await apiAddRow("Units", { UnitName: unitName, Factor: Number(factor), Family: family });
      showFormStatus(statusEl, "Unit added.", false);
      document.getElementById("unitForm").reset();
      refreshUnitsList(true);
    } catch (err) {
      showFormStatus(statusEl, err.message, true);
    } finally {
      setButtonBusy(submitBtn, false, "Saving...", "Add Unit");
    }
  });
}

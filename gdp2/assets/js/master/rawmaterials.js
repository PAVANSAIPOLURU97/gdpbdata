/*
  rawmaterials.js — logic for pages/master/rawmaterials.html
  Sheet: "RawMaterials"   Columns: RawMaterialName | Quantity | Unit | PurchasePrice | AddedBy | Timestamp
  Depends on: "Units" sheet, for the Unit dropdown.

  PERFORMANCE NOTE: the Unit dropdown comes from cache after a save
  instead of being refetched, and the list is written in one DOM pass.
*/

const session = requireLogin("master");

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value === undefined || value === null ? "" : String(value);
  return div.innerHTML;
}

async function refreshRawMaterialsList(force) {
  const listArea = document.getElementById("listArea");
  if (listArea.innerHTML.indexOf("data-table") === -1) {
    listArea.innerHTML = '<p class="list-loading">Loading...</p>';
  }
  try {
    const rows = await apiListRows("RawMaterials", { force: !!force });
    if (rows.length === 0) {
      listArea.innerHTML = '<p class="list-empty">No raw materials added yet. Add your first one on the left.</p>';
      return;
    }
    const parts = ['<table class="data-table"><thead><tr><th>Name</th><th>Quantity</th><th>Unit</th><th>Purchase Price</th></tr></thead><tbody>'];
    rows.forEach(function (r) {
      parts.push("<tr><td>" + escapeHtml(r.RawMaterialName) + "</td><td>" + escapeHtml(r.Quantity) +
        "</td><td>" + escapeHtml(r.Unit) + "</td><td>" + escapeHtml(r.PurchasePrice) + "</td></tr>");
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
  loadUnitsDropdown(document.getElementById("unit"));
  refreshRawMaterialsList(false);

  document.getElementById("rawMaterialForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    const submitBtn = document.getElementById("submitBtn");
    const statusEl = document.getElementById("formStatus");

    const materialName = document.getElementById("materialName").value.trim();
    const quantity = document.getElementById("quantity").value;
    const unit = document.getElementById("unit").value;
    const purchasePrice = document.getElementById("purchasePrice").value;

    if (!materialName || quantity === "" || !unit || purchasePrice === "") {
      showFormStatus(statusEl, "Please fill in every field.", true);
      return;
    }

    setButtonBusy(submitBtn, true, "Saving...", "Add Raw Material");
    try {
      await apiAddRow("RawMaterials", {
        RawMaterialName: materialName,
        Quantity: Number(quantity),
        Unit: unit,
        PurchasePrice: Number(purchasePrice)
      });
      showFormStatus(statusEl, "Raw material added.", false);
      document.getElementById("rawMaterialForm").reset();
      loadUnitsDropdown(document.getElementById("unit"));  // from cache — instant
      refreshRawMaterialsList(true);
    } catch (err) {
      showFormStatus(statusEl, err.message, true);
    } finally {
      setButtonBusy(submitBtn, false, "Saving...", "Add Raw Material");
    }
  });
}

/*
  product-master.js — logic for pages/master/product-master.html
  Sheet: "ProductMaster"   Columns: ProductName | Quantity | Unit | Price | StatusAvailability | AddedBy | Timestamp
  Depends on: "Units" sheet, for the Unit dropdown.

  PERFORMANCE NOTE: the Unit dropdown is refilled from cache after a save
  rather than refetched — adding a product cannot change the Units master,
  so that round trip was pure waste. Sales and Products Made reuse this
  cached ProductMaster for their own dropdowns.
*/

const session = requireLogin("master");

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value === undefined || value === null ? "" : String(value);
  return div.innerHTML;
}

async function refreshProductsList(force) {
  const listArea = document.getElementById("listArea");
  if (listArea.innerHTML.indexOf("data-table") === -1) {
    listArea.innerHTML = '<p class="list-loading">Loading...</p>';
  }
  try {
    const rows = await apiListRows("ProductMaster", { force: !!force });
    if (rows.length === 0) {
      listArea.innerHTML = '<p class="list-empty">No products added yet. Add your first one on the left.</p>';
      return;
    }
    const parts = ['<table class="data-table"><thead><tr><th>Name</th><th>Quantity</th><th>Unit</th><th>Price</th><th>Available?</th></tr></thead><tbody>'];
    rows.forEach(function (r) {
      const status = (r.StatusAvailability === "" || r.StatusAvailability === undefined || r.StatusAvailability === null) ? "\u2014" : r.StatusAvailability;
      parts.push("<tr><td>" + escapeHtml(r.ProductName) + "</td><td>" + escapeHtml(r.Quantity) +
        "</td><td>" + escapeHtml(r.Unit) + "</td><td>" + escapeHtml(r.Price) +
        "</td><td>" + escapeHtml(status) + "</td></tr>");
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
  refreshProductsList(false);

  document.getElementById("productForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    const submitBtn = document.getElementById("submitBtn");
    const statusEl = document.getElementById("formStatus");

    const productName = document.getElementById("productName").value.trim();
    const quantity = document.getElementById("quantity").value;
    const unit = document.getElementById("unit").value;
    const price = document.getElementById("price").value;
    const statusAvailability = document.getElementById("statusAvailability").value;

    if (!productName || quantity === "" || !unit || price === "" || !statusAvailability) {
      showFormStatus(statusEl, "Please fill in every field.", true);
      return;
    }

    setButtonBusy(submitBtn, true, "Saving...", "Add Product");
    try {
      await apiAddRow("ProductMaster", {
        ProductName: productName,
        Quantity: Number(quantity),
        Unit: unit,
        Price: Number(price),
        StatusAvailability: statusAvailability
      });
      showFormStatus(statusEl, "Product added.", false);
      document.getElementById("productForm").reset();
      loadUnitsDropdown(document.getElementById("unit"));  // from cache — instant
      refreshProductsList(true);
    } catch (err) {
      showFormStatus(statusEl, err.message, true);
    } finally {
      setButtonBusy(submitBtn, false, "Saving...", "Add Product");
    }
  });
}

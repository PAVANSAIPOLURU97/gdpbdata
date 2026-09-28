/*
  milk-master.js — logic for pages/master/milk-master.html
  Sheet: "MilkMaster"   Columns: MilkType | MinFat | MinSNF | MinPointsReq | AddedBy | Timestamp

  PERFORMANCE NOTE: the list is written to the DOM in one operation, and
  the sheet is only refetched after a save. Milk Input reuses this cached
  copy for its Milk Type dropdown instead of downloading it again.
*/

const session = requireLogin("master");

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value === undefined || value === null ? "" : String(value);
  return div.innerHTML;
}

async function refreshMilkList(force) {
  const listArea = document.getElementById("listArea");
  if (listArea.innerHTML.indexOf("data-table") === -1) {
    listArea.innerHTML = '<p class="list-loading">Loading...</p>';
  }
  try {
    const rows = await apiListRows("MilkMaster", { force: !!force });
    if (rows.length === 0) {
      listArea.innerHTML = '<p class="list-empty">No milk types added yet. Add your first one on the left.</p>';
      return;
    }
    const parts = ['<table class="data-table"><thead><tr><th>Milk Type</th><th>Min Fat %</th><th>Min SNF %</th><th>Min Points</th></tr></thead><tbody>'];
    rows.forEach(function (r) {
      parts.push("<tr><td>" + escapeHtml(r.MilkType) + "</td><td>" + escapeHtml(r.MinFat) +
        "</td><td>" + escapeHtml(r.MinSNF) + "</td><td>" + escapeHtml(r.MinPointsReq) + "</td></tr>");
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
  refreshMilkList(false);

  document.getElementById("milkForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    const submitBtn = document.getElementById("submitBtn");
    const statusEl = document.getElementById("formStatus");

    const milkType = document.getElementById("milkType").value.trim();
    const minFat = document.getElementById("minFat").value;
    const minSnf = document.getElementById("minSnf").value;
    const minPoints = document.getElementById("minPoints").value;

    if (!milkType || minFat === "" || minSnf === "" || minPoints === "") {
      showFormStatus(statusEl, "Please fill in every field.", true);
      return;
    }

    setButtonBusy(submitBtn, true, "Saving...", "Add Milk Type");
    try {
      await apiAddRow("MilkMaster", {
        MilkType: milkType,
        MinFat: Number(minFat),
        MinSNF: Number(minSnf),
        MinPointsReq: Number(minPoints)
      });
      showFormStatus(statusEl, "Milk type added.", false);
      document.getElementById("milkForm").reset();
      refreshMilkList(true);
    } catch (err) {
      showFormStatus(statusEl, err.message, true);
    } finally {
      setButtonBusy(submitBtn, false, "Saving...", "Add Milk Type");
    }
  });
}

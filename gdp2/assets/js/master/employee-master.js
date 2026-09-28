/*
  employee-master.js — logic for pages/master/employee-master.html
  Sheet: "EmployeeMaster"
  Columns: EmployeeName | Role | Salary | PhoneNumber | Address | EmergencyContactNumber | AddedBy | Timestamp

  PERFORMANCE NOTE: the list is written to the DOM in one operation and the
  sheet is only refetched after a save. Sales and Products Made reuse this
  cached copy for their Biller / Made By dropdowns.
*/

const session = requireLogin("master");

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value === undefined || value === null ? "" : String(value);
  return div.innerHTML;
}

async function refreshEmployeesList(force) {
  const listArea = document.getElementById("listArea");
  if (listArea.innerHTML.indexOf("data-table") === -1) {
    listArea.innerHTML = '<p class="list-loading">Loading...</p>';
  }
  try {
    const rows = await apiListRows("EmployeeMaster", { force: !!force });
    if (rows.length === 0) {
      listArea.innerHTML = '<p class="list-empty">No employees added yet. Add your first one on the left.</p>';
      return;
    }
    const parts = ['<table class="data-table"><thead><tr><th>Name</th><th>Role</th><th>Salary</th><th>Phone</th></tr></thead><tbody>'];
    rows.forEach(function (r) {
      parts.push("<tr><td>" + escapeHtml(r.EmployeeName) + "</td><td>" + escapeHtml(r.Role) +
        "</td><td>" + escapeHtml(r.Salary) + "</td><td>" + escapeHtml(r.PhoneNumber) + "</td></tr>");
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
  refreshEmployeesList(false);

  document.getElementById("employeeForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    const submitBtn = document.getElementById("submitBtn");
    const statusEl = document.getElementById("formStatus");

    const employeeName = document.getElementById("employeeName").value.trim();
    const role = document.getElementById("role").value.trim();
    const salary = document.getElementById("salary").value;
    const phoneNumber = document.getElementById("phoneNumber").value.trim();
    const address = document.getElementById("address").value.trim();
    const emergencyContact = document.getElementById("emergencyContact").value.trim();

    if (!employeeName || !role || salary === "" || !phoneNumber || !address || !emergencyContact) {
      showFormStatus(statusEl, "Please fill in every field.", true);
      return;
    }

    setButtonBusy(submitBtn, true, "Saving...", "Add Employee");
    try {
      await apiAddRow("EmployeeMaster", {
        EmployeeName: employeeName,
        Role: role,
        Salary: Number(salary),
        PhoneNumber: phoneNumber,
        Address: address,
        EmergencyContactNumber: emergencyContact
      });
      showFormStatus(statusEl, "Employee added.", false);
      document.getElementById("employeeForm").reset();
      refreshEmployeesList(true);
    } catch (err) {
      showFormStatus(statusEl, err.message, true);
    } finally {
      setButtonBusy(submitBtn, false, "Saving...", "Add Employee");
    }
  });
}

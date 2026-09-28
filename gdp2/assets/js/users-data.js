/*
  users-data.js
  ------------------------------------------------------------------
  TEMPORARY. This stands in for the "Users" Google Sheet tab until
  Step 2 (Google Sheets + Apps Script backend) is built.

  Later, this whole file gets deleted and auth.js will instead fetch
  this same shape of data from the Apps Script Web App. Keeping the
  shape identical now means the swap later is a small change, not a
  rewrite.

  allowedTabs uses the same ids as TAB_CONFIG in dashboard.js:
  "master", "milkInput", "procurement", "productsMade", "sales",
  "paymentPending", "orders", "dashboards"
  Owner always gets all tabs regardless of this list.

  Payment Pending and Orders are open to the owner and the supervisor.
  To let an employee use them too, add "paymentPending" and/or "orders"
  to that person's allowedTabs list below.
*/

const APP_USERS = [
  {
    userId: "Pavan",
    password: "owner123",
    name: "Pavan",
    role: "owner",
    allowedTabs: ["master", "milkInput", "procurement", "productsMade", "sales", "paymentPending", "orders", "dashboards"]
  },
  {
    userId: "Poornesh",
    password: "Poornesh123",
    name: "Supervisor Ravi",
    role: "supervisor",
    allowedTabs: ["milkInput", "procurement", "productsMade", "sales", "paymentPending", "orders"]
  },
  {
    userId: "Meena",
    password: "Meena123",
    name: "Employee Lakshmi",
    role: "employee",
    allowedTabs: ["sales"]
  }
];

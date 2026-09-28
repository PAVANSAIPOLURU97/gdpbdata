/*
  dashboard.js
  ------------------------------------------------------------------
  Defines the 8 tabs and renders them as tiles on dashboard.html,
  filtered by the logged-in user's role/allowedTabs.

  To add/remove/rename a tab later: edit TAB_CONFIG here (and add the
  matching page in /pages/). Nothing else needs to change.
  ------------------------------------------------------------------
*/

const TAB_CONFIG = [
  { id: "master",        label: "Master",                     icon: "masterIcon",       page: "pages/master.html",                    colorClass: "tile-master" },
  { id: "milkInput",     label: "Milk Input",                  icon: "milkInputIcon",    page: "pages/milk-input.html",                 colorClass: "tile-milkInput" },
  { id: "procurement",   label: "Raw Material\nProcurement",   icon: "procurementIcon",  page: "pages/rawmaterial-procurement.html",    colorClass: "tile-procurement" },
  { id: "productsMade",  label: "Products Made",                icon: "productsMadeIcon", page: "pages/products-made.html",             colorClass: "tile-productsMade" },
  { id: "sales",         label: "Sales",                        icon: "salesIcon",        page: "pages/sales.html",                      colorClass: "tile-sales" },
  { id: "paymentPending", label: "Payment\nPending",            icon: "paymentPendingIcon", page: "pages/payment-pending.html",          colorClass: "tile-paymentPending" },
  { id: "orders",        label: "Orders",                       icon: "ordersIcon",       page: "pages/orders.html",                     colorClass: "tile-orders" },
  { id: "dashboards",    label: "Dashboards",                   icon: "dashboardsIcon",   page: "pages/dashboards.html",                 colorClass: "tile-dashboards" }
];

function renderTiles(session) {
  const grid = document.getElementById("tileGrid");
  grid.innerHTML = "";

  const visibleTabs = TAB_CONFIG.filter(function (tab) {
    return session.role === "owner" || session.allowedTabs.indexOf(tab.id) !== -1;
  });

  if (visibleTabs.length === 0) {
    grid.innerHTML = '<p class="empty-state">No tabs have been assigned to your account yet.<br>Please contact the owner.</p>';
    return;
  }

  visibleTabs.forEach(function (tab) {
    const btn = document.createElement("button");
    btn.className = "tile " + tab.colorClass;
    btn.type = "button";
    btn.onclick = function () { window.location.href = tab.page; };

    const iconFrame = document.createElement("div");
    iconFrame.className = "tile-icon-frame";
    const img = document.createElement("img");
    img.alt = "";
    iconFrame.appendChild(img);

    const labelSpan = document.createElement("span");
    labelSpan.style.whiteSpace = "pre-line";
    labelSpan.textContent = tab.label;

    btn.appendChild(iconFrame);
    btn.appendChild(labelSpan);
    grid.appendChild(btn);

    setImage(img, tab.icon);
  });
}

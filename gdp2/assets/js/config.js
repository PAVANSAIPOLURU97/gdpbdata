/*
  config.js
  ------------------------------------------------------------------
  This is the ONLY file that should contain image paths.
  Every page reads an image path from IMAGES.<name> instead of
  writing a path directly in HTML. To change any logo/icon in the
  whole app, replace the file in assets/images/ (keeping the same
  file name) OR change the path string below — nothing else needs
  to be touched.
  ------------------------------------------------------------------
*/

const IMAGES = {
  // Brand
  appLogo: "assets/images/logo.png",

  // Tab icons (used on the dashboard tiles)
  masterIcon: "assets/images/icon-master.png",
  milkInputIcon: "assets/images/icon-milk-input.png",
  procurementIcon: "assets/images/icon-procurement.png",
  productsMadeIcon: "assets/images/icon-products-made.png",
  salesIcon: "assets/images/icon-sales.png",
  paymentPendingIcon: "assets/images/icon-payment-pending.png",
  ordersIcon: "assets/images/icon-orders.png",
  dashboardsIcon: "assets/images/icon-dashboards.png",

  // Small utility icons
  userIcon: "assets/images/icon-user.png",
  lockIcon: "assets/images/icon-lock.png",
  logoutIcon: "assets/images/icon-logout.png",

  // Master sub-tab icons
  unitsIcon: "assets/images/icon-units.png",
  milkMasterIcon: "assets/images/icon-milk-master.png",
  rawMaterialsIcon: "assets/images/icon-rawmaterials.png",
  productMasterIcon: "assets/images/icon-product-master.png",
  employeeMasterIcon: "assets/images/icon-employee-master.png"
};

// App-wide constants
const APP_CONFIG = {
  appName: "Pavan's Golden Dairy Products",
  // path pages use to get back to the dashboard / login (kept in one place
  // so folder moves only need updating here)
  dashboardPage: "dashboard.html",
  loginPage: "index.html",

  // -----------------------------------------------------------------
  // PASTE YOUR GOOGLE APPS SCRIPT WEB APP URL HERE (ends in /exec).
  // Follow docs/GOOGLE_SHEETS_SETUP.md to create it. Until this is set,
  // every Master tab will show "Backend not set up yet".
  // -----------------------------------------------------------------
  appsScriptUrl: "https://script.google.com/macros/s/AKfycbwkGv--tKkXwHehZPIB2IHOPQI-oA1O5fzXQGjVxayXtNsjlqrsqPQTu1wsVDunxykC/exec"
};

/*
  Helper: sets an <img> element's src from an IMAGES key, and falls
  back to hiding the image (instead of showing a broken-image icon)
  if the file hasn't been added yet — important since Pavan will be
  adding real logos/icons in later steps.

  IMAGES paths above are written relative to the site's root folder.
  Pages that live inside subfolders (pages/, pages/master/) must define
  a BASE_PATH constant BEFORE this script runs, e.g.:
    root pages (index.html, dashboard.html):   const BASE_PATH = "";
    pages/*.html:                              const BASE_PATH = "../";
    pages/master/*.html:                       const BASE_PATH = "../../";
  This is the ONLY place that folder depth matters for images.
*/
function setImage(imgElement, imagesKey) {
  if (!imgElement) return;
  const path = IMAGES[imagesKey];
  if (!path) return;
  const prefix = (typeof BASE_PATH !== "undefined") ? BASE_PATH : "";
  imgElement.src = prefix + path;
  imgElement.onerror = function () {
    imgElement.style.display = "none";
  };
}

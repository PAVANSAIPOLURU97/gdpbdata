/*
  auth.js
  ------------------------------------------------------------------
  Handles: checking userid/password, keeping the logged-in session,
  guarding pages by role, logging out, and a temporary local audit
  trail (to be replaced by writes to the AuditLog sheet in Step 2).
  ------------------------------------------------------------------
*/

const SESSION_KEY = "pgd_session"; // sessionStorage key — clears when the browser/tab is closed

/*
  -----------------------------------------------------------------
  STEP 2 WILL CHANGE ONLY THIS FUNCTION.
  Right now it checks the local APP_USERS array (users-data.js).
  Later it will instead call the Google Apps Script Web App, e.g.:
    const res = await fetch(APPS_SCRIPT_URL + "?action=login&userId=...&password=...");
    const data = await res.json();
  Everything else in this file (session, guard, logout, audit) stays the same.
  -----------------------------------------------------------------
*/
function findUserRecord(userId, password) {
  return APP_USERS.find(function (u) {
    return u.userId === userId && u.password === password;
  }) || null;
}

// Records an action to a local audit trail (temporary — will POST to the
// AuditLog sheet once the backend exists). Never overwrite past entries.
function logAudit(action, details) {
  const entry = {
    timestamp: new Date().toISOString(),
    userId: (getSession() && getSession().userId) || "unknown",
    action: action,
    details: details || ""
  };
  const existing = JSON.parse(localStorage.getItem("pgd_audit_log") || "[]");
  existing.push(entry);
  localStorage.setItem("pgd_audit_log", JSON.stringify(existing));
}

function getSession() {
  const raw = sessionStorage.getItem(SESSION_KEY);
  return raw ? JSON.parse(raw) : null;
}

function setSession(user) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({
    userId: user.userId,
    name: user.name,
    role: user.role,
    allowedTabs: user.allowedTabs
  }));
}

function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

// Same idea as setImage()'s BASE_PATH handling: page paths in APP_CONFIG
// (loginPage, dashboardPage) are written relative to the site root, so
// any page that isn't at the root must have already set a BASE_PATH
// constant (see config.js for the exact values per folder depth).
function withBasePath(rootRelativePath) {
  const prefix = (typeof BASE_PATH !== "undefined") ? BASE_PATH : "";
  return prefix + rootRelativePath;
}

/*
  Attempts a login. Returns { success: true } or { success: false, message }.
  Called by index.html's login form handler.
*/
function attemptLogin(userId, password) {
  if (!userId || !password) {
    return { success: false, message: "Please enter both User ID and Password." };
  }
  const user = findUserRecord(userId.trim(), password);
  if (!user) {
    logAudit("login_failed", "userId attempted: " + userId);
    return { success: false, message: "User ID or Password is incorrect." };
  }
  setSession(user);
  logAudit("login_success", "");
  return { success: true };
}

function logout() {
  logAudit("logout", "");
  clearSession();
  window.location.href = withBasePath(APP_CONFIG.loginPage);
}

/*
  Page guard: call this at the top of dashboard.html and every page in
  /pages/ (after config.js + auth.js are loaded). Sends the user back to
  login if there's no active session, and (optionally) checks they're
  allowed on this specific tab.
*/
function requireLogin(requiredTabId) {
  const session = getSession();
  if (!session) {
    window.location.href = withBasePath(APP_CONFIG.loginPage);
    return null;
  }
  if (requiredTabId && session.role !== "owner" && session.allowedTabs.indexOf(requiredTabId) === -1) {
    // Logged in, but not allowed on this tab — send back to the dashboard
    window.location.href = withBasePath(APP_CONFIG.dashboardPage);
    return null;
  }
  return session;
}

// Runs before CSS loads to apply the user's saved theme and avoid a flash of
// wrong theme on pages like login and setup. Kept as a standalone file so we
// can drop 'unsafe-inline' from the script CSP.
//
// With nothing saved — a fresh browser, and always the case on the login page
// of a first visit — follow the OS. Matching on "light" keeps dark as the
// fallback for a browser that expresses no preference, which is the default
// Polaris has always had. Nothing is written to localStorage here: an unsaved
// preference is what keeps a user tracking their system, and the in-app theme
// toggle is what opts them out.
(function () {
  var saved = null;
  try { saved = localStorage.getItem("polaris-theme"); } catch (e) {}
  if (!saved) {
    var light = false;
    try { light = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches; } catch (e) {}
    saved = light ? "light" : "dark";
  }
  document.documentElement.setAttribute("data-theme", saved);
})();

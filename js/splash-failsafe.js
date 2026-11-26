// Independent splash failsafe: keep the app from being trapped on the welcome screen
// if a later third-party script or initialization step fails.
(function () {
  function hideREHZO 99Splash() {
    var splash = document.getElementById("splashOverlay");
    if (splash) { splash.style.opacity = "0"; splash.style.pointerEvents = "none"; setTimeout(function () { splash.style.display = "none"; }, 500); }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { setTimeout(hideREHZO 99Splash, 1800); });
  else setTimeout(hideREHZO 99Splash, 1800);
  window.addEventListener("error", function () { setTimeout(hideREHZO 99Splash, 100); }, true);
})();

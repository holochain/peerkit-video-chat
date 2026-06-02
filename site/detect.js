// Progressive enhancement: recognise the visitor's desktop OS and highlight the
// matching download. Without JS, all three platform cards still link to the
// latest release, so nothing is lost.
(function () {
  "use strict";

  var LABELS = { linux: "Linux", mac: "macOS", windows: "Windows" };

  function detectOS() {
    var uaData = navigator.userAgentData;
    var platform = ((uaData && uaData.platform) || navigator.platform || "").toLowerCase();
    var ua = (navigator.userAgent || "").toLowerCase();

    // No desktop installer for mobile — leave the default (no recommendation).
    if (/android|iphone|ipad|ipod/.test(ua)) return null;

    if (platform.indexOf("win") === 0 || ua.indexOf("windows") !== -1) return "windows";
    if (platform.indexOf("mac") === 0 || ua.indexOf("mac os x") !== -1) return "mac";
    if (platform.indexOf("linux") !== -1 || ua.indexOf("linux") !== -1) return "linux";
    return null;
  }

  var os = detectOS();
  if (os === null) return;
  var label = LABELS[os];

  var card = document.querySelector('[data-os="' + os + '"]');
  if (card) {
    card.classList.add("recommended");
    var badge = document.createElement("span");
    badge.className = "recommendation-badge";
    badge.textContent = "Recommended";
    card.insertBefore(badge, card.firstChild);
    // Surface the match first in the grid.
    var grid = document.getElementById("download-grid");
    if (grid) grid.insertBefore(card, grid.firstChild);
  }

  var cta = document.getElementById("download-cta");
  if (cta) cta.textContent = "Download for " + label;

  var recommendation = document.getElementById("recommendation");
  if (recommendation) {
    recommendation.textContent =
      "Detected " + label + " — the recommended download is highlighted below.";
    recommendation.hidden = false;
  }
})();

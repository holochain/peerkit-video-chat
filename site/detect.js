// Progressive enhancement for the download section:
//   1. Recognise the visitor's desktop OS and highlight the matching card.
//   2. Pull the latest release from the GitHub API and wire each card's real
//      installer assets as direct downloads, so the visitor never leaves the
//      page to grab a binary.
// Without JS (or if the API call fails), every card still links to the latest
// release on GitHub, so nothing is lost.
(function () {
  "use strict";

  var REPO = "holochain/peerkit-video-chat";
  var LABELS = { linux: "Linux", mac: "macOS", windows: "Windows" };
  // File extensions each platform ships, in recommended order — the first match
  // is the format we surface first and badge as recommended (the conventional
  // consumer installer: .dmg on macOS, the NSIS .exe on Windows). Also acts as
  // the matcher; ordered longest-first within a platform so ".appimage" wins
  // over a hypothetical ".image".
  var OS_EXTS = {
    linux: [".appimage", ".deb"],
    mac: [".dmg", ".pkg"],
    windows: [".exe", ".msi"],
  };

  // Rank of an asset within its platform's preferred order (lower = preferred);
  // unknown extensions sort last.
  function extRank(os, name) {
    var lower = name.toLowerCase();
    var exts = OS_EXTS[os] || [];
    for (var i = 0; i < exts.length; i++) {
      if (lower.indexOf(exts[i], lower.length - exts[i].length) !== -1) return i;
    }
    return exts.length;
  }

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

  // Which OS owns this asset, by extension. null if it's not an installer.
  function osForAsset(name) {
    var lower = name.toLowerCase();
    for (var os in OS_EXTS) {
      if (!Object.prototype.hasOwnProperty.call(OS_EXTS, os)) continue;
      for (var i = 0; i < OS_EXTS[os].length; i++) {
        if (lower.indexOf(OS_EXTS[os][i], lower.length - OS_EXTS[os][i].length) !== -1) return os;
      }
    }
    return null;
  }

  // A short, human label for a download button: the format plus arch if present.
  function assetLabel(name) {
    var lower = name.toLowerCase();
    var dot = lower.lastIndexOf(".");
    var fmt = dot !== -1 ? name.slice(dot) : name;
    var arch =
      /arm64|aarch64/.test(lower) ? "arm64" :
      /x64|amd64|x86_64/.test(lower) ? "x64" :
      "";
    return arch ? fmt + " · " + arch : fmt;
  }

  // ── 1. Highlight the detected platform ──────────────────────────────────
  var os = detectOS();
  if (os !== null) {
    var label = LABELS[os];
    var card = document.querySelector('[data-os="' + os + '"]');
    if (card) {
      card.classList.add("recommended");
      var badge = document.createElement("span");
      badge.className = "recommendation-badge";
      badge.textContent = "Recommended";
      card.insertBefore(badge, card.firstChild);
      var grid = document.getElementById("download-grid");
      if (grid) grid.insertBefore(card, grid.firstChild); // surface it first
    }
    var cta = document.getElementById("download-cta");
    if (cta) cta.textContent = "Download for " + label;
    var rec = document.getElementById("recommendation");
    if (rec) {
      rec.textContent = "Detected " + label + " — the recommended download is highlighted below.";
      rec.hidden = false;
    }
  }

  // ── 2. Wire direct downloads from the latest release ────────────────────
  if (!window.fetch) return; // very old browser: keep the static fallback links.

  fetch("https://api.github.com/repos/" + REPO + "/releases/latest", {
    headers: { Accept: "application/vnd.github+json" },
  })
    .then(function (res) {
      if (!res.ok) throw new Error("release fetch failed: " + res.status);
      return res.json();
    })
    .then(function (release) {
      var assets = (release && release.assets) || [];
      if (!assets.length) return;

      // Group installer assets by OS.
      var byOS = { linux: [], mac: [], windows: [] };
      assets.forEach(function (a) {
        var assetOS = osForAsset(a.name);
        if (assetOS && byOS[assetOS]) byOS[assetOS].push(a);
      });

      var version = release.tag_name || release.name || "";

      Object.keys(byOS).forEach(function (assetOS) {
        var list = byOS[assetOS];
        if (!list.length) return;
        var dlCard = document.querySelector('.dl-card[data-os="' + assetOS + '"]');
        if (!dlCard) return;
        var box = dlCard.querySelector(".dl-assets");
        var fallback = dlCard.querySelector(".dl-fallback");
        if (!box) return;

        // Lead with the recommended format for the platform.
        list.sort(function (a, b) {
          return extRank(assetOS, a.name) - extRank(assetOS, b.name);
        });

        list.forEach(function (a, i) {
          var link = document.createElement("a");
          link.className = "dl-asset font-mono" + (i === 0 ? " dl-asset--primary" : "");
          link.href = a.browser_download_url;
          link.rel = "noopener";
          link.setAttribute("download", ""); // download in place, don't navigate
          link.textContent = assetLabel(a.name);
          box.appendChild(link);
        });

        box.hidden = false;
        if (fallback) {
          fallback.textContent = version
            ? "All " + version + " files →"
            : "All release files →";
        }
      });
    })
    .catch(function () {
      // Network/API failure — the static "Latest release" links remain.
    });
})();

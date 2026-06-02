// Progressive enhancement for the download section:
//   1. Recognise the visitor's desktop OS, highlight the matching card in place,
//      and point the hero CTA straight at the recommended installer.
//   2. Pull the latest release from the GitHub API and wire each card's real
//      installer assets as direct downloads, so the visitor never leaves the
//      page to grab a binary.
//   3. Best-effort CPU-architecture check: warn when the only build for the
//      detected OS is for a different architecture (e.g. an Intel Mac visitor
//      offered an Apple-Silicon-only build).
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
  // over a hypothetical ".image". (.pkg lingers below .dmg only to keep older,
  // pre-.dmg releases downloadable; it falls away once a .dmg release is latest.)
  var OS_EXTS = {
    linux: [".appimage", ".deb"],
    mac: [".dmg", ".pkg"],
    windows: [".exe", ".msi"],
  };

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

  // Best-effort CPU architecture: "arm64" | "x64" | null (unknown). Only
  // Chromium exposes this (high-entropy UA hints); Safari/Firefox return null,
  // in which case we simply skip the arch-mismatch warning.
  function detectArch() {
    var uaData = navigator.userAgentData;
    if (!uaData || !uaData.getHighEntropyValues) return Promise.resolve(null);
    return uaData
      .getHighEntropyValues(["architecture", "bitness"])
      .then(function (h) {
        var a = (h.architecture || "").toLowerCase();
        if (a === "arm") return "arm64";
        if (a === "x86" && h.bitness === "64") return "x64";
        return null;
      })
      .catch(function () {
        return null;
      });
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

  // CPU architecture an asset targets, parsed from its filename. null if absent.
  function archOf(name) {
    var lower = name.toLowerCase();
    if (/arm64|aarch64/.test(lower)) return "arm64";
    if (/x64|amd64|x86_64/.test(lower)) return "x64";
    return null;
  }

  // A short, human label for a download button: the format plus arch if present.
  function assetLabel(name) {
    var lower = name.toLowerCase();
    var dot = lower.lastIndexOf(".");
    var fmt = dot !== -1 ? name.slice(dot) : name;
    var arch = archOf(name);
    return arch ? fmt + " · " + arch : fmt;
  }

  // ── 1. Highlight the detected platform (in place — no grid reordering) ───
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
    }
    var rec = document.getElementById("recommendation");
    if (rec) {
      rec.textContent = "Detected " + label + " — the recommended download is highlighted below.";
      rec.hidden = false;
    }
  }

  // ── 2. + 3. Wire direct downloads (and the CTA / arch warning) ──────────
  if (!window.fetch) return; // very old browser: keep the static fallback links.

  Promise.all([
    fetch("https://api.github.com/repos/" + REPO + "/releases/latest", {
      headers: { Accept: "application/vnd.github+json" },
    }).then(function (res) {
      if (!res.ok) throw new Error("release fetch failed: " + res.status);
      return res.json();
    }),
    detectArch(),
  ])
    .then(function (results) {
      var release = results[0];
      var arch = results[1];
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

        var isRecommendedOS = assetOS === os;

        list.forEach(function (a, i) {
          var link = document.createElement("a");
          // The solid-accent primary button marks the lead format, but only on
          // the visitor's own platform — other cards stay plain.
          link.className =
            "dl-asset font-mono" + (isRecommendedOS && i === 0 ? " dl-asset--primary" : "");
          link.href = a.browser_download_url;
          link.rel = "noopener";
          link.setAttribute("download", ""); // download in place, don't navigate
          link.textContent = assetLabel(a.name);
          box.appendChild(link);
        });

        box.hidden = false;
        if (fallback) {
          fallback.textContent = version ? "All " + version + " files →" : "All release files →";
        }

        if (!isRecommendedOS) return;

        // Point the hero CTA straight at the recommended installer — prefer one
        // matching the visitor's architecture, else the lead format.
        var ctaAsset = null;
        if (arch) {
          for (var i = 0; i < list.length; i++) {
            if (archOf(list[i].name) === arch) {
              ctaAsset = list[i];
              break;
            }
          }
        }
        if (!ctaAsset) ctaAsset = list[0];

        var cta = document.getElementById("download-cta");
        if (cta) {
          cta.href = ctaAsset.browser_download_url;
          cta.setAttribute("download", "");
          cta.textContent = "Download for " + label;
        }

        // Arch mismatch: we know the visitor's arch, but no build matches it.
        var buildArch = archOf(ctaAsset.name);
        if (arch && buildArch && arch !== buildArch && rec) {
          rec.textContent =
            "Heads up: the " + label + " build is " + buildArch + " only — there's no " + arch + " build yet.";
        }
      });
    })
    .catch(function () {
      // Network/API failure — the static "Latest release" links remain.
    });
})();

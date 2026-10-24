/* TimestampBubbles — popup settings */
(() => {
  "use strict";

  const DEFAULTS = {
    enabled: true,
    showDots: true,
    staySeconds: 6,
    windowSec: 15,
    maxBubbles: 3,
    scale: 1,
    opacity: 1,
    accent: "#ff5b5b",
  };

  const ACCENTS = [
    "#ff5b5b", // red
    "#ffb44d", // amber
    "#4dd07a", // green
    "#55b9ff", // blue
    "#c58cff", // purple
  ];

  const els = {
    enabled: document.getElementById("enabled"),
    showDots: document.getElementById("showDots"),
    stay: document.getElementById("stay"),
    stayValue: document.getElementById("stayValue"),
    window: document.getElementById("window"),
    windowValue: document.getElementById("windowValue"),
    scale: document.getElementById("scale"),
    scaleValue: document.getElementById("scaleValue"),
    opacity: document.getElementById("opacity"),
    opacityValue: document.getElementById("opacityValue"),
    swatches: document.getElementById("swatches"),
    maxBubbles: document.getElementById("maxBubbles"),
    reset: document.getElementById("reset"),
  };

  let settings = { ...DEFAULTS };

  function save() {
    try {
      chrome.storage.local.set({ settings });
    } catch {}
  }

  function render() {
    const root = document.documentElement;
    root.style.setProperty("--accent", settings.accent);

    els.enabled.checked = settings.enabled;
    els.showDots.checked = settings.showDots;
    els.stay.value = settings.staySeconds;
    els.stayValue.textContent = settings.staySeconds + "s";
    els.window.value = settings.windowSec;
    els.windowValue.textContent = "\u00B1" + settings.windowSec + "s";
    els.scale.value = settings.scale;
    els.scaleValue.textContent = Math.round(settings.scale * 100) + "%";
    els.opacity.value = settings.opacity;
    els.opacityValue.textContent = Math.round(settings.opacity * 100) + "%";

    [...els.swatches.children].forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.color === settings.accent);
    });
    [...els.maxBubbles.children].forEach((btn) => {
      btn.classList.toggle(
        "active",
        Number(btn.dataset.n) === settings.maxBubbles,
      );
    });
  }

  // Build swatches and max-bubbles stepper once.
  ACCENTS.forEach((color) => {
    const btn = document.createElement("button");
    btn.className = "swatch";
    btn.dataset.color = color;
    btn.style.background = color;
    btn.title = color;
    btn.addEventListener("click", () => {
      settings.accent = color;
      render();
      save();
    });
    els.swatches.appendChild(btn);
  });
  for (let n = 1; n <= 5; n++) {
    const btn = document.createElement("button");
    btn.dataset.n = String(n);
    btn.textContent = String(n);
    btn.addEventListener("click", () => {
      settings.maxBubbles = n;
      render();
      save();
    });
    els.maxBubbles.appendChild(btn);
  }

  els.enabled.addEventListener("change", () => {
    settings.enabled = els.enabled.checked;
    render();
    save();
  });
  els.showDots.addEventListener("change", () => {
    settings.showDots = els.showDots.checked;
    render();
    save();
  });
  els.stay.addEventListener("input", () => {
    settings.staySeconds = Number(els.stay.value);
    render();
    save();
  });
  els.window.addEventListener("input", () => {
    settings.windowSec = Number(els.window.value);
    render();
    save();
  });
  els.scale.addEventListener("input", () => {
    settings.scale = Number(els.scale.value);
    render();
    save();
  });
  els.opacity.addEventListener("input", () => {
    settings.opacity = Number(els.opacity.value);
    render();
    save();
  });
  els.reset.addEventListener("click", () => {
    settings = { ...DEFAULTS };
    render();
    save();
  });

  // Live-update if the content script or another popup changes settings.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.settings) return;
      settings = { ...DEFAULTS, ...(changes.settings.newValue || {}) };
      render();
    });
  } catch {}

  chrome.storage.local.get({ settings: null, enabled: true }, (res) => {
    const stored = res.settings || {};
    settings = { ...DEFAULTS, ...stored };
    if (stored.enabled === undefined && res.enabled === false) {
      settings.enabled = false; // legacy v1.0 key
    }
    render();
  });
})();

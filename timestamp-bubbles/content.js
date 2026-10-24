/* TimestampBubbles — content script
 * Shows floating comment bubbles on YouTube videos when the playhead is near
 * a comment's timestamp (±windowSec). Bubbles appear one after another with a
 * smooth slide-up, each stays for `staySeconds`, then slides back down.
 * Clicking a bubble scrolls to that comment so you can like or reply.
 * Appearance and timing are configurable from the popup (chrome.storage). */
(() => {
  "use strict";

  const DEFAULTS = {
    enabled: true,
    showDots: true, // show one dot per timestamped comment on the progress bar
    staySeconds: 6, // how long each bubble stays on screen
    windowSec: 15, // comments within ±N seconds of the playhead qualify
    maxBubbles: 3, // max bubbles visible at once
    scale: 1, // bubble size multiplier
    opacity: 1, // bubble background opacity
    accent: "#ff5b5b", // accent color (time text, hover, highlight)
  };

  const SPAWN_STAGGER_MS = 400; // delay between sequential bubble entrances
  const EXIT_MS = 320; // matches the CSS leave animation
  const HIGHLIGHT_MS = 3500;

  let settings = { ...DEFAULTS };
  let videoId = null;
  let comments = new Map(); // lcId -> { lc, seconds, author, snippet }
  let bubbles = new Map(); // lcId -> { el, timers: [] }
  let shownOnce = new Set(); // lcIds already shown during this window entry
  let pendingSpawns = new Set(); // scheduled spawn timeouts
  let container = null;
  let toggleBtn = null;
  let dotsContainer = null; // overlay on the progress bar holding the dots
  let dotsBar = null; // the progress bar the dots are attached to
  let lastDotsKey = ""; // rebuild dots only when this changes
  let userScrolled = false;
  let autoLoadState = "idle"; // idle | waiting | running | done
  let scanScheduled = false;
  let tickTimer = null;

  /* ---------- utils ---------- */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function parseSeconds(raw) {
    if (!raw) return null;
    let v;
    try {
      v = decodeURIComponent(raw);
    } catch {
      v = raw;
    }
    const m = v.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) {
      const n = parseInt(v, 10);
      return Number.isFinite(n) && n >= 0 ? n : null;
    }
    const total = (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
    return total > 0 ? total : null;
  }

  function formatTime(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      : `${m}:${String(s).padStart(2, "0")}`;
  }

  function getVideo() {
    return $("video.html5-main-video") || $("video");
  }

  function getVideoId() {
    try {
      return new URLSearchParams(location.search).get("v");
    } catch {
      return null;
    }
  }

  function isWatchPage() {
    return location.pathname === "/watch" && getVideoId() !== null;
  }

  /* ---------- settings ---------- */

  function applySettings() {
    const root = document.documentElement;
    root.style.setProperty("--tb-scale", String(settings.scale));
    root.style.setProperty("--tb-opacity", String(settings.opacity));
    root.style.setProperty("--tb-accent", settings.accent);
    syncUI();
  }

  function loadSettings() {
    try {
      chrome.storage.local.get({ settings: null, enabled: true }, (res) => {
        if (chrome.runtime.lastError) return;
        const stored = res.settings || {};
        const merged = { ...DEFAULTS, ...stored };
        // Legacy key from v1.0 (enabled was stored on its own).
        if (stored.enabled === undefined && res.enabled === false) {
          merged.enabled = false;
        }
        settings = merged;
        applySettings();
      });
    } catch {}
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.settings) return;
      settings = { ...DEFAULTS, ...(changes.settings.newValue || {}) };
      applySettings();
      lastDotsKey = "";
      if (!settings.enabled) {
        cancelSpawns();
        clearBubbles();
      }
    });
  } catch {}

  /* ---------- comment scanning ---------- */

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      scanComments();
      updateToggleCount();
    });
  }

  function scanComments() {
    $$("ytd-comment-thread-renderer").forEach(parseThread);
  }

  /* Comment text with emojis: YouTube renders emojis as <img> tags, so
   * textContent alone drops them — walk the nodes and use each img's alt. */
  function extractText(el) {
    const parts = [];
    const walk = (node) => {
      node.childNodes.forEach((n) => {
        if (n.nodeType === Node.TEXT_NODE) parts.push(n.textContent);
        else if (n.nodeType === Node.ELEMENT_NODE) {
          if (n.tagName === "IMG") {
            const e = (n.alt || n.title || "").trim();
            if (e) parts.push(` ${e} `);
          } else walk(n);
        }
      });
    };
    walk(el);
    return parts.join("").replace(/\s+/g, " ").trim();
  }

  function parseThread(thread) {
    if (!thread || thread.__tbParsed) return;
    thread.__tbParsed = true;

    const timeA =
      $('#published-time-text a[href*="lc="]', thread) ||
      $('a[href*="lc="]', thread);
    const lcMatch = timeA && timeA.href.match(/[?&]lc=([^&]+)/);
    if (!lcMatch) return;
    const lc = lcMatch[1];

    const authorEl = $("#author-text", thread);
    const contentEl = $("#content-text", thread);
    const author = authorEl ? authorEl.textContent.trim() : "";

    let seconds = null;
    if (contentEl) {
      $$('a[href*="t="]', contentEl).forEach((a) => {
        const m = a.href.match(/[?&]t=([^&]+)/);
        const sec = m && parseSeconds(m[1]);
        if (sec != null && seconds == null) seconds = sec;
      });
    }
    if (seconds == null) return;

    const snippet = contentEl ? extractText(contentEl).slice(0, 160) : "";

    comments.set(lc, {
      lc,
      seconds,
      author: author || "A viewer",
      snippet,
    });
    lastDotsKey = ""; // new comment — dots need a rebuild
  }

  /* ---------- smooth stack shifting (FLIP) ---------- */

  /* Layout changes (append/remove) are instant; this records each bubble's
   * position before the change and animates it to its new spot afterwards,
   * so the stack glides up/down instead of jumping. */
  function withShift(mutate) {
    if (!container) {
      mutate();
      return;
    }
    const tops = new Map();
    bubbles.forEach((b) => {
      if (b.el.isConnected) tops.set(b.el, b.el.getBoundingClientRect().top);
    });
    mutate();
    bubbles.forEach((b) => {
      const el = b.el;
      if (!el.isConnected || !tops.has(el)) return;
      const dy = tops.get(el) - el.getBoundingClientRect().top;
      if (!dy) return;
      el.style.transition = "none";
      el.style.transform = `translateY(${dy}px)`;
      requestAnimationFrame(() => {
        el.style.transition =
          "transform 0.3s cubic-bezier(0.25, 0.8, 0.3, 1)";
        el.style.transform = "";
        setTimeout(() => {
          el.style.transition = "";
        }, EXIT_MS);
      });
    });
  }

  /* ---------- on-video UI ---------- */

  function ensureUI() {
    const player = $("#movie_player");
    if (!player) return false;

    if (!container || !container.isConnected) {
      container = document.createElement("div");
      container.className = "tb-bubbles";
      player.appendChild(container);
      applySettings();
    }
    if (!toggleBtn || !toggleBtn.isConnected) {
      toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.className = "tb-toggle";
      toggleBtn.title = "TimestampBubbles — click to show/hide comment bubbles (settings: extension icon in the toolbar)";
      toggleBtn.addEventListener("click", () => {
        settings.enabled = !settings.enabled;
        try {
          chrome.storage.local.set({ settings });
        } catch {}
        if (!settings.enabled) {
          cancelSpawns();
          clearBubbles();
        }
        syncUI();
      });
      player.appendChild(toggleBtn);
    }
    return true;
  }

  function updateToggleCount() {
    if (!toggleBtn) return;
    const count = comments.size;
    toggleBtn.textContent = "\u23F1 " + count;
    toggleBtn.classList.toggle("tb-hidden", count === 0 || !isWatchPage());
  }

  function syncUI() {
    updateToggleCount();
    if (!toggleBtn) return;
    toggleBtn.classList.toggle("tb-off", !settings.enabled);
    if (container) {
      container.classList.toggle(
        "tb-hidden",
        !settings.enabled || !isWatchPage(),
      );
    }
  }

  /* ---------- sequential bubble queue ---------- */

  function updateBubbles() {
    if (!ensureUI()) return;
    if (!settings.enabled || !isWatchPage()) {
      cancelSpawns();
      clearBubbles();
      syncUI();
      return;
    }

    const video = getVideo();
    const t = video ? video.currentTime : null;
    if (t == null) return;

    // Which comments are near the playhead right now?
    const inWindow = [];
    comments.forEach((c) => {
      if (Math.abs(c.seconds - t) <= settings.windowSec) inWindow.push(c);
      else shownOnce.delete(c.lc); // left the window — can show again on re-entry
    });

    // Queue comments that qualify but aren't on screen yet; each enters
    // sequentially with a stagger so they don't all pop at once.
    let staggerIndex = 0;
    inWindow.forEach((c) => {
      if (bubbles.has(c.lc) || shownOnce.has(c.lc)) return;
      const delay = staggerIndex * SPAWN_STAGGER_MS;
      staggerIndex++;
      scheduleSpawn(c, delay);
    });
  }

  function scheduleSpawn(c, delay) {
    shownOnce.add(c.lc);
    if (delay <= 0) {
      spawnNow(c);
      return;
    }
    const id = setTimeout(() => {
      pendingSpawns.delete(id);
      spawnNow(c);
    }, delay);
    pendingSpawns.add(id);
  }

  function spawnNow(c) {
    if (!settings.enabled || !isWatchPage() || bubbles.has(c.lc)) return;
    if (bubbles.size >= settings.maxBubbles) {
      // No free slot — requeue for a later tick.
      shownOnce.delete(c.lc);
      return;
    }

    const el = document.createElement("div");
    el.className = "tb-bubble";
    el.setAttribute("role", "button");
    el.title = "Jump to this comment";

    const line = document.createElement("div");
    line.className = "tb-line";
    const time = document.createElement("span");
    time.className = "tb-time";
    time.textContent = formatTime(c.seconds);
    const author = document.createElement("span");
    author.className = "tb-author";
    author.textContent = c.author;
    line.append(time, author);

    const text = document.createElement("span");
    text.className = "tb-text";
    text.textContent = c.snippet || "Jump to this comment";

    el.append(line, text);
    el.addEventListener("click", () => goToComment(c.lc));

    withShift(() => container.appendChild(el));
    requestAnimationFrame(() => el.classList.add("tb-show"));

    const record = { el, timers: [] };
    bubbles.set(c.lc, record);

    // Stay for the configured time, then glide back down.
    record.timers.push(
      setTimeout(() => exitBubble(c.lc), settings.staySeconds * 1000),
    );
  }

  function exitBubble(lc) {
    const b = bubbles.get(lc);
    if (!b) return;
    bubbles.delete(lc);
    b.timers.forEach(clearTimeout);
    b.el.classList.add("tb-leave");
    setTimeout(() => {
      withShift(() => b.el.remove());
    }, EXIT_MS);
  }

  function cancelSpawns() {
    pendingSpawns.forEach(clearTimeout);
    pendingSpawns.clear();
  }

  function clearBubbles() {
    if (!container) return;
    cancelSpawns();
    bubbles.forEach((b) => {
      b.timers.forEach(clearTimeout);
      b.el.classList.add("tb-leave");
      setTimeout(() => {
        withShift(() => b.el.remove());
      }, EXIT_MS);
    });
    bubbles.clear();
    shownOnce.clear();
  }

  /* ---------- jumping to comments ---------- */

  function goToComment(lc) {
    if (!lc) return;
    const anchors = $$('#published-time-text a[href*="lc="]');
    for (const a of anchors) {
      let href = a.href;
      try {
        href = decodeURIComponent(href);
      } catch {}
      if (href.includes("lc=" + lc)) {
        const thread = a.closest("ytd-comment-thread-renderer");
        if (thread) {
          revealThread(thread);
          return;
        }
      }
    }
    // Comment not rendered yet — use YouTube's own deep link, which opens the
    // page scrolled to and highlighting that comment.
    try {
      const url = new URL(location.href);
      url.searchParams.set("v", getVideoId());
      url.searchParams.set("lc", lc);
      location.href = url.toString();
    } catch {}
  }

  function revealThread(thread) {
    const expand = $("#expand", thread) || $("#more", thread);
    if (expand && expand.offsetParent !== null) {
      try {
        expand.click();
      } catch {}
    }
    thread.scrollIntoView({ behavior: "smooth", block: "center" });
    thread.classList.add("tb-highlight");
    clearTimeout(revealThread._t);
    revealThread._t = setTimeout(
      () => thread.classList.remove("tb-highlight"),
      HIGHLIGHT_MS,
    );
  }

  /* ---------- progress-bar dots (one per timestamped comment) ---------- */

  function removeDots() {
    if (dotsContainer && dotsContainer.isConnected) dotsContainer.remove();
    dotsContainer = null;
    dotsBar = null;
    lastDotsKey = "";
  }

  function renderDots() {
    const video = getVideo();
    const dur = video && video.duration;
    if (!settings.enabled || !settings.showDots || !isWatchPage()) {
      removeDots();
      return;
    }
    const bar = $("#movie_player .ytp-progress-bar");
    if (!bar || !dur || !Number.isFinite(dur) || dur <= 0) {
      removeDots();
      return;
    }

    // Rebuild only when something visible actually changed.
    const key = [
      comments.size,
      Math.round(dur),
      settings.accent,
      bar === dotsBar,
    ].join("|");
    if (key === lastDotsKey && dotsContainer && dotsContainer.isConnected) {
      return;
    }
    lastDotsKey = key;

    if (!dotsContainer || !dotsContainer.isConnected || dotsBar !== bar) {
      if (dotsContainer) dotsContainer.remove();
      dotsContainer = document.createElement("div");
      dotsContainer.className = "tb-dots";
      dotsBar = bar;
      bar.appendChild(dotsContainer);
    }
    dotsContainer.replaceChildren();

    comments.forEach((c) => {
      const pct = Math.min(100, Math.max(0, (c.seconds / dur) * 100));
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "tb-dot";
      dot.style.left = pct + "%";
      dot.title = `${formatTime(c.seconds)} · ${c.author}${
        c.snippet ? " — " + c.snippet : ""
      }`;
      dot.setAttribute(
        "aria-label",
        `Jump to ${formatTime(c.seconds)} where ${c.author} commented`,
      );
      dot.addEventListener("click", (e) => {
        e.stopPropagation(); // don't let the bar's own seek handler win
        const v = getVideo();
        if (v) {
          v.currentTime = c.seconds;
          if (v.paused) v.play().catch(() => {});
        }
      });
      dotsContainer.appendChild(dot);
    });
  }

  /* ---------- auto-load comments (so bubbles cover the whole video) ---------- */

  function startAutoLoad() {
    if (autoLoadState !== "idle") return;
    autoLoadState = "waiting";
    let tries = 0;
    const first = setInterval(() => {
      tries++;
      if (!isWatchPage()) {
        clearInterval(first);
        autoLoadState = "idle";
        return;
      }
      if ($$("ytd-comment-thread-renderer").length > 0) {
        clearInterval(first);
        runScrollLoad();
      } else if (tries > 24) {
        // Comments are off or very slow — give up quietly.
        clearInterval(first);
        autoLoadState = "done";
      }
    }, 500);
  }

  function runScrollLoad() {
    autoLoadState = "running";
    const startY = window.scrollY;
    let last = -1;
    let stable = 0;
    let steps = 0;
    const tick = () => {
      if (userScrolled || !isWatchPage()) {
        autoLoadState = "done";
        return;
      }
      steps++;
      window.scrollTo(0, document.documentElement.scrollHeight);
      setTimeout(() => {
        if (userScrolled || !isWatchPage()) {
          autoLoadState = "done";
          return;
        }
        const n = $$("ytd-comment-thread-renderer").length;
        if (n === last) stable++;
        else stable = 0;
        last = n;
        if (stable >= 5 || steps > 80) {
          autoLoadState = "done";
          window.scrollTo(0, startY);
          return;
        }
        tick();
      }, 550);
    };
    tick();
  }

  /* ---------- lifecycle ---------- */

  function onTick() {
    if (getVideoId() !== videoId) {
      onNavigate();
      return;
    }
    updateBubbles();
    renderDots();
  }

  function startTick() {
    clearInterval(tickTimer);
    tickTimer = setInterval(onTick, 400);
  }

  function onNavigate() {
    const vid = getVideoId();
    if (vid === videoId) return;
    videoId = vid;
    comments.clear();
    removeDots();
    clearBubbles();
    userScrolled = false;
    autoLoadState = "idle";
    if (isWatchPage()) {
      scheduleScan();
      startAutoLoad();
      startTick();
    } else {
      clearInterval(tickTimer);
    }
    syncUI();
  }

  document.addEventListener("yt-navigate-finish", onNavigate);
  document.addEventListener("yt-page-data-updated", scheduleScan);

  const markUserScroll = () => {
    userScrolled = true;
  };
  window.addEventListener("wheel", markUserScroll, { passive: true });
  window.addEventListener("touchmove", markUserScroll, { passive: true });

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.body, { childList: true, subtree: true });

  loadSettings();

  videoId = getVideoId();
  if (isWatchPage()) {
    scheduleScan();
    startAutoLoad();
    startTick();
  }
})();

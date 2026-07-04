// ============================================================
//  Quotes — client-side app logic
//  Two storage backends behind one interface:
//    • CloudStore  → Firebase Firestore (per-user, syncs everywhere,
//                    with offline cache for low-internet).
//    • LocalStore  → this device only (browser localStorage), works with
//                    NO login and NO Firebase setup at all.
//  The app falls back to LocalStore whenever the cloud isn't available
//  (not configured, offline at first run, or not signed in). On sign-in
//  it offers to move any local quotes into the account.
// ============================================================

import { firebaseConfig } from "./firebase-config.js";

// Firebase is loaded ONLY when it's actually configured (dynamic import).
// That means the whole app — including full local-only mode — works with zero
// external requests: offline, opened straight from disk, and before you ever
// deploy or add Firebase keys.
const FB_BASE = "https://www.gstatic.com/firebasejs/10.12.5/";
let initializeApp;
let getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged;
let initializeFirestore, persistentLocalCache, persistentMultipleTabManager;
let collection, addDoc, deleteDoc, doc, query, orderBy, onSnapshot, serverTimestamp;

async function loadFirebase() {
  const [appMod, authMod, fsMod] = await Promise.all([
    import(FB_BASE + "firebase-app.js"),
    import(FB_BASE + "firebase-auth.js"),
    import(FB_BASE + "firebase-firestore.js"),
  ]);
  ({ initializeApp } = appMod);
  ({ getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } = authMod);
  ({
    initializeFirestore,
    persistentLocalCache,
    persistentMultipleTabManager,
    collection,
    addDoc,
    deleteDoc,
    doc,
    query,
    orderBy,
    onSnapshot,
    serverTimestamp,
  } = fsMod);
}

// ---- The 5 tags (edit here to rename them; nothing else to change) ----
const TAGS = [
  "extraterrestrial",
  "try to read this everyday",
  "very important",
  "pretty important",
  "interesting",
];
const DEFAULT_TAG = "interesting";
const PAGE_SIZE = 50; // how many quote cards to add to the DOM at a time
const LOCAL_KEY = "quotes_local_v1"; // localStorage key for device-only quotes

// ---- Tiny DOM helpers ----
const $ = (id) => document.getElementById(id);
const show = (el) => el && (el.hidden = false);
const hide = (el) => el && (el.hidden = true);

// ---- App state ----
let auth = null;
let db = null;
let firebaseReady = false; // true only when config is filled in AND init succeeded
let currentStore = null; // active backend (cloud or local)
let currentMode = null; // "cloud" | "local" | null(login)
let loading = false; // waiting for first cloud snapshot
let allQuotes = []; // full list from the active store (newest first)
let filtered = []; // after search + tag filter
let renderCount = PAGE_SIZE; // target number of cards to show
let domShown = 0; // number of cards currently in the DOM
let searchTerm = "";
let sortOrder = "desc"; // "desc" = newest, "asc" = oldest, "tag" = grouped by tag

const localStore = makeLocalStore(); // the single device-local backend

// ------------------------------------------------------------
//  Boot
// ------------------------------------------------------------
async function boot() {
  wireThemeToggle();
  populateTagInputs();
  wireAppUI();
  wireAuthButtons();

  firebaseReady = false;
  if (isConfigured()) {
    try {
      await loadFirebase();
      const app = initializeApp(firebaseConfig);
      auth = getAuth(app);
      // Offline persistence: cloud quotes are cached in IndexedDB so reloads
      // are instant and it keeps working with little/no internet.
      db = initializeFirestore(app, {
        localCache: persistentLocalCache({
          tabManager: persistentMultipleTabManager(),
        }),
      });
      firebaseReady = true;
    } catch (err) {
      console.error("Firebase init failed, using local mode:", err);
      firebaseReady = false;
    }
  }

  if (firebaseReady) {
    onAuthStateChanged(auth, async (user) => {
      if (user) {
        await maybeMigrateLocal(user);
        enterCloudMode(user);
      } else {
        enterLogin();
      }
    });
  } else {
    // No database configured (or init failed) → device-only mode, works now.
    enterLocalMode();
  }
}

function isConfigured() {
  const k = firebaseConfig && firebaseConfig.apiKey;
  return Boolean(k) && !String(k).includes("YOUR_") && !String(k).includes("PASTE_");
}

// ------------------------------------------------------------
//  Storage backends (one interface: start / stop / add / remove)
// ------------------------------------------------------------
function userQuotesCol(uid) {
  // Per-user subcollection => strong isolation + no composite index needed.
  return collection(db, "users", uid, "quotes");
}

function makeCloudStore(uid) {
  let unsub = null;
  return {
    mode: "cloud",
    start(onData) {
      const q = query(userQuotesCol(uid), orderBy("createdAt", "desc"));
      unsub = onSnapshot(
        q,
        (snap) => {
          const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
          onData(items, { fromCache: snap.metadata.fromCache, local: false });
        },
        (err) => {
          console.error("Firestore error:", err);
          showToast(
            "Couldn't load your quotes. Check your connection, or that the Firestore security rules are published.",
            { type: "error", duration: 7000 }
          );
          onData(allQuotes, { fromCache: true, local: false, error: true });
        }
      );
    },
    stop() {
      if (unsub) { unsub(); unsub = null; }
    },
    async add(q) {
      // Preserve an existing timestamp (used when migrating / undoing);
      // otherwise stamp it on the server.
      const createdAt = q.createdAt != null ? new Date(q.createdAt) : serverTimestamp();
      await addDoc(userQuotesCol(uid), {
        text: q.text,
        source: q.source || "",
        tag: TAGS.includes(q.tag) ? q.tag : DEFAULT_TAG,
        createdAt,
      });
    },
    async remove(id) {
      await deleteDoc(doc(db, "users", uid, "quotes", id));
    },
  };
}

function makeLocalStore() {
  let items = load();
  let cb = null;

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(LOCAL_KEY)) || [];
      return raw.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    } catch (e) {
      return [];
    }
  }
  function save() {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(items));
    } catch (e) {
      console.error("Could not save locally:", e);
    }
  }
  function emit() {
    if (cb) cb(items.slice(), { fromCache: true, local: true });
  }

  return {
    mode: "local",
    start(onData) {
      cb = onData;
      emit();
    },
    stop() {
      cb = null;
    },
    async add(q) {
      items.unshift({
        id: genId(),
        text: q.text,
        source: q.source || "",
        tag: TAGS.includes(q.tag) ? q.tag : DEFAULT_TAG,
        createdAt: q.createdAt != null ? Number(q.createdAt) : Date.now(),
      });
      save();
      emit();
    },
    async remove(id) {
      items = items.filter((x) => x.id !== id);
      save();
      emit();
    },
    getAll() {
      return items.slice();
    },
    clear() {
      items = [];
      save();
      emit();
    },
  };
}

// Move device-local quotes into the signed-in account (one-time offer).
async function maybeMigrateLocal(user) {
  const local = localStore.getAll();
  if (!local.length) return;
  const ok = confirm(
    "You have " +
      local.length +
      " item(s) saved on this device.\n\nMove them into your account so they sync across devices?"
  );
  if (!ok) return;

  const cloud = makeCloudStore(user.uid);
  try {
    const ordered = local
      .slice()
      .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
    for (const q of ordered) await cloud.add(q);
    localStore.clear();
    showToast("Moved " + ordered.length + " item(s) into your account");
  } catch (err) {
    console.error(err);
    showToast("Couldn't move all local quotes — they're still safe on this device.", {
      type: "error",
    });
  }
}

// ------------------------------------------------------------
//  View switching
// ------------------------------------------------------------
function enterLogin() {
  hide($("bootLoading"));
  stopStore();
  allQuotes = [];
  filtered = [];
  loading = false;
  currentMode = null;
  hide($("appView"));
  hide($("topbar"));
  hide($("setupView"));
  show($("loginView"));
}

function enterLocalMode() {
  hide($("bootLoading"));
  stopStore();
  currentMode = "local";
  currentStore = localStore;
  loading = false;
  renderCount = PAGE_SIZE;

  hide($("loginView"));
  hide($("setupView"));
  show($("topbar"));
  show($("appView"));

  hide($("userChip"));
  show($("localChip"));
  show($("syncBtn")); // always offer Google sign-in, even before deploying

  if (firebaseReady) hide($("localNote"));
  else show($("localNote"));

  currentStore.start(onData);
}

function enterCloudMode(user) {
  hide($("bootLoading"));
  stopStore();
  currentMode = "cloud";
  currentStore = makeCloudStore(user.uid);

  hide($("loginView"));
  hide($("setupView"));
  hide($("localChip"));
  hide($("syncBtn"));
  hide($("localNote"));
  show($("topbar"));
  show($("appView"));

  $("userName").textContent = user.displayName || user.email || "Signed in";
  if (user.photoURL) {
    $("userPhoto").src = user.photoURL;
    $("userPhoto").style.display = "";
  } else {
    $("userPhoto").style.display = "none";
  }
  show($("userChip"));

  // Show skeletons until the first snapshot arrives (usually instant thanks
  // to the offline cache; only the very first load may take a moment).
  allQuotes = [];
  filtered = [];
  loading = true;
  renderCount = PAGE_SIZE;
  render();

  currentStore.start(onData);
}

function stopStore() {
  if (currentStore) currentStore.stop();
}

// Called by whichever store is active whenever data changes.
function onData(items, meta) {
  loading = false;
  allQuotes = items;
  const badge = $("offlineBadge");
  if (meta && meta.local) {
    badge.textContent = "saved on this device";
    show(badge);
  } else if (meta && meta.fromCache && !navigator.onLine) {
    badge.textContent = "offline · showing saved copy";
    show(badge);
  } else {
    hide(badge);
  }
  applyFilter();
}

// ------------------------------------------------------------
//  Auth buttons
// ------------------------------------------------------------
function wireAuthButtons() {
  $("googleBtn").addEventListener("click", googleSignIn);
  $("syncBtn").addEventListener("click", googleSignIn);
  $("localBtn").addEventListener("click", enterLocalMode);
  $("signOutBtn").addEventListener("click", () => {
    if (auth) signOut(auth);
  });
}

async function googleSignIn() {
  if (!firebaseReady) {
    showToast(
      "Google sign-in needs a one-time Firebase setup (free, ~5 min — see README.md). It works on localhost too, no deploy needed. Your notes stay on this device until then.",
      { duration: 8000 }
    );
    return;
  }
  hide($("loginError"));
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (err) {
    console.error(err);
    showLoginError(friendlyAuthError(err));
    showToast(friendlyAuthError(err), { type: "error", duration: 6000 });
  }
}

function friendlyAuthError(err) {
  const code = err && err.code ? err.code : "";
  if (code === "auth/popup-blocked")
    return "Your browser blocked the sign-in popup. Please allow popups and try again.";
  if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request")
    return "Sign-in was cancelled.";
  if (code === "auth/network-request-failed")
    return "No internet connection. You can keep using this device without an account.";
  if (code === "auth/unauthorized-domain")
    return "This site's domain isn't authorized in Firebase yet. Add it under Authentication → Settings → Authorized domains.";
  if (code === "auth/operation-not-allowed")
    return "Google sign-in isn't enabled in Firebase yet. Enable it under Authentication → Sign-in method.";
  return "Couldn't sign in. Please try again.";
}

function showLoginError(msg) {
  const el = $("loginError");
  el.textContent = msg;
  show(el);
}

// ------------------------------------------------------------
//  Theme
// ------------------------------------------------------------
let themingTimer;
function wireThemeToggle() {
  const box = $("themeCheckbox");
  if (!box) return;
  const root = document.documentElement;
  // checkbox checked == dark (matches the sun→moon slider)
  box.checked = (root.getAttribute("data-theme") || "dark") === "dark";
  box.addEventListener("change", () => {
    const theme = box.checked ? "dark" : "light";
    // Enable the 2s color fade only for this deliberate switch.
    root.classList.add("theming");
    clearTimeout(themingTimer);
    themingTimer = setTimeout(() => root.classList.remove("theming"), 2100);
    root.setAttribute("data-theme", theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "light" ? "#ffffff" : "#0f0f0f");
    try {
      localStorage.setItem("theme", theme);
    } catch (e) {}
  });
}

// ------------------------------------------------------------
//  Tag <select> options
// ------------------------------------------------------------
function populateTagInputs() {
  const addSel = $("quoteTag");
  for (const tag of TAGS) {
    const o = document.createElement("option");
    o.value = tag;
    o.textContent = capitalize(tag);
    if (tag === DEFAULT_TAG) o.selected = true;
    addSel.appendChild(o);
  }
}

// ------------------------------------------------------------
//  App UI wiring
// ------------------------------------------------------------
function wireAppUI() {
  $("addForm").addEventListener("submit", onAddSubmit);
  // Ctrl/Cmd + Enter submits from anywhere in the composer (quote, source, or tag).
  $("addForm").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      $("addForm").requestSubmit();
    }
  });

  $("searchInput").addEventListener(
    "input",
    debounce((e) => {
      searchTerm = e.target.value;
      applyFilter(true);
    }, 140)
  );

  $("sortBy").addEventListener("change", (e) => {
    sortOrder = e.target.value;
    applyFilter(true);
  });

  setupInfiniteScroll();

  $("exportBtn").addEventListener("click", exportPdf);

  $("list").addEventListener("click", (e) => {
    const btn = e.target.closest(".del-btn");
    if (btn) onDelete(btn.dataset.id);
  });

  window.addEventListener("online", () => {
    if (currentMode === "cloud") hide($("offlineBadge"));
  });
}

async function onAddSubmit(e) {
  e.preventDefault();
  if (!currentStore) return;
  const text = $("quoteText").value.trim();
  const source = $("quoteSource").value.trim();
  const tag = $("quoteTag").value;
  if (!text) return;

  const addBtn = $("addBtn");
  addBtn.disabled = true;
  try {
    await currentStore.add({ text, source, tag });
    $("quoteText").value = "";
    $("quoteSource").value = "";
    $("quoteText").focus();
  } catch (err) {
    console.error(err);
    showToast("Couldn't save. Please try again.", { type: "error" });
  } finally {
    addBtn.disabled = false;
  }
}

async function onDelete(id) {
  if (!currentStore || !id) return;
  const q = allQuotes.find((x) => x.id === id);
  if (!q) return;
  // Optimistic delete + Undo toast (Gmail-style) — no jarring confirm dialog.
  const backup = {
    text: q.text,
    source: q.source,
    tag: q.tag,
    createdAt: tsToMillis(q.createdAt),
  };
  try {
    await currentStore.remove(id);
    showToast("Deleted", {
      actionLabel: "Undo",
      duration: 6000,
      onAction: async () => {
        try {
          await currentStore.add(backup);
        } catch (err) {
          console.error(err);
          showToast("Couldn't undo.", { type: "error" });
        }
      },
    });
  } catch (err) {
    console.error(err);
    showToast("Couldn't delete. Please try again.", { type: "error" });
  }
}

// ------------------------------------------------------------
//  Filtering + rendering
// ------------------------------------------------------------
// resetPage=true (search/filter/sort) restarts at the first page.
// resetPage falsy (data refresh) keeps how far the user has scrolled.
function applyFilter(resetPage) {
  const t = searchTerm.trim().toLowerCase();
  filtered = allQuotes.filter((q) => {
    if (t) {
      const hay = ((q.text || "") + " " + (q.source || "")).toLowerCase();
      if (!hay.includes(t)) return false;
    }
    return true;
  });
  filtered.sort(sortComparator);
  if (resetPage) renderCount = PAGE_SIZE;
  else renderCount = Math.max(PAGE_SIZE, Math.min(renderCount, filtered.length));
  render();
}

// Shared ordering used by both the list and the PDF export, driven by `sortOrder`.
function sortComparator(a, b) {
  if (sortOrder === "tag") {
    // Group by tag (in the order tags are defined), newest first within a tag.
    const ia = tagRank(a.tag);
    const ib = tagRank(b.tag);
    if (ia !== ib) return ia - ib;
    return tsToMillis(b.createdAt) - tsToMillis(a.createdAt);
  }
  const dir = sortOrder === "asc" ? 1 : -1;
  return (tsToMillis(a.createdAt) - tsToMillis(b.createdAt)) * dir;
}

function tagRank(tag) {
  const i = TAGS.indexOf(tag);
  return i < 0 ? TAGS.length : i; // unknown tags sort last
}

// Fresh render (on search / filter / sort / data change). Only puts the first
// `renderCount` cards in the DOM; the rest stream in via infinite scroll.
function render() {
  const list = $("list");

  // Loading skeletons (first cloud load only)
  if (loading && allQuotes.length === 0) {
    hide($("emptyState"));
    $("countLabel").textContent = "";
    renderSkeletons(list);
    domShown = 0;
    return;
  }

  const total = filtered.length;

  if (allQuotes.length === 0) {
    list.replaceChildren();
    domShown = 0;
    $("countLabel").textContent = "";
    setEmpty("📝", "Nothing here yet.", "Add your first quote or thought above ☝️");
    return;
  }
  if (total === 0) {
    list.replaceChildren();
    domShown = 0;
    $("countLabel").textContent = "0 of " + allQuotes.length;
    setEmpty("🔎", "No matches.", "Try a different search or tag.");
    return;
  }

  hide($("emptyState"));

  const visible = Math.min(renderCount, total);
  const frag = document.createDocumentFragment();
  for (let i = 0; i < visible; i++) frag.appendChild(renderCard(filtered[i]));
  list.replaceChildren(frag);
  domShown = visible;
  updateCount(total, visible);

  // Fill the first viewport if it isn't full yet (tall screens / few cards).
  fillWhileVisible();
}

// Append the next page of cards (infinite scroll) without re-rendering existing ones.
function appendMore() {
  const total = filtered.length;
  if (domShown >= total) return;
  const next = Math.min(domShown + PAGE_SIZE, total);
  const frag = document.createDocumentFragment();
  for (let i = domShown; i < next; i++) frag.appendChild(renderCard(filtered[i]));
  $("list").appendChild(frag);
  domShown = next;
  renderCount = next; // keep target in sync so a data refresh preserves scroll depth
  updateCount(total, next);
}

function updateCount(total, shown) {
  $("countLabel").textContent =
    (total === allQuotes.length
      ? total + (total === 1 ? " entry" : " entries")
      : total + " of " + allQuotes.length) +
    (shown < total ? " · showing " + shown : "");
}

// Keep appending while the sentinel sits within the prefetch zone.
function fillWhileVisible() {
  const sentinel = $("sentinel");
  if (!sentinel) return;
  let guard = 0;
  while (domShown < filtered.length && guard++ < 80) {
    if (sentinel.getBoundingClientRect().top > window.innerHeight + 600) break;
    appendMore();
  }
}

function setupInfiniteScroll() {
  const sentinel = $("sentinel");
  if (!sentinel) return;
  if (typeof IntersectionObserver !== "undefined") {
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) fillWhileVisible();
      },
      { rootMargin: "600px 0px" }
    );
    io.observe(sentinel);
  } else {
    // Fallback for very old browsers
    window.addEventListener("scroll", debounce(fillWhileVisible, 100), { passive: true });
  }
  window.addEventListener("resize", debounce(fillWhileVisible, 150), { passive: true });
}

function setEmpty(emoji, title, sub) {
  const el = $("emptyState");
  el.querySelector(".empty-emoji").textContent = emoji;
  el.querySelector("p").textContent = title;
  el.querySelector(".muted").textContent = sub;
  show(el);
}

function renderSkeletons(list) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 3; i++) {
    const card = document.createElement("div");
    card.className = "skeleton-card";
    card.innerHTML =
      '<div class="sk-line"></div><div class="sk-line mid"></div><div class="sk-line tag"></div>';
    frag.appendChild(card);
  }
  list.replaceChildren(frag);
}

function renderCard(q) {
  const card = document.createElement("article");
  card.className = "quote";

  const text = document.createElement("p");
  text.className = "quote-text";
  text.textContent = q.text || ""; // textContent => safe from HTML injection

  const foot = document.createElement("div");
  foot.className = "quote-foot";

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.setAttribute("data-tag", q.tag || "");
  badge.textContent = capitalize(q.tag || "");
  foot.appendChild(badge);

  if (q.source) {
    const src = document.createElement("span");
    src.className = "quote-source";
    src.textContent = q.source;
    foot.appendChild(src);
  }

  const dot = document.createElement("span");
  dot.className = "dot";
  dot.textContent = "·";
  foot.appendChild(dot);

  const date = document.createElement("span");
  date.className = "quote-date";
  date.textContent = formatDate(q.createdAt);
  foot.appendChild(date);

  const del = document.createElement("button");
  del.className = "del-btn";
  del.type = "button";
  del.title = "Delete";
  del.setAttribute("aria-label", "Delete quote");
  del.dataset.id = q.id;
  del.textContent = "✕";

  card.appendChild(del);
  card.appendChild(text);
  card.appendChild(foot);
  return card;
}

// ------------------------------------------------------------
//  Toasts
// ------------------------------------------------------------
function showToast(message, opts) {
  opts = opts || {};
  const wrap = $("toasts");
  const el = document.createElement("div");
  el.className = "toast" + (opts.type === "error" ? " error" : "");

  const msg = document.createElement("span");
  msg.className = "toast-msg";
  msg.textContent = message;
  el.appendChild(msg);

  let timer;
  function dismiss() {
    clearTimeout(timer);
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 200);
  }

  if (opts.actionLabel && typeof opts.onAction === "function") {
    const btn = document.createElement("button");
    btn.className = "toast-action";
    btn.type = "button";
    btn.textContent = opts.actionLabel;
    btn.addEventListener("click", () => {
      opts.onAction();
      dismiss();
    });
    el.appendChild(btn);
  }

  wrap.appendChild(el);
  timer = setTimeout(dismiss, opts.duration || 4000);
  return dismiss;
}

// ------------------------------------------------------------
//  PDF export (jsPDF lazy-loaded on demand)
// ------------------------------------------------------------
async function exportPdf() {
  if (allQuotes.length === 0) {
    showToast("You have nothing to export yet.");
    return;
  }
  setBusy(true, "Building your PDF…");
  try {
    const mod = await import("https://cdn.jsdelivr.net/npm/jspdf@2.5.2/+esm");
    const jsPDF = mod.jsPDF || (mod.default && mod.default.jsPDF) || mod.default;
    const pdf = new jsPDF({ unit: "pt", format: "a4" });

    const margin = 42;
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const maxW = pageW - margin * 2;
    let y = margin;

    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(20);
    pdf.text("Ponder — Quotes & Thoughts", margin, y);
    y += 22;
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(10);
    pdf.setTextColor(130);
    pdf.text(
      "Exported " + new Date().toLocaleString() + "  ·  " + allQuotes.length + " entries",
      margin,
      y
    );
    y += 24;

    // Export every entry, ordered by whatever sort is currently selected.
    const exportList = allQuotes.slice().sort(sortComparator);
    for (const q of exportList) {
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(12);
      const bodyLines = pdf.splitTextToSize("“" + (q.text || "") + "”", maxW);

      const metaParts = [];
      if (q.source) metaParts.push(q.source);
      metaParts.push(capitalize(q.tag || ""));
      metaParts.push(formatDate(q.createdAt));
      const metaLines = pdf.splitTextToSize(metaParts.join("  ·  "), maxW);

      const blockH = bodyLines.length * 16 + metaLines.length * 12 + 22;
      if (y + blockH > pageH - margin) {
        pdf.addPage();
        y = margin;
      }

      pdf.setTextColor(25);
      pdf.text(bodyLines, margin, y);
      y += bodyLines.length * 16 + 4;

      pdf.setFontSize(9);
      pdf.setTextColor(120);
      pdf.text(metaLines, margin, y);
      y += metaLines.length * 12 + 12;

      pdf.setDrawColor(220);
      pdf.line(margin, y - 6, pageW - margin, y - 6);
      y += 6;
    }

    const pages = pdf.internal.getNumberOfPages();
    for (let p = 1; p <= pages; p++) {
      pdf.setPage(p);
      pdf.setFontSize(8);
      pdf.setTextColor(160);
      pdf.text(p + " / " + pages, pageW - margin, pageH - 18, { align: "right" });
    }

    const stamp = new Date().toISOString().slice(0, 10);
    pdf.save("ponder-backup-" + stamp + ".pdf");
    showToast("PDF downloaded (" + allQuotes.length + " entries)");
  } catch (err) {
    console.error(err);
    showToast("Couldn't build the PDF. Please check your connection and try again.", {
      type: "error",
    });
  } finally {
    setBusy(false);
  }
}

function setBusy(on, text) {
  const overlay = $("overlay");
  if (on) {
    $("overlayText").textContent = text || "Working…";
    show(overlay);
  } else {
    hide(overlay);
  }
}

// ------------------------------------------------------------
//  Utils
// ------------------------------------------------------------
function capitalize(s) {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function toDateObj(ts) {
  if (ts == null) return null;
  if (typeof ts.toDate === "function") return ts.toDate(); // Firestore Timestamp
  if (typeof ts === "number") return new Date(ts); // local epoch ms
  if (typeof ts === "string") {
    const d = new Date(ts);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function tsToMillis(ts) {
  const d = toDateObj(ts);
  return d ? d.getTime() : Date.now();
}

function formatDate(ts) {
  const d = toDateObj(ts);
  if (!d) return "Just now";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function genId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "q_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function debounce(fn, ms) {
  let t;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

// Remove the preload guard once the page has painted, so theme transitions work.
requestAnimationFrame(() =>
  requestAnimationFrame(() => document.documentElement.classList.remove("preload"))
);

// Go! (fall back to local mode if anything in boot unexpectedly fails)
boot().catch((err) => {
  console.error("Boot failed, falling back to local mode:", err);
  try {
    firebaseReady = false;
    enterLocalMode();
  } catch (e) {
    console.error(e);
  }
});

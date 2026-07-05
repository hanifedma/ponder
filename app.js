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

// ---- Spaces: each is its own database (Firestore collection + local key)
//      with its own tags. Add another space here and it appears in the nav. ----
const SPACES = {
  ponder: {
    name: "Ponder",
    icon: "❝",
    collection: "quotes",
    localKey: "quotes_local_v1",
    tags: ["extraterrestrial", "try to read this everyday", "very important", "pretty important", "interesting"],
    defaultTag: "interesting",
    placeholder: "Write a quote or a thought…",
    addLabel: "Add quote",
    pdfTitle: "Ponder — Quotes & Thoughts",
    pdfFile: "ponder-backup",
    emptyTitle: "Nothing here yet.",
    emptySub: "Add your first quote or thought above ☝️",
    localNote: "Your quotes &amp; thoughts are saved on this device only.",
  },
  health: {
    name: "Healthy Tips",
    icon: "🌿",
    collection: "healthtips",
    localKey: "healthtips_local_v1",
    tags: ["pretty sure", "not really", "interesting"],
    defaultTag: "interesting",
    placeholder: "Write a healthy tip…",
    addLabel: "Add tip",
    pdfTitle: "Healthy Tips",
    pdfFile: "healthy-tips-backup",
    emptyTitle: "No tips yet.",
    emptySub: "Add your first healthy tip above ☝️",
    localNote: "Your healthy tips are saved on this device only.",
  },
};
const SPACE_ORDER = ["ponder", "health"];

let currentSpace = "ponder"; // set from localStorage in boot()
let TAGS = SPACES[currentSpace].tags; // current space's tags (updated on switch)
let DEFAULT_TAG = SPACES[currentSpace].defaultTag;

const PAGE_SIZE = 50; // how many cards to add to the DOM at a time
const SIMILAR_THRESHOLD = 0.6; // 0..1 word-overlap that counts as "similar"

// ---- Tiny DOM helpers ----
const $ = (id) => document.getElementById(id);
const show = (el) => el && (el.hidden = false);
const hide = (el) => el && (el.hidden = true);

// ---- App state ----
let auth = null;
let db = null;
let firebaseReady = false; // true only when config is filled in AND init succeeded
let currentUser = null; // signed-in user (cloud mode)
let currentStore = null; // active backend (cloud or local)
let currentMode = null; // "cloud" | "local" | null(login)
let loading = false; // waiting for first cloud snapshot
let allQuotes = []; // full list from the active store (newest first)
let filtered = []; // after search + tag filter
let renderCount = PAGE_SIZE; // target number of cards to show
let domShown = 0; // number of cards currently in the DOM
let searchTerm = "";
let sortOrder = "desc"; // "desc" = newest, "asc" = oldest, "tag" = grouped by tag
let shuffleCurrentId = null; // avoid showing the same random entry twice in a row
let lastShuffle = 0; // debounce tap+click double fire

const localStores = {}; // one device-local backend per space (keyed by localKey)
function getLocalStore(key) {
  return localStores[key] || (localStores[key] = makeLocalStore(key));
}

// ------------------------------------------------------------
//  Boot
// ------------------------------------------------------------
async function boot() {
  // Restore the last-used space before building the UI.
  try {
    const saved = localStorage.getItem("active_space");
    if (saved && SPACES[saved]) currentSpace = saved;
  } catch (e) {}
  TAGS = SPACES[currentSpace].tags;
  DEFAULT_TAG = SPACES[currentSpace].defaultTag;

  wireThemeToggle();
  populateTagInputs();
  wireAppUI();
  wireAuthButtons();
  applySpaceUI();

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
function userCol(uid, coll) {
  // Per-user subcollection => strong isolation + no composite index needed.
  return collection(db, "users", uid, coll);
}

function makeCloudStore(uid, coll) {
  let unsub = null;
  return {
    mode: "cloud",
    start(onData) {
      const q = query(userCol(uid, coll), orderBy("createdAt", "desc"));
      unsub = onSnapshot(
        q,
        (snap) => {
          const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
          onData(items, { fromCache: snap.metadata.fromCache, local: false });
        },
        (err) => {
          console.error("Firestore error:", err);
          showToast(
            "Couldn't load your data. Check your connection, or that the Firestore security rules are published.",
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
      await addDoc(userCol(uid, coll), {
        text: q.text,
        source: q.source || "",
        tag: q.tag || DEFAULT_TAG,
        createdAt,
      });
    },
    async remove(id) {
      await deleteDoc(doc(db, "users", uid, coll, id));
    },
  };
}

function makeLocalStore(localKey) {
  let items = load();
  let cb = null;

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(localKey)) || [];
      return raw.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    } catch (e) {
      return [];
    }
  }
  function save() {
    try {
      localStorage.setItem(localKey, JSON.stringify(items));
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
        tag: q.tag || DEFAULT_TAG,
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

// Move device-local items (every space) into the signed-in account (one-time offer).
async function maybeMigrateLocal(user) {
  const withLocal = SPACE_ORDER
    .map((k) => SPACES[k])
    .filter((s) => getLocalStore(s.localKey).getAll().length);
  const total = withLocal.reduce((n, s) => n + getLocalStore(s.localKey).getAll().length, 0);
  if (!total) return;
  const ok = confirm(
    "You have " + total + " item(s) saved on this device.\n\nMove them into your account so they sync across devices?"
  );
  if (!ok) return;
  try {
    let moved = 0;
    for (const s of withLocal) {
      const store = getLocalStore(s.localKey);
      const cloud = makeCloudStore(user.uid, s.collection);
      const ordered = store
        .getAll()
        .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
      for (const q of ordered) {
        await cloud.add(q);
        moved++;
      }
      store.clear();
    }
    showToast("Moved " + moved + " item(s) into your account");
  } catch (err) {
    console.error(err);
    showToast("Couldn't move everything — it's still safe on this device.", { type: "error" });
  }
}

// ------------------------------------------------------------
//  View switching
// ------------------------------------------------------------
function enterLogin() {
  hide($("bootLoading"));
  stopStore();
  currentUser = null;
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
  currentUser = null;
  currentMode = "local";

  hide($("loginView"));
  hide($("setupView"));
  show($("topbar"));
  show($("appView"));

  hide($("userChip"));
  show($("localChip"));
  show($("syncBtn")); // always offer Google sign-in, even before deploying

  if (firebaseReady) hide($("localNote"));
  else show($("localNote"));

  requestAnimationFrame(positionPill);
  startSpaceStore();
}

function enterCloudMode(user) {
  hide($("bootLoading"));
  currentUser = user;
  currentMode = "cloud";

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

  requestAnimationFrame(positionPill);
  startSpaceStore();
}

// (Re)start the active store for the current mode + space, then render.
function startSpaceStore() {
  stopStore();
  allQuotes = [];
  filtered = [];
  renderCount = PAGE_SIZE;
  const space = SPACES[currentSpace];
  if (currentMode === "cloud" && currentUser) {
    currentStore = makeCloudStore(currentUser.uid, space.collection);
    loading = true;
    render(); // skeletons until the first snapshot arrives
  } else if (currentMode === "local") {
    currentStore = getLocalStore(space.localKey);
    loading = false;
  } else {
    currentStore = null;
    return; // login screen: nothing to load
  }
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
  const shuffleSel = $("shuffleTag");
  addSel.innerHTML = "";
  while (shuffleSel.options.length > 1) shuffleSel.remove(1); // keep "All tags"
  for (const tag of TAGS) {
    const o = document.createElement("option");
    o.value = tag;
    o.textContent = capitalize(tag);
    if (tag === DEFAULT_TAG) o.selected = true;
    addSel.appendChild(o);

    const o2 = document.createElement("option");
    o2.value = tag;
    o2.textContent = capitalize(tag);
    shuffleSel.appendChild(o2);
  }
  shuffleSel.value = "all";
}

// ------------------------------------------------------------
//  Spaces (nav) — switch between Ponder / Healthy Tips
// ------------------------------------------------------------
function applySpaceUI() {
  const space = SPACES[currentSpace];
  document.title = space.name;
  $("quoteText").placeholder = space.placeholder;
  $("addBtn").textContent = space.addLabel;
  document.querySelectorAll(".space-tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.space === currentSpace)
  );
  positionPill();
}

// Slide the highlight pill onto the active tab (measured, so it animates).
function positionPill() {
  const spaces = document.querySelector(".spaces");
  const pill = spaces && spaces.querySelector(".space-pill");
  const active = spaces && spaces.querySelector(".space-tab.active");
  if (!spaces || !pill || !active || !active.offsetWidth) return; // hidden / not laid out
  pill.style.transform = "translateX(" + (active.offsetLeft - spaces.clientLeft) + "px)";
  pill.style.width = active.offsetWidth + "px";
  // Enable the slide only after the first (snap) placement, so it doesn't
  // animate in from the left on page load.
  if (!spaces.classList.contains("anim")) {
    requestAnimationFrame(() => requestAnimationFrame(() => spaces.classList.add("anim")));
  }
}

function switchSpace(key) {
  if (!SPACES[key] || key === currentSpace) return;
  currentSpace = key;
  try { localStorage.setItem("active_space", key); } catch (e) {}
  TAGS = SPACES[key].tags;
  DEFAULT_TAG = SPACES[key].defaultTag;
  // reset per-space view state
  searchTerm = "";
  $("searchInput").value = "";
  sortOrder = "desc";
  $("sortBy").value = "desc";
  populateTagInputs();
  applySpaceUI();
  startSpaceStore();
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
  $("dupBtn").addEventListener("click", scanForDuplicates);

  // Nav: switch between spaces (Ponder / Healthy Tips)
  document.querySelectorAll(".space-tab").forEach((t) => {
    t.addEventListener("click", () => switchSpace(t.dataset.space));
  });
  window.addEventListener("resize", debounce(positionPill, 150), { passive: true });

  // Shuffle (random one-at-a-time) view
  $("shuffleBtn").addEventListener("click", openShuffle);
  $("shuffleClose").addEventListener("click", closeShuffle);
  $("shuffleNext").addEventListener("click", shuffleNext);
  $("shuffleTag").addEventListener("change", () => {
    lastShuffle = 0;
    shuffleCurrentId = null;
    shuffleNext();
  });
  const stage = $("shuffleStage");
  stage.addEventListener("click", (e) => {
    if (e.target.closest("a, .embed, button")) return; // let links / media play
    shuffleNext();
  });
  let touchX = 0;
  stage.addEventListener("touchstart", (e) => { touchX = e.changedTouches[0].clientX; }, { passive: true });
  stage.addEventListener("touchend", (e) => {
    if (Math.abs(e.changedTouches[0].clientX - touchX) > 45) shuffleNext();
  }, { passive: true });
  document.addEventListener("keydown", onShuffleKey);

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
    // Warn if a similar entry already exists; let the user decide.
    const similar = findSimilar(text);
    if (similar.length) {
      const proceed = await confirmDuplicate(similar);
      if (!proceed) return; // keep their text so they can edit/discard
    }
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
//  Duplicate / similar detection (all local, no network)
// ------------------------------------------------------------
function normalizeText(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // drop punctuation; keep letters/numbers of any language
    .replace(/\s+/g, " ")
    .trim();
}

function similarityScore(aNorm, bNorm) {
  if (!aNorm || !bNorm) return 0;
  if (aNorm === bNorm) return 1;
  // one text fully contains the other (e.g. you added a few words)
  if (aNorm.length > 10 && bNorm.length > 10 && (aNorm.includes(bNorm) || bNorm.includes(aNorm))) {
    return 0.95;
  }
  // Take the stronger of two signals: word-overlap (order-independent, catches
  // reordering) and character-bigram overlap (catches typos / minor edits).
  return Math.max(jaccardWords(aNorm, bNorm), diceBigrams(aNorm, bNorm));
}

function jaccardWords(aNorm, bNorm) {
  const a = new Set(aNorm.split(" "));
  const b = new Set(bNorm.split(" "));
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

function diceBigrams(aNorm, bNorm) {
  if (aNorm.length < 2 || bNorm.length < 2) return aNorm === bNorm ? 1 : 0;
  const grams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const A = grams(aNorm);
  let aTot = 0;
  for (const c of A.values()) aTot += c;
  const B = grams(bNorm);
  let bTot = 0;
  let inter = 0;
  for (const [g, c] of B) {
    bTot += c;
    const ac = A.get(g);
    if (ac) inter += Math.min(c, ac);
  }
  return (2 * inter) / (aTot + bTot);
}

// Up to 5 existing entries similar to `text`, most-similar first.
function findSimilar(text) {
  const newNorm = normalizeText(text);
  if (!newNorm) return [];
  const out = [];
  for (const q of allQuotes) {
    const score = similarityScore(newNorm, normalizeText(q.text));
    if (score >= SIMILAR_THRESHOLD) out.push({ q, score });
  }
  out.sort((x, y) => y.score - x.score);
  return out.slice(0, 5);
}

// Modal that shows the similar entries and asks whether to add anyway.
// Resolves true (add) or false (cancel).
function confirmDuplicate(matches) {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "modal-backdrop";

    const card = document.createElement("div");
    card.className = "modal-card";

    const h = document.createElement("h2");
    h.className = "modal-title";
    h.textContent = matches.length > 1 ? "Possible duplicates" : "Possible duplicate";
    card.appendChild(h);

    const sub = document.createElement("p");
    sub.className = "modal-sub";
    sub.textContent =
      "You already have " +
      (matches.length > 1 ? "similar entries" : "a similar entry") +
      ". Add this new one anyway?";
    card.appendChild(sub);

    const list = document.createElement("div");
    list.className = "modal-list";
    for (const m of matches) {
      const item = document.createElement("div");
      item.className = "modal-quote";

      const txt = document.createElement("p");
      txt.className = "modal-quote-text";
      appendLinkified(txt, m.q.text || "");
      item.appendChild(txt);

      const meta = document.createElement("div");
      meta.className = "modal-quote-meta";

      const badge = document.createElement("span");
      badge.className = "badge";
      badge.setAttribute("data-tag", m.q.tag || "");
      badge.textContent = capitalize(m.q.tag || "");
      meta.appendChild(badge);

      if (m.q.source) {
        const src = document.createElement("span");
        src.className = "quote-source";
        appendLinkified(src, m.q.source);
        meta.appendChild(src);
      }

      const match = document.createElement("span");
      match.className = "modal-match";
      match.textContent = Math.round(m.score * 100) + "% match";
      meta.appendChild(match);

      item.appendChild(meta);
      list.appendChild(item);
    }
    card.appendChild(list);

    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const cancel = document.createElement("button");
    cancel.className = "btn btn-ghost";
    cancel.type = "button";
    cancel.textContent = "Cancel";
    const addAnyway = document.createElement("button");
    addAnyway.className = "btn btn-primary";
    addAnyway.type = "button";
    addAnyway.textContent = "Add anyway";
    actions.appendChild(cancel);
    actions.appendChild(addAnyway);
    card.appendChild(actions);

    back.appendChild(card);
    document.body.appendChild(back);

    function close(result) {
      back.remove();
      document.removeEventListener("keydown", onKey);
      resolve(result);
    }
    function onKey(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        close(true);
      }
    }
    cancel.addEventListener("click", () => close(false));
    addAnyway.addEventListener("click", () => close(true));
    back.addEventListener("click", (e) => { if (e.target === back) close(false); });
    document.addEventListener("keydown", onKey);
    // Focus the (non-actionable) card, not a button, so plain Enter does nothing
    // — only Ctrl/Cmd+Enter adds.
    card.tabIndex = -1;
    card.focus();
  });
}

// Scan the whole collection and group entries that are similar to each other.
async function scanForDuplicates() {
  if (allQuotes.length < 2) {
    showToast("You need at least two entries to check for duplicates.");
    return;
  }
  const big = allQuotes.length > 800;
  if (big) {
    setBusy(true, "Scanning for duplicates…");
    await new Promise((r) => setTimeout(r, 30)); // let the overlay paint first
  }
  let groups;
  try {
    groups = findDuplicateGroups();
  } finally {
    if (big) setBusy(false);
  }
  if (!groups.length) {
    showToast("No similar entries found 🎉");
    return;
  }
  openDuplicatesModal(groups);
}

// Returns arrays of similar entries (each array has 2+ entries), largest first.
function findDuplicateGroups() {
  const items = allQuotes;
  const n = items.length;
  // Normalize once, then score every pair with the SAME similarityScore() the
  // on-add check uses — so the two features flag identically.
  const norm = new Array(n);
  for (let i = 0; i < n; i++) norm[i] = normalizeText(items[i].text);

  // Union-Find to cluster transitively-similar entries.
  const parent = new Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x) => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  for (let i = 0; i < n; i++) {
    if (!norm[i]) continue;
    for (let j = i + 1; j < n; j++) {
      if (!norm[j]) continue;
      if (similarityScore(norm[i], norm[j]) >= SIMILAR_THRESHOLD) {
        const ri = find(i), rj = find(j);
        if (ri !== rj) parent[ri] = rj;
      }
    }
  }
  const byRoot = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let arr = byRoot.get(r);
    if (!arr) { arr = []; byRoot.set(r, arr); }
    arr.push(items[i]);
  }
  const groups = [];
  for (const arr of byRoot.values()) if (arr.length >= 2) groups.push(arr);
  groups.sort((a, b) => b.length - a.length);
  return groups;
}

function openDuplicatesModal(groups) {
  const back = document.createElement("div");
  back.className = "modal-backdrop";
  const card = document.createElement("div");
  card.className = "modal-card modal-card-lg";

  const h = document.createElement("h2");
  h.className = "modal-title";
  h.textContent = "Possible duplicates";
  card.appendChild(h);

  const total = groups.reduce((s, g) => s + g.length, 0);
  const sub = document.createElement("p");
  sub.className = "modal-sub";
  sub.textContent =
    groups.length + (groups.length > 1 ? " groups" : " group") +
    " of similar entries (" + total + " items). Delete the ones you don't want to keep.";
  card.appendChild(sub);

  const wrap = document.createElement("div");
  wrap.className = "dup-groups";
  for (const group of groups) {
    const g = document.createElement("div");
    g.className = "dup-group";
    for (const q of group) g.appendChild(buildDupItem(q));
    wrap.appendChild(g);
  }
  card.appendChild(wrap);

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const done = document.createElement("button");
  done.className = "btn btn-primary";
  done.type = "button";
  done.textContent = "Done";
  actions.appendChild(done);
  card.appendChild(actions);

  back.appendChild(card);
  document.body.appendChild(back);

  function close() {
    back.remove();
    document.removeEventListener("keydown", onKey);
  }
  function onKey(e) {
    if (e.key === "Escape") close();
  }
  done.addEventListener("click", close);
  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  document.addEventListener("keydown", onKey);
}

function buildDupItem(q) {
  const item = document.createElement("div");
  item.className = "dup-item";

  const text = document.createElement("p");
  text.className = "dup-item-text";
  appendLinkified(text, q.text || "");
  item.appendChild(text);

  const meta = document.createElement("div");
  meta.className = "dup-item-meta";
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.setAttribute("data-tag", q.tag || "");
  badge.textContent = capitalize(q.tag || "");
  meta.appendChild(badge);
  if (q.source) {
    const s = document.createElement("span");
    s.className = "quote-source";
    appendLinkified(s, q.source);
    meta.appendChild(s);
  }
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.textContent = "·";
  meta.appendChild(dot);
  const date = document.createElement("span");
  date.className = "quote-date";
  date.textContent = formatDate(q.createdAt);
  meta.appendChild(date);
  item.appendChild(meta);

  const del = document.createElement("button");
  del.className = "dup-del";
  del.type = "button";
  del.title = "Delete";
  del.setAttribute("aria-label", "Delete entry");
  del.textContent = "✕";
  del.addEventListener("click", () => dupDelete(q, item));
  item.appendChild(del);
  return item;
}

async function dupDelete(q, itemEl) {
  const groupEl = itemEl.parentElement;
  const backEl = itemEl.closest(".modal-backdrop");
  const backup = { text: q.text, source: q.source, tag: q.tag, createdAt: tsToMillis(q.createdAt) };
  try {
    await currentStore.remove(q.id);
    showToast("Deleted", {
      actionLabel: "Undo",
      duration: 6000,
      onAction: async () => {
        try { await currentStore.add(backup); }
        catch (err) { console.error(err); showToast("Couldn't undo.", { type: "error" }); }
      },
    });
    itemEl.remove();
    // A group with fewer than 2 entries is no longer a duplicate group.
    if (groupEl && groupEl.querySelectorAll(".dup-item").length < 2) groupEl.remove();
    if (backEl && backEl.querySelectorAll(".dup-group").length === 0) {
      backEl.remove();
      showToast("No more duplicates 🎉");
    }
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
    setEmpty("📝", SPACES[currentSpace].emptyTitle, SPACES[currentSpace].emptySub);
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
  appendLinkified(text, q.text || ""); // safe: builds text/anchor nodes, no HTML

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
    appendLinkified(src, q.source);
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

  // Playable media (YouTube / Instagram / Vimeo) found in the text.
  const embeds = detectEmbeds(q.text || "");
  if (embeds.length) {
    const media = document.createElement("div");
    media.className = "media";
    for (const e of embeds) {
      media.appendChild(e.type === "image" ? buildImage(e.src) : buildEmbedFacade(e));
    }
    card.appendChild(media);
  }

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
    pdf.text(SPACES[currentSpace].pdfTitle, margin, y);
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
    pdf.save(SPACES[currentSpace].pdfFile + "-" + stamp + ".pdf");
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
//  Shuffle (random, one at a time)
// ------------------------------------------------------------
function openShuffle() {
  if (!allQuotes.length) {
    showToast("Add some entries first.");
    return;
  }
  shuffleCurrentId = null;
  lastShuffle = 0;
  show($("shuffleView"));
  shuffleNext();
  $("shuffleStage").focus();
}

function closeShuffle() {
  hide($("shuffleView"));
}

function shufflePool() {
  const t = $("shuffleTag").value;
  return t === "all" ? allQuotes : allQuotes.filter((q) => q.tag === t);
}

function shuffleNext() {
  const now = Date.now();
  if (now - lastShuffle < 180) return; // avoid tap+click double fire
  lastShuffle = now;
  const pool = shufflePool();
  let q = null;
  if (pool.length === 1) q = pool[0];
  else if (pool.length > 1) {
    do {
      q = pool[Math.floor(Math.random() * pool.length)];
    } while (q.id === shuffleCurrentId);
  }
  shuffleCurrentId = q ? q.id : null;
  renderShuffleCard(q);
}

function onShuffleKey(e) {
  if ($("shuffleView").hidden) return;
  if (e.key === "Escape") {
    e.preventDefault();
    closeShuffle();
    return;
  }
  if (e.target.closest && e.target.closest("select, input, textarea, button, a")) return;
  if (e.key === " " || e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "Enter") {
    e.preventDefault();
    shuffleNext();
  }
}

function renderShuffleCard(q) {
  const stage = $("shuffleStage");
  if (!q) {
    const empty = document.createElement("div");
    empty.className = "shuffle-empty";
    empty.textContent = "No entries for this tag yet.";
    stage.replaceChildren(empty);
    return;
  }
  const card = document.createElement("div");
  card.className = "shuffle-card";

  const text = document.createElement("p");
  text.className = "shuffle-text";
  appendLinkified(text, q.text || "");
  card.appendChild(text);

  const embeds = detectEmbeds(q.text || "");
  if (embeds.length) {
    const media = document.createElement("div");
    media.className = "media";
    for (const e of embeds) {
      media.appendChild(e.type === "image" ? buildImage(e.src) : buildEmbedFacade(e));
    }
    card.appendChild(media);
  }

  const meta = document.createElement("div");
  meta.className = "shuffle-meta";
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.setAttribute("data-tag", q.tag || "");
  badge.textContent = capitalize(q.tag || "");
  meta.appendChild(badge);
  if (q.source) {
    const s = document.createElement("span");
    s.className = "quote-source";
    appendLinkified(s, q.source);
    meta.appendChild(s);
  }
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.textContent = "·";
  meta.appendChild(dot);
  const date = document.createElement("span");
  date.className = "quote-date";
  date.textContent = formatDate(q.createdAt);
  meta.appendChild(date);
  card.appendChild(meta);

  stage.replaceChildren(card);
}

// ------------------------------------------------------------
//  Utils
// ------------------------------------------------------------
function capitalize(s) {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Appends `text` into `el`, turning any http(s):// or www. URL into a real,
// safe clickable link (opens in a new tab). No innerHTML, so no injection.
function appendLinkified(el, text) {
  const str = text || "";
  const re = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;
  let last = 0;
  let m;
  while ((m = re.exec(str)) !== null) {
    if (m.index > last) el.appendChild(document.createTextNode(str.slice(last, m.index)));
    const raw = m[0];
    // don't swallow trailing sentence punctuation into the URL
    const url = raw.replace(/[.,;:!?)\]'"]+$/, "");
    const trailing = raw.slice(url.length);
    const a = document.createElement("a");
    a.className = "quote-link";
    a.href = /^https?:\/\//i.test(url) ? url : "https://" + url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = url;
    el.appendChild(a);
    if (trailing) el.appendChild(document.createTextNode(trailing));
    last = m.index + raw.length;
  }
  if (last < str.length) el.appendChild(document.createTextNode(str.slice(last)));
}

// Find embeddable media (YouTube / Vimeo / Instagram) in an entry's text.
function detectEmbeds(text) {
  const str = text || "";
  const out = [];
  const seen = new Set();
  const add = (o) => {
    const key = o.type + ":" + o.id;
    if (!seen.has(key)) { seen.add(key); out.push(o); }
  };
  let m;
  const yt = /(?:youtube\.com\/(?:watch\?(?:[^ ]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/gi;
  while ((m = yt.exec(str)) !== null)
    add({
      type: "youtube", id: m[1], label: "YouTube video",
      embed: "https://www.youtube.com/embed/" + m[1],
      thumb: "https://i.ytimg.com/vi/" + m[1] + "/hqdefault.jpg",
    });
  const vm = /vimeo\.com\/(?:video\/)?(\d{6,})/gi;
  while ((m = vm.exec(str)) !== null)
    add({ type: "vimeo", id: m[1], label: "Vimeo video", embed: "https://player.vimeo.com/video/" + m[1] });
  const ig = /instagram\.com\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/gi;
  while ((m = ig.exec(str)) !== null) {
    const kind = m[1] === "reels" ? "reel" : m[1];
    add({
      type: "instagram", id: m[2],
      label: "Instagram " + (kind === "reel" ? "reel" : kind === "tv" ? "video" : "post"),
      embed: "https://www.instagram.com/" + kind + "/" + m[2] + "/embed/",
    });
  }
  // Direct image links (shown inline).
  const im = /https?:\/\/[^\s]+\.(?:jpe?g|png|gif|webp|avif|bmp|svg)(?:\?[^\s]*)?/gi;
  while ((m = im.exec(str)) !== null) add({ type: "image", id: m[0], src: m[0], label: "image" });
  return out;
}

// A lightweight preview that swaps in the real player iframe only when clicked.
function buildEmbedFacade(e) {
  const ratio = e.type !== "instagram"; // 16:9 for video players
  const wrap = document.createElement("div");
  wrap.className = "embed embed-" + e.type + (ratio ? " ratio" : "");

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "embed-facade";
  btn.setAttribute("aria-label", "Play " + e.label);

  if (e.thumb) {
    const img = document.createElement("img");
    img.className = "embed-thumb";
    img.loading = "lazy";
    img.alt = "";
    img.src = e.thumb;
    img.addEventListener("error", () => img.remove()); // fall back to plain facade
    btn.appendChild(img);
  }
  const play = document.createElement("span");
  play.className = "embed-play";
  play.textContent = "▶";
  btn.appendChild(play);
  const label = document.createElement("span");
  label.className = "embed-label";
  label.textContent = "Play " + e.label;
  btn.appendChild(label);

  btn.addEventListener("click", () => {
    const frame = document.createElement("iframe");
    frame.className = ratio ? "embed-iframe" : "embed-iframe embed-iframe-ig";
    let src = e.embed;
    if (e.type === "youtube") src += "?autoplay=1&rel=0";
    else if (e.type === "vimeo") src += "?autoplay=1";
    frame.src = src;
    frame.allow =
      "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
    frame.setAttribute("allowfullscreen", "");
    frame.loading = "lazy";
    wrap.replaceChildren(frame);
    wrap.classList.add("loaded");
  });
  wrap.appendChild(btn);
  return wrap;
}

// An inline image from a direct image URL (lazy-loaded; click opens full size).
function buildImage(src) {
  const wrap = document.createElement("div");
  wrap.className = "embed embed-image";
  const a = document.createElement("a");
  a.href = src;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  const img = document.createElement("img");
  img.className = "embed-img";
  img.loading = "lazy";
  img.alt = "";
  img.src = src;
  img.addEventListener("error", () => wrap.remove()); // hide if the link isn't a real image
  a.appendChild(img);
  wrap.appendChild(a);
  return wrap;
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

// ------------------------------------------------------------
//  Auto-update: notice when a newer version has been deployed
//  and offer to reload — so already-open tabs update quickly.
// ------------------------------------------------------------
const RUNNING_VERSION = (document.querySelector('meta[name="app-version"]') || {}).content || "";
let updatePrompted = false;

async function checkForUpdate() {
  if (!RUNNING_VERSION || updatePrompted) return;
  try {
    // Unique query + no-store bypasses browser and CDN caches for a true check.
    const res = await fetch("version.json?_=" + Date.now(), { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    const server = String(data.version || "");
    if (server && server !== RUNNING_VERSION) {
      updatePrompted = true;
      showToast("A new version of Ponder is available.", {
        actionLabel: "Reload",
        duration: 24 * 60 * 60 * 1000, // stay until they act
        onAction: () => location.replace(location.pathname + "?v=" + encodeURIComponent(server)),
      });
    }
  } catch (e) {
    /* offline or version.json missing — ignore */
  }
}

if (RUNNING_VERSION) {
  checkForUpdate(); // catches a stale page that loaded from cache
  setInterval(checkForUpdate, 60000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) checkForUpdate();
  });
  window.addEventListener("focus", checkForUpdate);
}

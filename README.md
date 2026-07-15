# ❝ Ponder

A tiny, fast web app to keep your favourite quotes **and your own thoughts** — private to you, backed up as PDF.

- ✅ **Works immediately** — open it with no login, no setup, and even offline. Entries are
  saved **on your device** (local mode). It works the same before *and* after you deploy it.
- 🔐 **Optional Google sign-in** — when you add Firebase (below), each person sees only their own
  entries, synced across devices. Sign in later and it offers to move your on-device entries into your account.
- 🗂️ **Two spaces** in one app — **❝ Ponder** (quotes & thoughts) and **🌿 Healthy Tips** — each with
  its own database and its own tags. Every entry has a **date added**, an optional **source**, and a **tag**.
- 🌐 **English / Korean** — one click switches the whole interface (your saved entries are never translated).
- ▶️ **Inline media** — paste a YouTube / Vimeo / Instagram link or a direct image URL and it becomes a
  click-to-play preview. The PDF export even embeds the thumbnails.
- 🔀 **Shuffle** one random entry at a time, and **⧉ Find duplicates** to clean up near-identical notes.
- 🌙 **Dark / light mode** (defaults to dark), 📱 **installable** (PWA — add to home screen).
- ⚡ **Very light & fast** — no framework, no web fonts, works on low-spec CPUs with no GPU. The whole
  app shell is ~27 KB gzipped; Firebase is only downloaded if you actually configure it.
- 📶 **Low-internet friendly** — entries are cached; reloads are instant even with thousands stored.
- 📄 **Export everything as a PDF** for backup.
- 🆓 Runs 100% free: static files on **GitHub Pages** + **Firebase** free tier (which, unlike some
  alternatives, does **not** pause when you don't use it — good for a backup app).

> **Don't want accounts/sync at all?** You can skip the whole Firebase setup and just use it in
> local mode. Only set up Firebase if you want Google login + syncing across devices.

---

## Files

| File | What it is |
|------|-----------|
| `index.html`, `styles.css`, `app.js` | The whole app |
| `firebase-config.js` | **Paste your Firebase keys here** (only needed for login/sync) |
| `firestore.rules` | Security rules (copy into Firebase) so users can't see each other's entries |
| `favicon.svg`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` | App / tab / home-screen icons |
| `site.webmanifest` | PWA manifest (makes the app installable) |
| `og-image.jpg` | Social share / link-preview image |
| `404.html` | Friendly, themed "page not found" page |
| `robots.txt`, `sitemap.xml` | SEO — let search engines index the site |
| `version.json`, `bump-version.sh` | Auto-update: open tabs notice a new deploy and offer to reload |
| `serve.py` | Optional local dev server (no-cache, so edits show on refresh) |
| `README.md` | This file |

---

## Setup (about 5 minutes, one time, free)

### 1. Create a Firebase project
1. Go to <https://console.firebase.google.com> and click **Add project**. Give it any name. You can turn Google Analytics **off**.

### 2. Turn on Google sign-in
1. In the left menu: **Build → Authentication → Get started**.
2. Open the **Sign-in method** tab → click **Google** → toggle **Enable** → pick a support email → **Save**.

### 3. Create the database
1. Left menu: **Build → Firestore Database → Create database**.
2. Choose a location near you → start in **Production mode** → **Enable**.

### 4. Add the security rules
1. In **Firestore Database**, open the **Rules** tab.
2. Delete what's there and paste the contents of [`firestore.rules`](./firestore.rules).
3. Click **Publish**.

> These rules are what keep every user's quotes private to them.

### 5. Register a web app and copy your keys
1. Click the ⚙️ gear (top-left) → **Project settings** → scroll to **Your apps** → click the **web** icon `</>`.
2. Give it a nickname → **Register app** (you do **not** need Hosting).
3. Firebase shows a `firebaseConfig = { ... }` block. Copy those values into
   [`firebase-config.js`](./firebase-config.js), replacing the `YOUR_...` placeholders.

> These keys are safe to commit to GitHub — they only identify your project, and the security rules
> protect your data.

### 6. Test locally (optional)
Because the app uses ES modules, open it through a small local server (not by double-clicking the file):

```bash
# from inside this folder
python3 serve.py          # visit http://localhost:8080
# (or plain:  python3 -m http.server 8000)
```

`serve.py` disables caching so your edits always show up on refresh. `localhost` is already an
allowed sign-in domain in Firebase, so Google login works there too.

---

## Deploy to GitHub Pages

1. Create a new GitHub repository and push these files to it:
   ```bash
   git init
   git add .
   git commit -m "Quotes app"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
   git push -u origin main
   ```
2. On GitHub: **Settings → Pages** → under *Build and deployment*, set **Source = Deploy from a branch**,
   **Branch = main**, folder **/(root)** → **Save**.
3. Wait ~1 minute. Your site will be at `https://YOUR_USERNAME.github.io/YOUR_REPO/`.

### 7. Allow that domain in Firebase (important!)
Google sign-in only works on domains you approve:
1. Firebase → **Authentication → Settings → Authorized domains → Add domain**.
2. Add `YOUR_USERNAME.github.io` → **Add**.

Done — open your GitHub Pages URL and sign in. 🎉

---

## Everyday use
- Switch between **❝ Ponder** and **🌿 Healthy Tips** with the slider at the top-left.
- Type an entry, add a source and pick a tag, hit **Add** (or `Ctrl`+`Enter`).
- Paste a **YouTube / Vimeo / Instagram** link or a direct **image URL** to embed playable media.
- **Search**, **sort** (newest / oldest / by tag), **🔀 Shuffle**, or **⧉ Find duplicates**.
- **⬇ Export PDF** downloads a backup of everything in the current space (with media thumbnails).
- **🌐** toggles English / Korean; **🌙 / ☀️** toggles dark / light.

## Customizing spaces & tags
Open `app.js` and edit the **`SPACES`** object near the top. Each space defines its `collection`
(Firestore), `localKey`, and its own `tags`. Add another entry to `SPACES` (and to `SPACE_ORDER`)
and it appears in the nav automatically. Korean labels for tags live in the `I18N` dictionary
(the `"tag.<name>"` keys) just below.

## Free-tier limits (plenty for personal use)
Firebase's free "Spark" plan gives ~50,000 reads and ~20,000 writes **per day** and 1 GB storage —
far more than a personal quotes collection needs.

# Lucid Rooms — "OPENING THE DOOR" Stuck Loading Debug Repo

**Issue:** Room loads, displays "OPENING THE DOOR" splash screen, never progresses to actual chat. Hung indefinitely.

**Status:** Partially hotfixed (companion_thoughts and companion_arc queries disabled). Core blocking issue remains in boot sequence.

---

## The Problem

### What Changed (Commit 3a78b18)
Four days ago, "Wire the growth layer" added two Supabase queries to chat.js:
- `companion_thoughts` table fetch (lines 350-370)
- `companion_arc` table fetch (lines 375-395)

These tables **do not exist** in Supabase yet. When the queries ran, they returned errors that weren't properly handled, causing the entire chat initialization to hang.

### Current Hotfix (Commit 3998fd6)
Both problematic queries are now **commented out**, so they don't execute at all. This removes the hang — but it doesn't fix the underlying architectural problem.

**The deeper issue:** The boot sequence has multiple unprotected Supabase/Netlify fetches with **no timeouts** and **no top-level error handler**. If ANY of them stall, the loading screen never gets hidden.

---

## Where the Real Block Is

**Not in chat.js** (that only matters after sendOpening() returns)

**The real hang is in room-view.html, lines ~600-750**, in the boot IIFE:

```js
(async () => {
  // Recover companionId (multiple try-catches, each with awaited fetches)
  // Lines ~640: Supabase companion lookup by user_id
  // Lines ~665: Supabase users lookup (fallback)
  // Lines ~695: memory.js recover_session call (NO TIMEOUT)
  
  // Lines ~715: Memory-based companion recovery
  // Lines ~740: memory.js recover_session call again (NO TIMEOUT)
  
  // ... all this happens BEFORE the loading screen is hidden ...
  
  // Lines 745-795: assignedSlug path (for lobby AI transitions)
  // Lines 861+: Room fetch for direct room URLs
  
  // Only AFTER all of this completes:
  // Line 791: document.getElementById('loading').style.display = 'none';
})();
```

**If any fetch between lines 600-860 hangs or times out:**
- The IIFE never completes
- The loading screen is never hidden
- User sees "OPENING THE DOOR" forever

---

## The Smoking Gun: memory.js Calls Without Timeout

Three places in the boot IIFE call the memory.js Netlify function:

1. **Line 697** — recover_session call
   ```js
   const memUserRes = await fetch('/.netlify/functions/memory', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ action: 'recover_session', companionId: compRows[0].id })
   });
   ```

2. **Line 708** — recover_session call (inside email fallback)
   ```js
   const memUserRes = await fetch('/.netlify/functions/memory', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ action: 'recover_session', companionId: compRows[0].id })
   });
   ```

3. **Line 740** — memory lookup call
   ```js
   const memRecRes = await fetch('/.netlify/functions/memory', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ action: 'recover_session', userId: bootUserId })
   });
   ```

**None of these have AbortController timeouts.** If memory.js hangs, the fetch will wait indefinitely.

---

## Why This Matters

**Miranda reported:** "The room hangs on OPENING THE DOOR, never loads"

**Expected behavior:**
1. Click room link → room-view.html loads
2. Boot IIFE executes companion recovery
3. Room fetches from Supabase
4. Chat initializes
5. "OPENING THE DOOR" splash hidden
6. Chat displays with opening message

**What probably happened:**
1. Boot IIFE tries to call memory.js
2. memory.js hangs (backend issue, network issue, or bug)
3. IIFE never completes
4. Loading screen never hidden
5. User stuck forever

---

## Immediate Fix Needed

### 1. Add timeout to all fetches in boot IIFE
```js
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

const memUserRes = await fetch('/.netlify/functions/memory', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'recover_session', companionId: compRows[0].id }),
  signal: controller.signal  // ← ADD THIS
});

clearTimeout(timeoutId);
```

### 2. Wrap entire boot IIFE in top-level catch
```js
(async () => {
  try {
    // ... all boot logic ...
  } catch (err) {
    console.error('[boot-critical]', err);
    // ALWAYS hide loading screen, even if boot fails
    document.getElementById('loading').style.display = 'none';
    document.getElementById('notFound').textContent = 'Failed to load room. Refresh to try again.';
    document.getElementById('notFound').style.display = 'flex';
  }
})();
```

### 3. Check status of companion_drift_state table
Line 305 in chat.js queries `companion_drift_state`. If this table also doesn't exist, the hotfix is **insufficient** and the same hang will happen when sendOpening() is called.

---

## Files in This Repo

- **room-view.html** — The room page template. Contains boot IIFE (lines 600-860) where the hang originates.
- **chat.js** — Netlify function called by sendOpening(). Now has companion_thoughts and companion_arc queries disabled.
- **memory.js** — Netlify function called during boot. Has no timeout protection. Likely culprit if boot hangs.
- **netlify.toml** — Deployment config (included for reference).
- **README_DEBUG.md** — This file.

---

## Key Line References

**room-view.html:**
- Line 534-535: SUPABASE constants (redacted)
- Line 538: `const roomId = location.pathname.split('/').pop();`
- Line 600: Boot IIFE starts: `(async () => {`
- Line 640-680: Companion recovery by user_id (first recovery attempt)
- Line 680-730: Email fallback recovery (second attempt)
- Line 697: First memory.js call (NO TIMEOUT)
- Line 708: Second memory.js call (NO TIMEOUT)
- Line 730-750: Memory-based recovery (third attempt)
- Line 740: Third memory.js call (NO TIMEOUT)
- Line 745-860: Main room initialization (assignedSlug path and direct room fetch)
- Line 791: `document.getElementById('loading').style.display = 'none';` ← NEVER EXECUTES if boot hangs
- Line 861+: `document.getElementById('layout').style.display = 'grid';` ← NEVER EXECUTES if boot hangs

**chat.js:**
- Line 197+: Companion state injection (working)
- Line 212+: Relationship context injection (working)
- Line 305: `companion_drift_state` query (UNKNOWN IF TABLE EXISTS)
- Line 350-370: `companion_thoughts` query (DISABLED — table doesn't exist)
- Line 375-395: `companion_arc` query (DISABLED — table doesn't exist)

---

## Hypothesis

The room is stuck because:

1. Boot IIFE tries to recover companion via memory.js
2. memory.js hangs (possibly checking a non-existent table, or a backend issue)
3. IIFE never completes
4. Loading screen never hidden
5. Page stuck forever

**Confirmation method:**
- Add temporary console.log statements before each memory.js call
- Add temporary console.log statements after each memory.js call
- Open room in browser → DevTools Console
- Observe which fetch completes and which doesn't

---

## Deploy Commit Info

**Current Deploy:** lucid-rooms.netlify.app (auto-deploys from GitHub)
**Last Hotfix:** Commit 3998fd6 (disable companion_thoughts and companion_arc queries)
**Issue Introduced:** Commit 3a78b18 (Wire the growth layer)
**Working Deploy:** Commit 3a78b18~1 (before growth layer)

---

## Next Steps for Debugging

### For ChatGPT / Code Review:
1. Review room-view.html boot sequence (lines 600-860)
2. Identify all unprotected await fetch() calls
3. Check which Supabase tables actually exist in Supabase dashboard
4. Verify companion_drift_state exists (chat.js line 305)
5. Add AbortController timeouts to every fetch
6. Add top-level error handler to boot IIFE

### For Miranda / Manual Testing:
1. Open lucid-rooms.netlify.app in browser
2. Open DevTools Console (or DevTools on Safari iOS if possible)
3. Click "Go to your room" or navigate to a room URL
4. Observe Console log output — which fetches complete, which hang?
5. Note the exact error message (if any)
6. Screenshot the Network tab (which requests are pending?)

---

## Safety Note

**API keys in this repo:** REDACTED
- SUPABASE_ANON_KEY replaced with placeholder
- process.env secrets are not in source code (stored in Netlify env vars)
- This repo is safe to share publicly

---

**Generated for debugging purposes. Do not commit temporary logging to production.**

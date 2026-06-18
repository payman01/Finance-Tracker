(function () {
  'use strict';

  var API          = '/api/data';
  var STORE_KEY    = 'fintrack_v2';
  var CHECKED      = 'ft_checked';   // sessionStorage — one cloud check per tab
  var FP_KEY       = 'ft_sync_fp';   // localStorage — fingerprint of last-pushed content
  var SAVED_AT_KEY = 'ft_saved_at';  // localStorage — timestamp of last push (kept separate
                                     // so the app can't strip it when it re-saves the store)

  // ── One-time migration: move _savedAt out of the store into its own key ──
  (function migrate() {
    try {
      if (localStorage.getItem(SAVED_AT_KEY)) return; // already migrated
      var s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (s && s._savedAt) {
        localStorage.setItem(SAVED_AT_KEY, String(s._savedAt));
      }
    } catch (e) {}
  })();

  // Block pushes until cloud check completes (prevents seed data racing to cloud).
  var _pushReady = !!sessionStorage.getItem(CHECKED);

  // Last-pushed content fingerprint — only written by push(), never pre-loaded from store.
  var _lastPushedFp = (function () {
    try { return localStorage.getItem(FP_KEY) || null; } catch (e) { return null; }
  })();

  function _fingerprint(store) {
    var c = Object.assign({}, store);
    delete c._savedAt; // strip in case it leaked in
    return JSON.stringify(c);
  }

  // ── Patch localStorage.setItem immediately ────────────────────────────────
  var _set = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    _set.call(this, key, value);
    if (this === localStorage && key === STORE_KEY && _pushReady) {
      push(value, false);
    }
  };

  // Push store to cloud.
  // We do NOT embed _savedAt into the store — it lives in SAVED_AT_KEY instead.
  // force=true bypasses the unchanged-content guard.
  function push(storeJson, force) {
    try {
      var store = JSON.parse(storeJson);
      if (!store) return;
      var fp = _fingerprint(store);
      if (!force && _lastPushedFp !== null && fp === _lastPushedFp) {
        console.log('[sync] content unchanged — skipping push');
        return;
      }
      _lastPushedFp = fp;
      try { _set.call(localStorage, FP_KEY, fp); } catch (e) {}
      var savedAt = Date.now();
      try { _set.call(localStorage, SAVED_AT_KEY, String(savedAt)); } catch (e) {}
      // Send store to API with _savedAt embedded only for cloud comparison;
      // we do NOT rewrite STORE_KEY here — the app owns that key.
      var cloudPayload = Object.assign({}, store, { _savedAt: savedAt });
      console.log('[sync] push → PUT /api/data  _savedAt=' + savedAt);
      fetch(API, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ store: cloudPayload })
      }).then(function (r) {
        console.log('[sync] PUT response:', r.status);
      }).catch(function (e) {
        console.error('[sync] PUT failed:', e.message);
      });
    } catch (e) { console.error('[sync] push error:', e); }
  }

  // Write cloud data to localStorage and update all sync metadata.
  // Strips _savedAt from what we write to STORE_KEY so the app never sees it.
  function _applyCloudData(cloudStore) {
    var cloudSavedAt = cloudStore._savedAt || Date.now();
    var storeOnly = Object.assign({}, cloudStore);
    delete storeOnly._savedAt;
    _set.call(localStorage, STORE_KEY, JSON.stringify(storeOnly));
    _set.call(localStorage, SAVED_AT_KEY, String(cloudSavedAt));
    var fp = _fingerprint(storeOnly);
    _set.call(localStorage, FP_KEY, fp);
    _lastPushedFp = fp;
  }

  // ── Check cloud once per tab session ─────────────────────────────────────
  async function checkCloud(force) {
    if (!force && sessionStorage.getItem(CHECKED)) return null;
    sessionStorage.setItem(CHECKED, '1');

    var res;
    try { res = await fetch(API); } catch (e) {
      return { error: 'Network error: ' + e.message };
    }

    if (res.status === 401) return 'unauthed';
    if (!res.ok) {
      var body = '';
      try { body = await res.text(); } catch (e) {}
      return { error: 'API error ' + res.status + (body ? ': ' + body.slice(0, 120) : '') };
    }

    var payload;
    try { payload = await res.json(); } catch (e) {
      return { error: 'API returned non-JSON (functions may not be deployed yet)' };
    }

    // localSavedAt comes from SAVED_AT_KEY, not from inside the store.
    var localSavedAt = Number(localStorage.getItem(SAVED_AT_KEY) || 0);
    var localRaw = localStorage.getItem(STORE_KEY);

    if (!payload || !payload.store) {
      console.log('[sync] cloud empty — force-pushing local data (localSavedAt=' + localSavedAt + ')');
      if (localRaw) push(localRaw, true);
      return null;
    }

    var cloudSavedAt = Number(payload.store._savedAt) || 0;
    console.log('[sync] cloudSavedAt=' + cloudSavedAt + '  localSavedAt=' + localSavedAt);

    if (localSavedAt === 0) {
      console.log('[sync] no local save timestamp — silently loading cloud data');
      _applyCloudData(payload.store);
      return { silentReload: true };
    }

    if (cloudSavedAt > localSavedAt) {
      console.log('[sync] cloud is newer — showing banner');
      return { newerStore: payload.store };
    }

    if (localSavedAt > cloudSavedAt) {
      console.log('[sync] local is newer — pushing up');
      if (localRaw) push(localRaw, true);
    }

    return null;
  }

  // ── Banner: shown when cloud has newer data ───────────────────────────────
  function showUpdateBanner(cloudStore) {
    var bar = document.createElement('div');
    bar.id  = 'ft-sync-bar';
    bar.style.cssText = [
      'position:fixed;top:0;left:0;right:0;z-index:99999',
      'background:#0F6CBD;color:#fff',
      'padding:10px 16px;display:flex;align-items:center;justify-content:space-between',
      'font:13px/1.4 system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.25)',
      'gap:12px'
    ].join(';');

    bar.innerHTML = [
      '<span>☁&nbsp; Newer data is available from another device.</span>',
      '<div style="display:flex;gap:8px;flex-shrink:0">',
        '<button id="ft-load" style="background:#fff;color:#0F6CBD;border:none;',
          'padding:5px 14px;border-radius:6px;font:600 13px system-ui;cursor:pointer">',
          'Load latest</button>',
        '<button id="ft-keep" style="background:transparent;color:rgba(255,255,255,.85);',
          'border:1px solid rgba(255,255,255,.5);padding:5px 14px;border-radius:6px;',
          'font:13px system-ui;cursor:pointer">',
          'Keep my changes</button>',
      '</div>'
    ].join('');

    document.body.prepend(bar);

    document.getElementById('ft-load').onclick = function () {
      _applyCloudData(cloudStore);
      location.reload();
    };

    document.getElementById('ft-keep').onclick = function () {
      bar.remove();
      var localRaw = localStorage.getItem(STORE_KEY);
      if (localRaw) push(localRaw, true);
    };
  }

  // ── Status badge (bottom-right) ───────────────────────────────────────────
  async function renderBadge() {
    var badge = document.createElement('div');
    badge.style.cssText = [
      'position:fixed;bottom:14px;right:14px;z-index:9990',
      'font:11px/1 system-ui,sans-serif;padding:6px 12px',
      'background:#fff;border:1px solid #e5e7eb;border-radius:20px',
      'box-shadow:0 2px 8px rgba(0,0,0,.1);cursor:default;user-select:none'
    ].join(';');
    badge.textContent = '☁ connecting…';
    badge.style.color = '#9ca3af';
    document.body.appendChild(badge);

    try {
      var meRes  = await fetch('/.auth/me');
      var meData = await meRes.json();
      var user   = meData && meData.clientPrincipal;
      console.log('[sync] clientPrincipal:', JSON.stringify(user));

      if (!user) {
        badge.textContent  = '☁ Sign in to sync';
        badge.style.color  = '#ef4444';
        badge.style.cursor = 'pointer';
        badge.style.border = '1px solid #fca5a5';
        badge.title = 'Tap to sign in with your Microsoft account';
        badge.onclick = function () {
          location.href = '/.auth/login/aad?post_login_redirect_uri='
            + encodeURIComponent(location.pathname);
        };
        return;
      }

      // savedAt is now in its own key, not inside the store.
      var savedAt = Number(localStorage.getItem(SAVED_AT_KEY) || 0);

      if (savedAt) {
        var d = new Date(savedAt);
        badge.textContent = '☁ saved ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        badge.style.color = '#22c55e';
        badge.title = 'Signed in as ' + (user.userDetails || user.userId)
          + '\nUser ID: ' + user.userId
          + '\nLast saved: ' + d.toLocaleString()
          + '\n\nTap to check for updates from other devices';
      } else {
        badge.textContent = '☁ signed in';
        badge.style.color = '#22c55e';
        badge.title = 'Signed in as ' + (user.userDetails || user.userId)
          + '\nUser ID: ' + user.userId;
      }

      badge.style.cursor = 'pointer';
      badge.onclick = async function () {
        badge.textContent = '☁ checking…';
        badge.style.color = '#9ca3af';
        var result = await checkCloud(true);
        if (result && result.newerStore) {
          showUpdateBanner(result.newerStore);
          badge.textContent = '☁ update ready — see banner above';
          badge.style.color = '#f59e0b';
        } else if (result && result.error) {
          badge.textContent = '☁ sync error — tap for details';
          badge.style.color = '#ef4444';
          badge.title = result.error + '\n\nTest API directly: ' + location.origin + '/api/data';
          console.error('[sync]', result.error);
        } else if (result === 'unauthed') {
          badge.textContent = '☁ Sign in to sync';
          badge.style.color = '#ef4444';
          badge.onclick = function () { location.href = '/.auth/login/aad'; };
        } else {
          badge.textContent = '☁ up to date';
          badge.style.color = '#22c55e';
        }
      };

    } catch (e) {
      badge.textContent = '☁ offline';
      badge.style.color = '#9ca3af';
    }
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', async function () {
    var result = await checkCloud();

    if (result === 'unauthed') {
      // badge handles this
    } else if (result && result.silentReload) {
      location.reload();
      return;
    } else if (result && result.newerStore) {
      showUpdateBanner(result.newerStore);
    }

    _pushReady = true;
    console.log('[sync] _pushReady = true');

    // If the app wrote to STORE_KEY before pushes were allowed (seed data with no
    // saved timestamp yet), push it now so it reaches the cloud.
    if (!localStorage.getItem(SAVED_AT_KEY)) {
      var pendingRaw = localStorage.getItem(STORE_KEY);
      if (pendingRaw) {
        console.log('[sync] pushing pending data (no saved timestamp yet)');
        push(pendingRaw, true);
      }
    }

    setTimeout(renderBadge, 800);
  });
})();

(function () {
  'use strict';

  var API        = '/api/data';
  var STORE_KEY  = 'fintrack_v2';
  var CHECKED    = 'ft_checked'; // sessionStorage — one cloud check per tab lifetime

  // ── Patch localStorage.setItem immediately ────────────────────────────────
  // Runs synchronously before DOMContentLoaded so every app save auto-pushes.
  var _set = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    _set.call(this, key, value);
    if (this === localStorage && key === STORE_KEY) {
      push(value);
    }
  };

  // Embed _savedAt inside the store JSON so the timestamp travels with the data.
  function push(storeJson) {
    try {
      var store = JSON.parse(storeJson);
      if (!store) return;
      store._savedAt = Date.now();
      // Write stamped copy back to localStorage without triggering patch again
      _set.call(localStorage, STORE_KEY, JSON.stringify(store));
      fetch(API, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ store: store })
      }).catch(function () {});
    } catch (e) {}
  }

  // ── Check cloud once per tab session ─────────────────────────────────────
  // Returns: null | 'unauthed' | { newerStore } | { error: msg }
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

    if (!payload || !payload.store) {
      // Cloud empty — push local data up
      var localRaw = localStorage.getItem(STORE_KEY);
      if (localRaw) push(localRaw);
      return null;
    }

    var cloudSavedAt = Number(payload.store._savedAt) || 0;
    var localStore   = null;
    try { localStore = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) {}
    var localSavedAt = Number((localStore && localStore._savedAt) || 0);

    if (cloudSavedAt > localSavedAt) {
      return { newerStore: payload.store };
    }
    if (localSavedAt > cloudSavedAt) {
      push(localStorage.getItem(STORE_KEY));
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

    // "Load latest" — user explicitly chooses to apply cloud data
    document.getElementById('ft-load').onclick = function () {
      _set.call(localStorage, STORE_KEY, JSON.stringify(cloudStore));
      location.reload();
    };

    // "Keep mine" — dismiss banner and push local data up to cloud
    document.getElementById('ft-keep').onclick = function () {
      bar.remove();
      var localRaw = localStorage.getItem(STORE_KEY);
      if (localRaw) push(localRaw);
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

      // Signed in — show last save time from local store
      var localStore = null;
      try { localStore = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) {}
      var savedAt = localStore && localStore._savedAt;

      if (savedAt) {
        var d = new Date(savedAt);
        badge.textContent = '☁ saved ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        badge.style.color = '#22c55e';
        badge.title = 'Signed in as ' + (user.userDetails || user.userId)
          + '\nLast saved: ' + d.toLocaleString()
          + '\n\nTap to check for updates from other devices';
      } else {
        badge.textContent = '☁ signed in';
        badge.style.color = '#22c55e';
        badge.title = 'Signed in as ' + (user.userDetails || user.userId);
      }

      // Tap badge to manually pull latest from cloud
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
      // Will be handled by the badge (sign-in prompt)
    } else if (result && result.newerStore) {
      showUpdateBanner(result.newerStore);
    }

    setTimeout(renderBadge, 800);
  });
})();

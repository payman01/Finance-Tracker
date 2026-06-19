(function () {
  'use strict';

  var API          = '/api/data';
  var STORE_KEY    = 'fintrack_v2';
  var CHECKED      = 'ft_checked';   // sessionStorage — cloud checked this tab
  var FP_KEY       = 'ft_sync_fp';   // localStorage — fingerprint written ONLY after successful PUT
  var SAVED_AT_KEY = 'ft_saved_at';  // localStorage — timestamp, separate from store so app can't strip it

  // ── One-time migration: move _savedAt out of the store into its own key ──
  (function migrate() {
    try {
      if (localStorage.getItem(SAVED_AT_KEY)) return;
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var s = JSON.parse(raw);
      if (s && s._savedAt) {
        localStorage.setItem(SAVED_AT_KEY, String(s._savedAt));
      }
    } catch (e) {}
  })();

  // Block pushes until cloud check completes on new sessions.
  var _pushReady = !!sessionStorage.getItem(CHECKED);

  // In-memory fingerprint of last content we TRIED to push.
  // Only persisted to FP_KEY after a successful PUT response.
  var _lastPushedFp = (function () {
    try { return localStorage.getItem(FP_KEY) || null; } catch (e) { return null; }
  })();

  function _fingerprint(store) {
    var c = Object.assign({}, store);
    delete c._savedAt;
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
  // FP_KEY is written ONLY after a successful PUT so a failed push can be retried.
  function push(storeJson, force) {
    try {
      var store = JSON.parse(storeJson);
      if (!store) return;
      var fp = _fingerprint(store);
      if (!force && _lastPushedFp !== null && fp === _lastPushedFp) {
        console.log('[sync] content unchanged — skipping push');
        return;
      }
      _lastPushedFp = fp; // optimistically block duplicates in-flight
      var savedAt = Date.now();
      try { _set.call(localStorage, SAVED_AT_KEY, String(savedAt)); } catch (e) {}
      var cloudPayload = Object.assign({}, store, { _savedAt: savedAt });
      console.log('[sync] push → PUT /api/data  savedAt=' + savedAt);
      fetch(API, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ store: cloudPayload })
      }).then(function (r) {
        if (r.ok) {
          // Only persist fingerprint after confirmed cloud write
          try { _set.call(localStorage, FP_KEY, fp); } catch (e) {}
          console.log('[sync] PUT 200 ✓');
        } else {
          _lastPushedFp = null; // allow retry
          console.error('[sync] PUT failed status:', r.status);
        }
      }).catch(function (e) {
        _lastPushedFp = null; // allow retry on network error
        console.error('[sync] PUT network error:', e.message);
      });
    } catch (e) { console.error('[sync] push error:', e); }
  }

  // Write cloud data to localStorage; strip _savedAt from store so app state stays clean.
  function _applyCloudData(cloudStore) {
    var cloudSavedAt = cloudStore._savedAt || Date.now();
    var storeOnly = Object.assign({}, cloudStore);
    delete storeOnly._savedAt;
    _set.call(localStorage, STORE_KEY, JSON.stringify(storeOnly));
    _set.call(localStorage, SAVED_AT_KEY, String(cloudSavedAt));
    var fp = _fingerprint(storeOnly);
    _set.call(localStorage, FP_KEY, fp);
    _lastPushedFp = fp;
    console.log('[sync] cloud data applied, savedAt=' + cloudSavedAt);
  }

  // ── Check cloud ───────────────────────────────────────────────────────────
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

    var localSavedAt = Number(localStorage.getItem(SAVED_AT_KEY) || 0);
    var localRaw = localStorage.getItem(STORE_KEY);
    console.log('[sync] checkCloud: localSavedAt=' + localSavedAt);

    if (!payload || !payload.store) {
      console.log('[sync] cloud empty — force-pushing local data');
      if (localRaw) push(localRaw, true);
      return null;
    }

    var cloudSavedAt = Number(payload.store._savedAt) || 0;
    console.log('[sync] cloudSavedAt=' + cloudSavedAt + '  localSavedAt=' + localSavedAt);

    if (localSavedAt === 0) {
      console.log('[sync] no local timestamp — loading cloud data silently');
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

  // ── Banner ────────────────────────────────────────────────────────────────
  function showUpdateBanner(cloudStore) {
    if (document.getElementById('ft-sync-bar')) return;
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

  // ── User profile panel ────────────────────────────────────────────────────
  function renderProfile(user) {
    if (document.getElementById('ft-profile-btn')) return;

    var initials = (user.userDetails || '?')
      .split('@')[0].split('.').map(function (p) { return p[0] || ''; }).join('').toUpperCase().slice(0, 2);

    var btn = document.createElement('div');
    btn.id = 'ft-profile-btn';
    btn.style.cssText = [
      'position:fixed;top:12px;right:14px;z-index:9995',
      'width:34px;height:34px;border-radius:50%;background:#0F6CBD;color:#fff',
      'font:600 13px system-ui;display:flex;align-items:center;justify-content:center',
      'cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.25);user-select:none',
      'border:2px solid #fff'
    ].join(';');
    btn.textContent = initials || '?';
    btn.title = user.userDetails || user.userId;
    document.body.appendChild(btn);

    var panel = document.createElement('div');
    panel.id = 'ft-profile-panel';
    panel.style.cssText = [
      'position:fixed;top:54px;right:14px;z-index:9994',
      'background:#fff;border:1px solid #e5e7eb;border-radius:12px',
      'box-shadow:0 4px 20px rgba(0,0,0,.15);padding:16px;min-width:220px',
      'font:13px/1.5 system-ui,sans-serif;display:none'
    ].join(';');

    var savedAt = Number(localStorage.getItem(SAVED_AT_KEY) || 0);
    var savedStr = savedAt ? new Date(savedAt).toLocaleString() : 'Not yet synced';

    panel.innerHTML = [
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">',
        '<div style="width:40px;height:40px;border-radius:50%;background:#0F6CBD;color:#fff;',
          'font:600 15px system-ui;display:flex;align-items:center;justify-content:center;flex-shrink:0">',
          initials || '?',
        '</div>',
        '<div>',
          '<div style="font-weight:600;color:#111">' + (user.userDetails || 'Unknown') + '</div>',
          '<div style="color:#6b7280;font-size:11px">Microsoft account</div>',
        '</div>',
      '</div>',
      '<div style="border-top:1px solid #f3f4f6;padding-top:10px;margin-bottom:10px">',
        '<div style="color:#6b7280;font-size:11px;margin-bottom:2px">Last synced</div>',
        '<div style="color:#374151;font-size:12px">' + savedStr + '</div>',
      '</div>',
      '<button id="ft-sync-now" style="width:100%;padding:7px;margin-bottom:6px;',
        'background:#f0f7ff;color:#0F6CBD;border:1px solid #bfdbfe;border-radius:7px;',
        'font:600 12px system-ui;cursor:pointer">',
        '☁ Sync now',
      '</button>',
      '<a href="/.auth/logout?post_logout_redirect_uri=/" style="display:block;text-align:center;',
        'padding:7px;background:#fef2f2;color:#dc2626;border:1px solid #fecaca;border-radius:7px;',
        'font:600 12px system-ui;text-decoration:none">',
        'Sign out',
      '</a>',
    ].join('');

    document.body.appendChild(panel);

    btn.onclick = function (e) {
      e.stopPropagation();
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    };
    document.addEventListener('click', function () {
      panel.style.display = 'none';
    });

    document.getElementById('ft-sync-now').onclick = async function (e) {
      e.stopPropagation();
      this.textContent = '☁ Checking…';
      var result = await checkCloud(true);
      if (result && result.newerStore) {
        showUpdateBanner(result.newerStore);
        this.textContent = '☁ Update ready — see banner';
      } else if (result && result.error) {
        this.textContent = '⚠ ' + result.error.slice(0, 40);
      } else {
        this.textContent = '☁ Up to date ✓';
        setTimeout(function () {
          var b = document.getElementById('ft-sync-now');
          if (b) b.textContent = '☁ Sync now';
        }, 2000);
      }
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

      renderProfile(user);

      var savedAt = Number(localStorage.getItem(SAVED_AT_KEY) || 0);
      if (savedAt) {
        var d = new Date(savedAt);
        badge.textContent = '☁ saved ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        badge.style.color = '#22c55e';
        badge.title = 'Last saved: ' + d.toLocaleString() + '\nTap to sync now';
      } else {
        badge.textContent = '☁ signed in';
        badge.style.color = '#22c55e';
        badge.title = 'Tap to sync';
      }

      badge.style.cursor = 'pointer';
      badge.onclick = async function () {
        badge.textContent = '☁ checking…';
        badge.style.color = '#9ca3af';
        var result = await checkCloud(true);
        if (result && result.newerStore) {
          showUpdateBanner(result.newerStore);
          badge.textContent = '☁ update ready';
          badge.style.color = '#f59e0b';
        } else if (result && result.error) {
          badge.textContent = '☁ error';
          badge.style.color = '#ef4444';
          badge.title = result.error;
          console.error('[sync]', result.error);
        } else if (result === 'unauthed') {
          badge.textContent = '☁ Sign in';
          badge.style.color = '#ef4444';
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
      // badge/profile will show sign-in
    } else if (result && result.silentReload) {
      location.reload();
      return;
    } else if (result && result.newerStore) {
      showUpdateBanner(result.newerStore);
    }

    _pushReady = true;
    console.log('[sync] _pushReady = true');

    // Force push if we have local data but no confirmed cloud save yet.
    if (!localStorage.getItem(SAVED_AT_KEY)) {
      var pendingRaw = localStorage.getItem(STORE_KEY);
      if (pendingRaw) {
        console.log('[sync] no saved timestamp — force-pushing local data');
        push(pendingRaw, true);
      }
    }

    setTimeout(renderBadge, 600);
  });
})();

(function () {
  'use strict';

  var API          = '/api/data';
  var STORE_KEY    = 'fintrack_v2';
  var CHECKED      = 'ft_checked';   // sessionStorage — cloud checked this tab session
  var FP_KEY       = 'ft_sync_fp';   // localStorage — written ONLY after confirmed PUT 200
  var SAVED_AT_KEY = 'ft_saved_at';  // localStorage — timestamp of last confirmed save

  // ── Loading overlay ───────────────────────────────────────────────────────
  // Show immediately so the user never sees seed/default data before cloud loads.
  // Only created on fresh sessions (not on same-tab reloads where CHECKED is set).
  var _overlay = null;
  if (!sessionStorage.getItem(CHECKED)) {
    try {
      _overlay = document.createElement('div');
      _overlay.id = 'ft-loading';
      _overlay.style.cssText = [
        'position:fixed;inset:0;z-index:99998',
        'background:#f3f4f7;display:flex;align-items:center;justify-content:center',
        'font:13px/1 system-ui,sans-serif;color:#9ca3af'
      ].join(';');
      _overlay.textContent = '☁ Loading…';
      document.documentElement.appendChild(_overlay);
    } catch (e) { _overlay = null; }
  }

  function _removeOverlay() {
    if (!_overlay) return;
    try { _overlay.remove(); } catch (e) {}
    _overlay = null;
  }

  // ── One-time migration: move _savedAt out of store into its own key ───────
  (function migrate() {
    try {
      if (localStorage.getItem(SAVED_AT_KEY)) return;
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var s = JSON.parse(raw);
      if (s && s._savedAt) localStorage.setItem(SAVED_AT_KEY, String(s._savedAt));
    } catch (e) {}
  })();

  // _pushReady: true on same-tab reloads (CHECKED in sessionStorage), false otherwise
  var _pushReady   = !!sessionStorage.getItem(CHECKED);
  var _lastPushedFp = (function () {
    try { return localStorage.getItem(FP_KEY) || null; } catch (e) { return null; }
  })();
  var _badge              = null;
  var _hasUnsavedChanges  = false;

  // ── Start cloud fetch IMMEDIATELY (before DOMContentLoaded) ──────────────
  // Table Storage round-trips take ~100–200 ms. Starting here gives the fetch
  // time to complete before the Babel-compiled React scripts finish initialising.
  // On same-tab reloads the cloud was already checked, so skip the fetch.
  var _cloudFetch = sessionStorage.getItem(CHECKED)
    ? null
    : (function () {
        try {
          return fetch(API)
            .then(function (r) { return r.ok ? r.json() : null; })
            .catch(function ()  { return null; });
        } catch (e) { return Promise.resolve(null); }
      })();

  // ── Helpers ───────────────────────────────────────────────────────────────
  var _set = Storage.prototype.setItem;

  function _fingerprint(store) {
    var c = Object.assign({}, store);
    delete c._savedAt;
    return JSON.stringify(c);
  }

  // Returns true if the cloud store should replace local data.
  //
  // Old rule: cloud wins if cloudSavedAt > localSavedAt.
  // Problem: localSavedAt is a client clock — a stale tab that hasn't been
  // touched in days still gets Date.now() on its next push, and can win
  // over genuinely newer cloud data.
  //
  // New rule:
  //   1. If local fingerprint == cloud fingerprint → already in sync, no action.
  //   2. If local is "clean" (fingerprint matches last confirmed sync FP_KEY,
  //      i.e. the user has made no local changes since the last confirmed push
  //      or cloud-apply) → cloud always wins regardless of timestamps.
  //   3. If local has real unsaved changes → timestamps decide.
  //
  // This means a stale open tab (fingerprint unchanged = clean) can never
  // overwrite good cloud data.
  function _cloudShouldWin(cloudStore) {
    if (!cloudStore) return false;
    var cloudFp = _fingerprint(cloudStore);
    var localRaw = localStorage.getItem(STORE_KEY);
    var localStore = null;
    try { if (localRaw) localStore = JSON.parse(localRaw); } catch (e) {}
    var localFpCurrent = localStore ? _fingerprint(localStore) : null;

    if (localFpCurrent === cloudFp) return false; // already identical — nothing to do

    var localFpStored = localStorage.getItem(FP_KEY);
    // "clean" = local hasn't changed since last confirmed sync (or never synced)
    var localIsClean = !localFpStored || localFpStored === localFpCurrent;
    if (localIsClean) return true; // cloud has different data; local is unmodified → cloud wins

    // Local has real unsaved changes — fall back to timestamps
    var cloudSavedAt  = Number(cloudStore._savedAt  || 0);
    var localSavedAt  = Number(localStorage.getItem(SAVED_AT_KEY) || 0);
    return cloudSavedAt > localSavedAt;
  }

  function _updateBadge(text, color) {
    if (!_badge) return;
    _badge.textContent = text;
    _badge.style.color = color || '#9ca3af';
  }

  // ── Patch localStorage.setItem to auto-push on app writes ────────────────
  Storage.prototype.setItem = function (key, value) {
    _set.call(this, key, value);
    if (this === localStorage && key === STORE_KEY && _pushReady) {
      push(value, false);
    }
  };

  // ── Apply cloud data to localStorage ─────────────────────────────────────
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

  // ── Push store to cloud ───────────────────────────────────────────────────
  function push(storeJson, force) {
    try {
      var store = JSON.parse(storeJson);
      if (!store) return;
      var fp = _fingerprint(store);
      if (!force && _lastPushedFp !== null && fp === _lastPushedFp) return;
      _lastPushedFp = fp;
      _hasUnsavedChanges = true;
      _updateBadge('☁ saving…', '#f59e0b');
      var savedAt = Date.now();
      try { _set.call(localStorage, SAVED_AT_KEY, String(savedAt)); } catch (e) {}
      var cloudPayload = Object.assign({}, store, { _savedAt: savedAt });
      console.log('[sync] push → PUT /api/data  savedAt=' + savedAt);
      fetch(API, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ store: cloudPayload }),
        keepalive: true
      }).then(function (r) {
        return r.json().then(function (body) {
          if (r.ok && body && body.ok) {
            try { _set.call(localStorage, FP_KEY, fp); } catch (e) {}
            _hasUnsavedChanges = false;
            var d = new Date();
            _updateBadge('☁ saved ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), '#22c55e');
            console.log('[sync] PUT 200 ✓');
          } else {
            _lastPushedFp = null;
            _updateBadge('⚠ save failed — will retry', '#ef4444');
            console.error('[sync] PUT unexpected response:', r.status, body);
          }
        }).catch(function () {
          // Response wasn't JSON (e.g. a redirect to the login page returned HTML)
          _lastPushedFp = null;
          _updateBadge('⚠ save failed — will retry', '#ef4444');
          console.error('[sync] PUT non-JSON response (auth issue?), status:', r.status);
        });
      }).catch(function (e) {
        _lastPushedFp = null;
        _updateBadge('⚠ offline — will retry', '#9ca3af');
        console.error('[sync] PUT error:', e.message);
      });
    } catch (e) { console.error('[sync] push error:', e); }
  }

  // ── Flush helper: push on tab hide / beforeunload / periodic ─────────────
  function _flushIfNeeded(label) {
    if (!_pushReady) return;
    if (!localStorage.getItem(FP_KEY)) {
      console.log('[sync] ' + label + ' flush skipped — no FP_KEY');
      return;
    }
    try {
      var localRaw = localStorage.getItem(STORE_KEY);
      if (!localRaw) return;
      var store = JSON.parse(localRaw);
      if (!store) return;
      var fp = _fingerprint(store);
      if (fp === localStorage.getItem(FP_KEY)) return;
      var savedAt = Date.now();
      _set.call(localStorage, SAVED_AT_KEY, String(savedAt));
      var cloudPayload = Object.assign({}, store, { _savedAt: savedAt });
      console.log('[sync] ' + label + ' flush — keepalive PUT');
      fetch(API, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ store: cloudPayload }),
        keepalive: true
      }).then(function (r) {
        if (r.ok) try { _set.call(localStorage, FP_KEY, fp); } catch (e) {}
      }).catch(function () {});
    } catch (e) {}
  }

  // ── DOMContentLoaded — main sync logic ───────────────────────────────────
  document.addEventListener('DOMContentLoaded', async function () {

    // Same-tab reload: cloud was already checked this session. Just enable pushes.
    if (_cloudFetch === null) {
      _pushReady = true;
      console.log('[sync] same-tab reload — skipping cloud check, _pushReady=true');
      setTimeout(renderBadge, 600);
      return;
    }

    // Await the prefetch (probably already in-flight or done)
    var payload = await _cloudFetch;
    sessionStorage.setItem(CHECKED, '1');

    var localRaw     = localStorage.getItem(STORE_KEY);
    var localSavedAt = Number(localStorage.getItem(SAVED_AT_KEY) || 0);
    var hasFP        = !!localStorage.getItem(FP_KEY);

    console.log('[sync] checkCloud: payload=' + (payload ? 'yes' : 'null') +
                ' localSavedAt=' + localSavedAt + ' hasFP=' + hasFP);

    if (!payload || !payload.store) {
      // Cloud empty or unreachable. Use local data and enable pushes.
      _pushReady = true;
      _removeOverlay();
      if (localRaw && localSavedAt > 0) {
        console.log('[sync] cloud empty — re-pushing local data');
        push(localRaw, true);
      } else {
        console.log('[sync] cloud empty, no confirmed local — starting fresh');
      }
      setTimeout(renderBadge, 600);
      return;
    }

    var cloudSavedAt  = Number(payload.store._savedAt || 0);
    var cloudFp       = _fingerprint(payload.store);
    var localFpStored = localStorage.getItem(FP_KEY);
    var localStore    = null;
    try { if (localRaw) localStore = JSON.parse(localRaw); } catch (e) {}
    var localFpCurrent = localStore ? _fingerprint(localStore) : null;
    var localIsClean   = !localFpStored || localFpStored === localFpCurrent;
    console.log('[sync] cloudSavedAt=' + cloudSavedAt + ' localSavedAt=' + localSavedAt
      + ' localIsClean=' + localIsClean + ' sameContent=' + (localFpCurrent === cloudFp));

    if (_cloudShouldWin(payload.store)) {
      console.log('[sync] cloud wins — applying and reloading');
      _applyCloudData(payload.store);
      location.reload();
      return;
    }

    if (localFpCurrent === cloudFp) {
      console.log('[sync] already in sync with cloud');
    } else {
      console.log('[sync] local has unsaved changes and is newer — pushing up');
      if (localRaw) push(localRaw, true);
    }

    _pushReady = true;
    _removeOverlay();
    setTimeout(renderBadge, 600);
  });

  // ── Profile panel ─────────────────────────────────────────────────────────
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
      '<a href="/.auth/logout?post_logout_redirect_uri=/signed-out" style="display:block;text-align:center;',
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
    document.addEventListener('click', function () { panel.style.display = 'none'; });

    document.getElementById('ft-sync-now').onclick = async function (e) {
      e.stopPropagation();
      var btn = this;
      btn.textContent = '☁ Checking…';
      try {
        var r = await fetch(API);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var payload = await r.json();
        if (payload && _cloudShouldWin(payload.store)) {
          _applyCloudData(payload.store);
          location.reload();
          return;
        }
        btn.textContent = '☁ Up to date ✓';
      } catch (ex) {
        btn.textContent = '⚠ ' + ex.message.slice(0, 30);
      }
      setTimeout(function () {
        var b = document.getElementById('ft-sync-now');
        if (b) b.textContent = '☁ Sync now';
      }, 2000);
    };
  }

  // ── Status badge ──────────────────────────────────────────────────────────
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
    _badge = badge;

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
        badge.onclick = function () {
          location.href = '/.auth/login/aad?post_login_redirect_uri=' + encodeURIComponent(location.pathname);
        };
        return;
      }

      renderProfile(user);

      var savedAt = Number(localStorage.getItem(SAVED_AT_KEY) || 0);
      if (savedAt) {
        var d = new Date(savedAt);
        badge.textContent = '☁ saved ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        badge.style.color = '#22c55e';
        badge.title = 'Last saved: ' + d.toLocaleString();
      } else {
        badge.textContent = '☁ signed in';
        badge.style.color = '#22c55e';
      }

      badge.style.cursor = 'pointer';
      badge.onclick = async function () {
        badge.textContent = '☁ checking…';
        badge.style.color = '#9ca3af';
        try {
          var r = await fetch(API);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          var payload = await r.json();
          if (payload && _cloudShouldWin(payload.store)) {
            _applyCloudData(payload.store);
            location.reload();
            return;
          }
          badge.textContent = '☁ up to date';
          badge.style.color = '#22c55e';
        } catch (ex) {
          badge.textContent = '⚠ error';
          badge.style.color = '#ef4444';
          badge.title = ex.message;
        }
      };

    } catch (e) {
      badge.textContent = '☁ offline';
      badge.style.color = '#9ca3af';
    }
  }

  // ── Flush on tab close / hide / periodic ─────────────────────────────────
  window.addEventListener('beforeunload', function (e) {
    // Fire blur on any focused add-item input so React's onBlur handler runs commitAdd
    // before the page unloads (handles Cmd+R while the user is still typing).
    var active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
      try { active.blur(); } catch (_) {}
    }
    _flushIfNeeded('beforeunload');
    if (_hasUnsavedChanges) { e.preventDefault(); e.returnValue = ''; }
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') _flushIfNeeded('visibilitychange');
  });

  setInterval(function () { _flushIfNeeded('interval'); }, 30000);

  // ── Poll cloud every 60 s for updates from other devices ─────────────────
  // If a newer version exists, flash the badge so the user can click to refresh.
  setInterval(function () {
    if (!_pushReady) return;           // still in initial cloud-check phase
    if (document.hidden) return;       // don't poll while tab is hidden
    fetch(API)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (payload) {
        if (!payload || !payload.store) return;
        var cloudSavedAt = Number(payload.store._savedAt || 0);
        var localSavedAt = Number(localStorage.getItem(SAVED_AT_KEY) || 0);
        // Only notify if cloud is genuinely newer by >2s (grace to avoid self-notifications)
        // AND would win under the new fingerprint-based logic
        if (cloudSavedAt > localSavedAt + 2000 && _cloudShouldWin(payload.store)) {
          console.log('[sync] poll: cloud is newer (' + cloudSavedAt + ' > ' + localSavedAt + ') — notifying');
          _updateBadge('☁ update available — click to refresh', '#0F6CBD');
          if (_badge) {
            _badge.style.cursor = 'pointer';
            _badge.onclick = function () {
              _applyCloudData(payload.store);
              location.reload();
            };
          }
        }
      })
      .catch(function () {}); // silent on error
  }, 60000);

  // ── Diagnostic: log what Dashboard/Compare compute after app initialises ──
  setTimeout(function () {
    try {
      if (!window.deriveView || !window.compute) {
        console.warn('[sync] diag: window.deriveView/compute missing — app scripts may not have loaded');
        return;
      }
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) { console.warn('[sync] diag: no store in localStorage'); return; }
      var st = JSON.parse(raw);
      if (!st || !st.currentMonth) { console.warn('[sync] diag: store has no currentMonth'); return; }
      var mk = localStorage.getItem('ft_month_v2') || st.currentMonth;
      var amtNow = (st.amounts || {})[mk] || {};
      var v = window.deriveView(st, mk);
      var c = window.compute(v);
      console.log('[sync] diag month=' + mk
        + ' amtKeys=' + Object.keys(amtNow).length
        + ' incomeNow=' + c.incomeNow.toFixed(0)
        + ' expenseNow=' + c.expenseNow.toFixed(0)
        + ' net=' + c.net.toFixed(0)
        + ' expense_cats=' + v.expenses.length
        + ' income_cats=' + v.income.length
        + ' deltas=' + c.deltas.length);
      (st.months || []).forEach(function (m) {
        var keys = Object.keys((st.amounts || {})[m] || {}).length;
        console.log('[sync] diag   ' + m + ': ' + keys + ' amount entries');
      });
    } catch (e) { console.error('[sync] diag error:', e.message); }
  }, 3000);

})();

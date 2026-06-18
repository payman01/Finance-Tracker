(function () {
  'use strict';

  var API       = '/api/data';
  var STORE_KEY = 'fintrack_v2';
  var SESSION_KEY = 'ft_cloud_synced';

  // Patch localStorage.setItem immediately so every app save also goes to cloud
  var _origSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    _origSetItem.call(this, key, value);
    if (this === localStorage && key === STORE_KEY) {
      pushToCloud(value);
    }
  };

  function pushToCloud(storeJson) {
    try {
      var store = JSON.parse(storeJson);
      fetch(API, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ store: store })
      }).catch(function () {});
    } catch (e) {}
  }

  // On load: fetch cloud data once per session and reload if it's newer
  async function syncOnLoad() {
    if (sessionStorage.getItem(SESSION_KEY)) return;
    sessionStorage.setItem(SESSION_KEY, '1');
    try {
      var res = await fetch(API);
      if (res.status === 401) {
        // Not logged in — SWA will redirect to Microsoft login automatically
        return;
      }
      if (!res.ok) return;

      var payload = await res.json();
      if (!payload || !payload.store) {
        // No cloud data yet — push local data up so it's saved
        var local = localStorage.getItem(STORE_KEY);
        if (local) pushToCloud(local);
        return;
      }

      // Cloud has data — check if it's newer than what's local
      var cloudTime = payload.updatedAt ? new Date(payload.updatedAt).getTime() : 0;
      var localTime = parseInt(localStorage.getItem('ft_last_save') || '0', 10);

      if (cloudTime > localTime) {
        _origSetItem.call(localStorage, STORE_KEY, JSON.stringify(payload.store));
        localStorage.setItem('ft_last_save', String(cloudTime));
        location.reload();
      }
    } catch (e) {}
  }

  // Track when we push so we can compare against cloud timestamp
  var _origPush = pushToCloud;
  pushToCloud = function (storeJson) {
    localStorage.setItem('ft_last_save', String(Date.now()));
    _origPush(storeJson);
  };

  // Minimal status badge (no sync code UI needed)
  async function showStatus() {
    var badge = document.createElement('div');
    badge.style.cssText = [
      'position:fixed;bottom:14px;right:14px;z-index:9990',
      'font:11px/1 system-ui,sans-serif;padding:5px 10px',
      'background:#fff;border:1px solid #e5e7eb;border-radius:20px',
      'box-shadow:0 2px 8px rgba(0,0,0,.08);color:#6b7280;cursor:default'
    ].join(';');
    badge.title = 'Checking cloud sync...';
    badge.textContent = '☁ syncing...';
    document.body.appendChild(badge);

    try {
      // Get logged-in user info
      var meRes = await fetch('/.auth/me');
      var me = await meRes.json();
      var user = me.clientPrincipal;

      if (!user) {
        badge.textContent = '☁ not signed in';
        badge.style.color = '#ef4444';
        badge.title = 'Click to sign in';
        badge.style.cursor = 'pointer';
        badge.onclick = function () { location.href = '/.auth/login/aad'; };
        return;
      }

      // Check last sync time
      var dataRes = await fetch(API);
      if (dataRes.ok) {
        var data = await dataRes.json();
        if (data && data.updatedAt) {
          var d = new Date(data.updatedAt);
          badge.textContent = '☁ synced ' + d.toLocaleTimeString();
          badge.style.color = '#22c55e';
          badge.title = 'Signed in as ' + (user.userDetails || user.userId) + ' · Last saved: ' + d.toLocaleString();
        } else {
          badge.textContent = '☁ signed in';
          badge.style.color = '#22c55e';
          badge.title = 'Signed in as ' + (user.userDetails || user.userId);
        }
      }
    } catch (e) {
      badge.textContent = '☁ offline';
      badge.style.color = '#9ca3af';
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    syncOnLoad();
    setTimeout(showStatus, 600);
  });
})();

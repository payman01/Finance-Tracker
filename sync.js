(function () {
  'use strict';

  var API       = '/api/data';
  var STORE_KEY = 'fintrack_v2';
  var SYNCED_FLAG = 'ft_synced_v2'; // sessionStorage key

  // ── Patch setItem immediately (runs before DOMContentLoaded) ─────────────
  // This ensures every app save also goes to cloud.
  var _set = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    _set.call(this, key, value);
    if (this === localStorage && key === STORE_KEY) {
      stampAndPush(value);
    }
  };

  // Embed _savedAt inside the store before pushing.
  // The timestamp lives WITH the data so comparisons are always reliable.
  function stampAndPush(storeJson) {
    try {
      var store = JSON.parse(storeJson);
      if (!store) return;
      store._savedAt = Date.now();
      // Write the stamp back to localStorage (bypasses patch to avoid recursion)
      _set.call(localStorage, STORE_KEY, JSON.stringify(store));
      // Fire-and-forget push to cloud
      fetch(API, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ store: store })
      }).catch(function () {});
    } catch (e) {}
  }

  // ── On page load: pull from cloud once per tab session ───────────────────
  async function syncOnLoad() {
    // Same tab/session already synced — skip to avoid overwriting in-progress work
    if (sessionStorage.getItem(SYNCED_FLAG)) return;
    sessionStorage.setItem(SYNCED_FLAG, '1');

    try {
      var res = await fetch(API);

      // Not logged in — SWA config will redirect to Microsoft login for page
      // navigation; here we just bail and let the status badge show sign-in UI
      if (res.status === 401 || res.status === 302) return;
      if (!res.ok) return;

      var payload = await res.json();

      if (!payload || !payload.store) {
        // Cloud is empty — push our local data up so it's saved
        var localRaw = localStorage.getItem(STORE_KEY);
        if (localRaw) stampAndPush(localRaw);
        return;
      }

      var cloudSavedAt = Number(payload.store._savedAt) || 0;
      var localSavedAt = 0;
      try {
        var localStore = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
        localSavedAt = Number((localStore && localStore._savedAt) || 0);
      } catch (e) {}

      if (cloudSavedAt > localSavedAt) {
        // Cloud has newer data — load it then reload so the app picks it up
        _set.call(localStorage, STORE_KEY, JSON.stringify(payload.store));
        location.reload();
      } else if (localSavedAt > cloudSavedAt) {
        // Local is newer — push it up (e.g. was offline, now back online)
        stampAndPush(localStorage.getItem(STORE_KEY));
      }
      // Equal: already in sync, nothing to do

    } catch (e) {}
  }

  // ── Status badge ─────────────────────────────────────────────────────────
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

    // Check auth status
    try {
      var meRes = await fetch('/.auth/me');
      var meData = await meRes.json();
      var user = meData && meData.clientPrincipal;

      if (!user) {
        // Not logged in — show sign-in prompt
        badge.textContent = '☁ Sign in to sync';
        badge.style.color = '#ef4444';
        badge.style.cursor = 'pointer';
        badge.style.borderColor = '#fca5a5';
        badge.title = 'Click to sign in with Microsoft';
        badge.onclick = function () { location.href = '/.auth/login/aad?post_login_redirect_uri=' + encodeURIComponent(location.pathname); };
        return;
      }

      // Logged in — show last sync time
      var dataRes = await fetch(API);
      if (dataRes.ok) {
        var data = await dataRes.json();
        if (data && data.store && data.store._savedAt) {
          var d = new Date(data.store._savedAt);
          badge.textContent = '☁ synced ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          badge.style.color = '#22c55e';
          badge.title = 'Signed in as ' + (user.userDetails || user.userId) + '\nLast saved: ' + d.toLocaleString();
        } else {
          badge.textContent = '☁ signed in';
          badge.style.color = '#22c55e';
          badge.title = 'Signed in as ' + (user.userDetails || user.userId);
        }
      }

      // Add manual pull button (long-press or right-click on badge to force pull)
      badge.title += '\n\nClick to force pull latest from cloud';
      badge.style.cursor = 'pointer';
      badge.onclick = function () {
        sessionStorage.removeItem(SYNCED_FLAG);
        location.reload();
      };

    } catch (e) {
      badge.textContent = '☁ offline';
      badge.style.color = '#9ca3af';
      badge.title = 'Cannot reach sync server';
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    syncOnLoad();
    setTimeout(renderBadge, 800);
  });
})();

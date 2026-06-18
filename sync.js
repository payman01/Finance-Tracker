(function () {
  'use strict';

  var API       = '/api/data';
  var STORE_KEY = 'fintrack_v2';
  var SYNC_KEY  = 'ft_sync_id';
  var SESSION_KEY = 'ft_synced_this_session';

  // ── Sync ID ──────────────────────────────────────────────
  function genId() {
    var arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    arr[6] = (arr[6] & 0x0f) | 0x40;
    arr[8] = (arr[8] & 0x3f) | 0x80;
    return Array.from(arr).map(function (b, i) {
      return ([4,6,8,10].indexOf(i) >= 0 ? '-' : '') + b.toString(16).padStart(2, '0');
    }).join('');
  }

  var syncId = localStorage.getItem(SYNC_KEY);
  if (!syncId) { syncId = genId(); localStorage.setItem(SYNC_KEY, syncId); }

  // ── Patch localStorage.setItem to push saves to cloud ────
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
        body: JSON.stringify({ syncId: syncId, store: store })
      }).catch(function () {});
    } catch (e) {}
  }

  // ── Pull from cloud on page load (once per session) ──────
  async function syncOnLoad() {
    if (sessionStorage.getItem(SESSION_KEY)) return;
    sessionStorage.setItem(SESSION_KEY, '1');
    try {
      var res = await fetch(API + '?syncId=' + encodeURIComponent(syncId));
      if (!res.ok) return;
      var payload = await res.json();
      if (!payload || !payload.store) return;

      var local = localStorage.getItem(STORE_KEY);
      if (!local) {
        // No local data — load from cloud and reload so the app picks it up fresh
        _origSetItem.call(localStorage, STORE_KEY, JSON.stringify(payload.store));
        location.reload();
        return;
      }

      // Both exist — compare updatedAt; cloud wins if newer
      var cloudTime = payload.updatedAt ? new Date(payload.updatedAt).getTime() : 0;
      var localMeta = localStorage.getItem('ft_last_push');
      var localTime = localMeta ? parseInt(localMeta, 10) : 0;
      if (cloudTime > localTime) {
        _origSetItem.call(localStorage, STORE_KEY, JSON.stringify(payload.store));
        localStorage.setItem('ft_last_push', String(cloudTime));
        location.reload();
      }
    } catch (e) {}
  }

  // Track when we last pushed so we can compare with cloud timestamp
  var _origPush = pushToCloud;
  pushToCloud = function (storeJson) {
    localStorage.setItem('ft_last_push', String(Date.now()));
    _origPush(storeJson);
  };

  // ── Sync UI ───────────────────────────────────────────────
  function buildUI() {
    var panel = document.createElement('div');
    panel.id = 'ft-sync-panel';
    panel.style.cssText = [
      'position:fixed;bottom:14px;right:14px;z-index:9990',
      'font:12px/1.5 system-ui,sans-serif;background:#fff',
      'border:1px solid #e5e7eb;border-radius:10px',
      'box-shadow:0 4px 16px rgba(0,0,0,.1);padding:12px 14px;width:270px'
    ].join(';');

    panel.innerHTML = [
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">',
        '<span style="font-weight:600;color:#111">☁ Cloud Sync</span>',
        '<span id="ft-sync-dot" style="width:8px;height:8px;border-radius:50%;background:#d1d5db;display:inline-block" title="Checking..."></span>',
      '</div>',
      '<div style="font-size:11px;color:#6b7280;margin-bottom:4px">Your sync code (tap to copy):</div>',
      '<div id="ft-sync-code" style="font-family:monospace;font-size:10px;background:#f3f4f6;',
        'padding:5px 8px;border-radius:6px;cursor:pointer;word-break:break-all;color:#374151;',
        'border:1px solid #e5e7eb">',
        syncId,
      '</div>',
      '<div style="font-size:10px;color:#9ca3af;margin:5px 0 8px">Share this code to sync across devices</div>',
      '<div style="display:flex;gap:6px;margin-bottom:6px">',
        '<input id="ft-sync-input" placeholder="Paste code from another device"',
          ' style="flex:1;font-size:10px;padding:4px 7px;border:1px solid #d1d5db;',
          'border-radius:6px;font-family:monospace;color:#374151;outline:none">',
        '<button id="ft-sync-apply" style="font-size:10px;padding:4px 10px;background:#0F6CBD;',
          'color:#fff;border:none;border-radius:6px;cursor:pointer;white-space:nowrap">Apply</button>',
      '</div>',
      '<div id="ft-sync-status" style="font-size:10px;color:#6b7280;min-height:14px"></div>',
      '<div style="text-align:right;margin-top:6px">',
        '<a href="#" id="ft-sync-hide" style="font-size:10px;color:#d1d5db;text-decoration:none">hide</a>',
      '</div>'
    ].join('');

    document.body.appendChild(panel);

    var dot    = document.getElementById('ft-sync-dot');
    var code   = document.getElementById('ft-sync-code');
    var input  = document.getElementById('ft-sync-input');
    var apply  = document.getElementById('ft-sync-apply');
    var status = document.getElementById('ft-sync-status');
    var hide   = document.getElementById('ft-sync-hide');

    // Copy sync code on click
    code.onclick = function () {
      navigator.clipboard.writeText(syncId).then(function () {
        status.textContent = '✓ Copied to clipboard';
        setTimeout(function () { status.textContent = ''; }, 2000);
      });
    };

    // Apply a different sync code
    apply.onclick = function () {
      var newId = input.value.trim();
      if (newId.length < 8) { status.textContent = 'Code too short'; return; }
      _origSetItem.call(localStorage, SYNC_KEY, newId);
      localStorage.removeItem('ft_last_push');
      sessionStorage.removeItem(SESSION_KEY);
      status.textContent = 'Applying… reloading page';
      setTimeout(function () { location.reload(); }, 800);
    };

    // Hide to small badge
    hide.onclick = function (e) {
      e.preventDefault();
      panel.style.display = 'none';
      var badge = document.createElement('div');
      badge.title = 'Cloud Sync';
      badge.textContent = '☁';
      badge.style.cssText = [
        'position:fixed;bottom:14px;right:14px;z-index:9990',
        'width:34px;height:34px;border-radius:50%;background:#0F6CBD',
        'color:#fff;display:flex;align-items:center;justify-content:center',
        'cursor:pointer;font-size:16px;box-shadow:0 2px 8px rgba(0,0,0,.2)'
      ].join(';');
      badge.onclick = function () { panel.style.display = ''; badge.remove(); };
      document.body.appendChild(badge);
    };

    // Show sync status
    fetch(API + '?syncId=' + encodeURIComponent(syncId))
      .then(function (r) { return r.json(); })
      .then(function (p) {
        if (p && p.updatedAt) {
          dot.style.background = '#22c55e';
          dot.title = 'Last synced: ' + new Date(p.updatedAt).toLocaleString();
          status.textContent = 'Last synced: ' + new Date(p.updatedAt).toLocaleTimeString();
        } else {
          dot.style.background = '#f59e0b';
          dot.title = 'No cloud data yet — make any change to sync';
          status.textContent = 'No cloud data yet — edit anything to sync';
        }
      })
      .catch(function () {
        dot.style.background = '#ef4444';
        dot.title = 'Cannot reach sync server';
        status.textContent = 'Sync unavailable';
      });
  }

  document.addEventListener('DOMContentLoaded', function () {
    syncOnLoad();
    setTimeout(buildUI, 500); // slight delay so app renders first
  });
})();

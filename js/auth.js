/**
 * 登录校验 + 会话 + 日记解密（登录页和日记页共用）
 *
 * 支持多个账号：auth-config.js 里每个账号各有一份盐、校验值和自己的密文文件。
 *   master   = PBKDF2-SHA256( "小写账号\0密码", 该账号的 salt, iter )
 *   校验值   = HKDF(master, "ld/verify/v1")   ← 与 auth-config.js 里该账号的 verify 比对
 *   AES 密钥 = HKDF(master, "ld/aes/v1")      ← 只存在于本次浏览器会话，用来解密这个账号的日记
 * 源码里没有任何明文密码；各账号的盐互不相同，拿到别人的配置也解不开你的日记。
 */
(function (global) {
  'use strict';

  var CFG = global.AUTH_CONFIG;
  var SESSION_KEY = 'ld_session_v2';
  var OLD_SESSION_KEY = 'ld_session_v1';
  var SESSION_MS = 6 * 60 * 60 * 1000;       // 会话最长 6 小时（关闭标签页也会失效）
  var INFO_VERIFY = 'ld/verify/v1';
  var INFO_AES = 'ld/aes/v1';
  var AAD = 'ld-diary-v1';

  var subtle = global.crypto && global.crypto.subtle;
  var enc = global.TextEncoder ? new TextEncoder() : null;
  var dec = global.TextDecoder ? new TextDecoder() : null;

  function accounts() { return (CFG && CFG.accounts) || {}; }
  function normUser(u) {
    u = String(u == null ? '' : u);
    if (u.normalize) u = u.normalize('NFKC');
    return u.trim().toLowerCase();
  }
  function accountOf(user) {
    var key = normUser(user);
    var cfg = accounts()[key];
    return cfg ? { key: key, cfg: cfg } : null;
  }
  function blobUrl(acct, key) {
    return acct.blob || ('data/diary.' + key + '.enc.json');
  }

  // 浏览器是否具备安全登录所需的能力（需要 https 或 localhost）
  var supported = !!(subtle && enc && dec && CFG && Object.keys(accounts()).length > 0);

  // ---------- 小工具 ----------
  function unb64(s) {
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function b64(buf) {
    var bytes = new Uint8Array(buf), s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }
  function canon(user, pass) {
    var u = String(user), p = String(pass);
    if (u.normalize) { u = u.normalize('NFKC'); p = p.normalize('NFKC'); }
    return u.trim().toLowerCase() + '\u0000' + p;
  }

  // ---------- 派生 ----------
  function derive(user, pass, acct) {
    var none = new Uint8Array(0);
    var iter = acct.iter || CFG.iter;
    return subtle.importKey('raw', enc.encode(canon(user, pass)), 'PBKDF2', false, ['deriveBits'])
      .then(function (km) {
        return subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(acct.salt), iterations: iter }, km, 256);
      })
      .then(function (master) {
        return subtle.importKey('raw', master, 'HKDF', false, ['deriveBits']);
      })
      .then(function (hk) {
        return Promise.all([
          subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: none, info: enc.encode(INFO_VERIFY) }, hk, 256),
          subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: none, info: enc.encode(INFO_AES) }, hk, 256)
        ]);
      })
      .then(function (r) { return { verify: new Uint8Array(r[0]), aes: new Uint8Array(r[1]) }; });
  }

  // ---------- 会话 ----------
  // 会话里同时记下「哪个账号」和它派生的 AES 密钥，日记页据此选对应的密文
  function saveSession(userKey, aesRaw) {
    try {
      global.sessionStorage.setItem(SESSION_KEY, JSON.stringify({
        u: userKey, k: b64(aesRaw), exp: Date.now() + SESSION_MS
      }));
      return true;
    } catch (e) { return false; }
  }
  function readSession() {
    try {
      global.sessionStorage.removeItem(OLD_SESSION_KEY);   // 旧版单账号会话直接作废
      var raw = global.sessionStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (!s || !s.u || !s.k || !(s.exp > Date.now()) || !accounts()[s.u]) { logout(); return null; }
      return s;
    } catch (e) { return null; }
  }
  function logout() {
    try { global.sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* 忽略 */ }
  }
  function isLoggedIn() { return !!readSession(); }

  /** 当前登录的账号名（未登录返回 null）。日记页用它显示标题、选密文。 */
  function currentUser() {
    var s = readSession();
    return s ? s.u : null;
  }

  /**
   * 登录。resolve 为：
   *   'ok'       账号密码正确，会话已保存
   *   'bad'      账号不存在，或密码不对
   *   'nostore'  密码对了，但浏览器不让保存会话（比如禁用了站点数据）
   */
  function login(user, pass) {
    if (!supported) return Promise.reject(new Error('unsupported'));
    var a = accountOf(user);
    if (!a) return Promise.resolve('bad');        // 没这个账号：不跑 KDF，直接失败
    return derive(user, pass, a.cfg).then(function (d) {
      if (!sameBytes(d.verify, unb64(a.cfg.verify))) return 'bad';
      return saveSession(a.key, d.aes) ? 'ok' : 'nostore';
    });
  }

  // ---------- 解密日记 ----------
  /**
   * 取当前账号的密文。
   *  - 网页在服务器上（http/https）：fetch 这个账号的 data/diary.<账号>.enc.json；
   *    读不到时，如果页面里带着预置密文就用它。
   *  - 直接双击打开的本地文件（file://）：浏览器不允许 fetch 读本地文件，
   *    改用 data/diary.blobs.js 里的 window.DIARY_BLOBS[账号]（同样的密文，<script> 能读到）。
   */
  function readBlob(acct, key) {
    var blobs = global.DIARY_BLOBS || {};
    var pre = (blobs[key] && blobs[key].iv && blobs[key].ct) ? blobs[key] : null;

    function fromFetch() {
      return fetch(blobUrl(acct, key), { cache: 'no-cache' }).then(function (r) {
        if (!r.ok) throw new Error('http-' + r.status);
        return r.json();
      });
    }
    function preloaded() {
      return pre ? Promise.resolve(pre) : fromFetch();
    }

    var isFile = /^file:/i.test(String((global.location && global.location.protocol) || ''));
    if (isFile) {
      if (!pre) return Promise.reject(new TypeError('blob-missing'));
      return preloaded();
    }
    return fromFetch().catch(function (err) {
      if (pre) return pre;
      throw err;
    });
  }

  function loadEncrypted() {
    var s = readSession();
    if (!s) return Promise.reject(new Error('not-logged-in'));
    var acct = accounts()[s.u];
    if (!acct) { logout(); return Promise.reject(new Error('not-logged-in')); }
    return Promise.all([
      readBlob(acct, s.u),
      subtle.importKey('raw', unb64(s.k), { name: 'AES-GCM' }, false, ['decrypt'])
    ]).then(function (r) {
      var blob = r[0];
      return subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv), additionalData: enc.encode(AAD) }, r[1], unb64(blob.ct));
    }).then(function (pt) {
      return JSON.parse(dec.decode(pt));
    });
  }

  global.Auth = {
    supported: supported,
    login: login,
    logout: logout,
    isLoggedIn: isLoggedIn,
    currentUser: currentUser,
    loadEncrypted: loadEncrypted
  };
})(window);
/**
 * 登录入口交互
 *  - 显示 / 隐藏密码
 *  - 手机软键盘弹出时，把登录框整体抬起来
 *  - 提交 → Auth.login 校验 → 成功淡出并进入日记页
 *  - 连续输错：第 3 次起暂时锁定，时间逐次加倍（15 秒起，最长 15 分钟），刷新页面也不会清零
 */
(function () {
  'use strict';

  // ==================== 可以自己改的设置 ====================
  var DIARY_URL = 'diary.html';
  var FREE_TRIES = 2;             // 前几次输错不惩罚
  var BASE_LOCK_SEC = 15;         // 第一次锁定的秒数，之后每次翻倍
  var MAX_LOCK_SEC = 900;         // 最长锁定 15 分钟
  var FORGET_AFTER_MS = 60 * 60 * 1000;  // 超过 1 小时没再试，错误次数清零
  // =========================================================

  var root = document.getElementById('login');
  var form = document.getElementById('login-form');
  var user = document.getElementById('login-user');
  var pass = document.getElementById('login-pass');
  var eye = document.getElementById('login-eye');
  var btn = document.getElementById('login-btn');
  var btnLabel = btn ? btn.querySelector('span') : null;
  var msg = document.getElementById('login-msg');
  if (!root || !form) return;

  var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // ---------- 显示 / 隐藏密码 ----------
  function setPasswordShown(show) {
    pass.type = show ? 'text' : 'password';
    eye.setAttribute('aria-pressed', show ? 'true' : 'false');
    eye.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
  }
  eye.addEventListener('click', function () {
    setPasswordShown(pass.type === 'password');
    pass.focus({ preventScroll: true });
  });
  // 点眼睛时不要让输入框失焦（否则手机键盘会闪一下）
  eye.addEventListener('mousedown', function (e) { e.preventDefault(); });

  // ---------- 软键盘避让 ----------
  var vv = window.visualViewport;
  function syncKeyboard() {
    if (!vv) return;
    var kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    var typing = root.contains(document.activeElement);
    // 只在确实弹出了键盘（>120px）并且焦点在登录框里时才抬起
    var lift = (typing && kb > 120) ? kb : 0;
    root.style.setProperty('--kb', lift + 'px');
    root.classList.toggle('kb-open', lift > 0);
  }
  if (vv) {
    vv.addEventListener('resize', syncKeyboard);
    vv.addEventListener('scroll', syncKeyboard);
    root.addEventListener('focusin', function () { setTimeout(syncKeyboard, 60); });
    root.addEventListener('focusout', function () { setTimeout(syncKeyboard, 60); });
  }

  // ---------- 提示语 ----------
  function say(text, kind) {
    msg.className = 'login-msg' + (kind ? ' is-' + kind : '');
    msg.textContent = text || '';
  }

  // ---------- 输错次数与锁定 ----------
  var LOCK_KEY = 'ld_lock_v1';
  var memLock = { n: 0, until: 0, last: 0 };   // localStorage 不可用时的后备

  function readLock() {
    var o = null;
    try { o = JSON.parse(window.localStorage.getItem(LOCK_KEY)); } catch (e) { /* 忽略 */ }
    if (!o || typeof o.n !== 'number') o = memLock;
    if (Date.now() - (o.last || 0) > FORGET_AFTER_MS && Date.now() > (o.until || 0)) o = { n: 0, until: 0, last: 0 };
    return o;
  }
  function writeLock(o) {
    memLock = o;
    try { window.localStorage.setItem(LOCK_KEY, JSON.stringify(o)); } catch (e) { /* 忽略 */ }
  }
  function clearLock() {
    memLock = { n: 0, until: 0, last: 0 };
    try { window.localStorage.removeItem(LOCK_KEY); } catch (e) { /* 忽略 */ }
  }
  function registerFailure() {
    var o = readLock();
    o.n += 1;
    o.last = Date.now();
    if (o.n > FREE_TRIES) {
      var sec = Math.min(MAX_LOCK_SEC, BASE_LOCK_SEC * Math.pow(2, o.n - FREE_TRIES - 1));
      o.until = Date.now() + sec * 1000;
    }
    writeLock(o);
    return o;
  }
  function lockSecondsLeft() {
    return Math.max(0, Math.ceil((readLock().until - Date.now()) / 1000));
  }
  function fmtSeconds(s) {
    if (s < 60) return s + ' 秒';
    var m = Math.floor(s / 60), r = s % 60;
    return m + ' 分' + (r ? ' ' + r + ' 秒' : '');
  }

  var lockTimer = 0;
  function tickLock() {
    clearTimeout(lockTimer);
    var left = lockSecondsLeft();
    if (left > 0) {
      btn.disabled = true;
      say('输错的次数有点多，请等 ' + fmtSeconds(left) + '再试', 'error');
      lockTimer = setTimeout(tickLock, 500);
    } else if (!busy) {
      btn.disabled = false;
      if (msg.classList.contains('is-error')) say('');
    }
  }

  // ---------- 忙碌状态 ----------
  var busy = false;
  function setBusy(on) {
    busy = on;
    btn.disabled = on;
    btn.classList.toggle('busy', on);
    user.readOnly = pass.readOnly = on;
    if (btnLabel) btnLabel.textContent = on ? '验证中' : '进入';
  }

  function shake() {
    form.classList.remove('shake');
    void form.offsetWidth;                 // 重新触发动画
    form.classList.add('shake');
    setTimeout(function () { form.classList.remove('shake'); }, 560);
  }

  // ---------- 成功后淡出并跳转 ----------
  var veil = null;
  function fadeOutMusic() {
    var a = document.getElementById('bgm');
    if (!a || a.paused) return;
    var v0 = a.volume, t0 = performance.now();
    (function step() {
      var p = Math.min(1, (performance.now() - t0) / 900);
      a.volume = Math.max(0, Math.min(1, v0 * (1 - p)));
      if (p < 1) requestAnimationFrame(step);
    })();
  }
  function leave() {
    veil = document.createElement('div');
    veil.className = 'login-veil';
    veil.setAttribute('aria-hidden', 'true');
    document.body.appendChild(veil);
    void veil.offsetWidth;
    veil.classList.add('on');
    fadeOutMusic();
    setTimeout(function () { window.location.href = DIARY_URL; }, reduceMotion ? 300 : 1000);
  }
  // 从日记页按「返回」回来时，页面可能是缓存里恢复的，直接重新加载最干净
  window.addEventListener('pageshow', function (e) { if (e.persisted && veil) window.location.reload(); });

  // ---------- 提交 ----------
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (busy) return;

    if (lockSecondsLeft() > 0) { tickLock(); shake(); return; }

    var u = user.value, p = pass.value;
    if (!u.trim() || !p) {
      say('请输入账号和密码哦～', 'error');
      (u.trim() ? pass : user).focus({ preventScroll: true });
      return;
    }
    if (!window.Auth || !window.Auth.supported) {
      say('这个浏览器暂时不能安全登录，请用新版浏览器并通过 https 打开', 'error');
      return;
    }

    setPasswordShown(false);
    setBusy(true);
    say('');

    window.Auth.login(u, p).then(function (result) {
      if (result === 'ok') {
        clearLock();
        pass.value = '';
        say('欢迎回来 ❤', 'ok');
        leave();                     // 保持忙碌状态，直到页面跳走
        return;
      }
      setBusy(false);
      if (result === 'nostore') {
        say('密码对啦，但浏览器不允许保存登录状态。请关闭无痕模式或允许站点数据后再试', 'error');
        return;
      }
      var lock = registerFailure();
      pass.value = '';
      shake();
      if (lockSecondsLeft() > 0) { tickLock(); }
      else {
        var left = FREE_TRIES - lock.n + 1;
        say('账号或密码不对，再试试～' + (left === 1 ? '（再错一次会暂时锁定哦）' : ''), 'error');
      }
      pass.focus({ preventScroll: true });
    }).catch(function () {
      setBusy(false);
      say('出了点小问题，请刷新页面再试', 'error');
    });
  });

  // 打开页面时如果上次的锁定还没过，直接接着倒计时
  tickLock();
})();

/**
 * 登录入口交互
 *  - 显示 / 隐藏密码
 *  - 手机软键盘弹出时，把登录框整体抬起来
 *  - 提交 → Auth.login（服务端校验）→ 成功淡出并进入日记页
 *  - 连续输错：锁定完全由服务端决定（同一 IP + 账号，3 次起 15 秒、逐次翻倍、封顶 15 分钟），
 *    清空浏览器存储也绕不过去；这里只负责把服务端给的 retryAfter 倒数出来。
 */
(function () {
  'use strict';

  // ==================== 可以自己改的设置 ====================
  var DIARY_URL = 'diary.html';
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

  // ---------- 服务端锁定倒计时 ----------
  var blockedUntil = 0;

  function fmtSeconds(s) {
    if (s < 60) return s + ' 秒';
    var m = Math.floor(s / 60), r = s % 60;
    return m + ' 分' + (r ? ' ' + r + ' 秒' : '');
  }

  var lockTimer = 0;
  function tickLock() {
    clearTimeout(lockTimer);
    var left = Math.max(0, Math.ceil((blockedUntil - Date.now()) / 1000));
    if (left > 0) {
      btn.disabled = true;
      say('输错的次数有点多，请等 ' + fmtSeconds(left) + '再试', 'error');
      lockTimer = setTimeout(tickLock, 500);
    } else if (!busy) {
      btn.disabled = false;
      if (msg.classList.contains('is-error')) say('');
    }
  }

  function block(seconds) {
    if (!seconds || seconds <= 0) return;
    blockedUntil = Date.now() + seconds * 1000;
    tickLock();
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
    if (busy || btn.disabled) return;

    var u = user.value, p = pass.value;
    if (!u.trim() || !p) {
      say('请输入账号和密码哦～', 'error');
      (u.trim() ? pass : user).focus({ preventScroll: true });
      return;
    }
    if (!window.Auth || !window.Auth.supported) {
      say('这个链接暂时不能登录，请用新版浏览器打开网站首页再试', 'error');
      return;
    }

    setPasswordShown(false);
    setBusy(true);
    say('');

    window.Auth.login(u, p).then(function (result) {
      if (result.ok) {
        pass.value = '';
        say('欢迎回来 ❤', 'ok');
        leave();                     // 保持忙碌状态，直到页面跳走
        return;
      }
      setBusy(false);
      if (result.reason === 'locked') {
        pass.value = '';
        shake();
        block(result.retryAfter || 15);
        if (!blockedUntil) say('请稍等一下再试', 'error');
        return;
      }
      if (result.reason === 'net') {
        say('连不上服务器，检查一下网络再试～', 'error');
        return;
      }
      if (result.reason === 'unsupported') {
        say('这个链接暂时不能登录，请用新版浏览器打开网站首页再试', 'error');
        return;
      }
      if (result.reason === 'error') {
        say('服务器出了点小问题，稍后再试～', 'error');
        return;
      }
      // 账号或密码不对
      pass.value = '';
      shake();
      pass.focus({ preventScroll: true });
      if (result.retryAfter) block(result.retryAfter);
      else if (!blockedUntil) say('账号或密码不对，再试试～', 'error');
    });
  });
})();
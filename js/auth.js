/**
 * 登录 / 会话 / 日记读写（登录页和日记页共用）
 *
 * 重构后密码校验和日记解密都在服务器上做：
 *   密码 --scrypt--> 服务端比对；日记正文 --AES-256-GCM--> 落库前已加密
 * 浏览器里不再保存任何密钥，只依赖服务端下发的 HttpOnly 会话 Cookie。
 *
 * 页面顺序：js/api.js → js/auth.js
 */
(function (global) {
  'use strict';

  var fileMode = /^file:/i.test(String((global.location && global.location.protocol) || ''));
  var supported = !fileMode && !!(global.fetch && global.Api);

  var state = { user: null, account: null, checked: false };

  function remember(name, account) {
    state.user = name || null;
    state.account = account || null;
    state.checked = true;
    return state.user;
  }

  /** 问服务器「我是谁」。页面打开时调用一次，日记页据此决定要不要跳回登录页。 */
  function me() {
    if (!supported) return Promise.resolve(null);
    return global.Api.get('/api/auth/me').then(function (d) {
      if (d && d.user) {
        remember(d.user.name, d.user);
        return state.user;
      }
      return remember(null);
    }, function () {
      return remember(null);
    });
  }

  /**
   * 登录。总是 resolve，不抛异常：
   *   { ok: true }
   *   { ok: false, reason: 'bad' | 'unverified' | 'locked' | 'unsupported' | 'net' | 'error', retryAfter }
   */
  function login(user, password) {
    if (!supported) return Promise.resolve({ ok: false, reason: 'unsupported' });
    return global.Api.post('/api/auth/login', { account: user, password: password }).then(function (d) {
      remember(d && d.user ? d.user.name : null, d && d.user);
      return { ok: true, count: d && d.diaryCount, account: d && d.user };
    }, function (err) {
      if (!err || !err.status) return { ok: false, reason: 'net' };
      if (err.status === 401) {
        return err.error === 'unverified'
          ? { ok: false, reason: 'unverified', account: user }
          : { ok: false, reason: 'bad' };
      }
      if (err.status === 429) return { ok: false, reason: 'locked', retryAfter: err.retryAfter || 0 };
      return { ok: false, reason: 'error' };
    });
  }

  function logout() {
    remember(null);
    if (!supported) return Promise.resolve();
    return global.Api.post('/api/auth/logout').catch(function () { /* 已经掉线也无所谓 */ });
  }

  function isLoggedIn() { return !!state.user; }
  function currentUser() { return state.user; }
  function currentAccount() { return state.account; }

  // ---------- 账号（注册 / 找回 / 设置） ----------
  // 这三个页面的错误都交给服务端判断，前端只把错误码翻译成中文，
  // 这样「账号是否存在」不会从客户端逻辑里泄露出去。

  function register(account, password, email) {
    return global.Api.post('/api/auth/register', {
      account: account, password: password, email: email
    }).then(function (d) { return d || {}; });
  }

  function verifyEmail(account, code) {
    return global.Api.post('/api/auth/verify-email', { account: account, code: code })
      .then(function (d) {
        if (d && d.user) remember(d.user.name, d.user);
        return d || {};
      });
  }

  function requestCode(purpose, account) {
    var body = { purpose: purpose };
    if (account) body.account = account;
    return global.Api.post('/api/auth/code', body).then(function (d) { return d || {}; });
  }

  function resetPassword(account, code, password) {
    return global.Api.post('/api/auth/reset', {
      account: account, code: code, password: password
    }).then(function (d) { return d || {}; });
  }

  function changeEmail(email, code) {
    return global.Api.put('/api/account/email', { email: email, code: code }).then(function (d) {
      if (d && d.user) remember(d.user.name, d.user);
      return d || {};
    });
  }

  function changePassword(password, code) {
    return global.Api.put('/api/account/password', { password: password, code: code })
      .then(function (d) { return d || {}; });
  }

  // ---------- 日记 ----------
  function loadDiary(order) {
    return global.Api.get('/api/diary?order=' + (order === 'old' ? 'old' : 'new')).then(function (d) {
      return (d && d.items) || [];
    });
  }

  function normalizeEntry(entry) {
    return {
      date: entry.date,
      title: entry.title || '',
      weather: entry.weather || '',
      mood: entry.mood || '',
      body: entry.body || ''
    };
  }

  function createDiary(entry) {
    return global.Api.post('/api/diary', normalizeEntry(entry)).then(function (d) { return d.item; });
  }

  function updateDiary(id, entry) {
    return global.Api.put('/api/diary/' + encodeURIComponent(id), normalizeEntry(entry))
      .then(function (d) { return d.item; });
  }

  function deleteDiary(id) {
    return global.Api.del('/api/diary/' + encodeURIComponent(id));
  }

  /** 第一幕那道题的答案，交给服务端判断，源码里不再有明文答案。网络出错时 reject。 */
  function checkAnswer(answer) {
    return global.Api.post('/api/quiz/answer', { answer: String(answer == null ? '' : answer) })
      .then(function (d) { return !!(d && d.ok); });
  }

  // ---------- 广场 ----------
  // 和日记相反，广场是所有人共用的：帖子明文存在服务器上，登录后谁都能读。

  function loadPlaza(before, limit) {
    var q = [];
    if (before) q.push('before=' + encodeURIComponent(before));
    if (limit) q.push('limit=' + encodeURIComponent(limit));
    return global.Api.get('/api/plaza' + (q.length ? '?' + q.join('&') : '')).then(function (d) {
      return {
        items: (d && d.items) || [],
        hasMore: !!(d && d.hasMore),
        total: d && typeof d.total === 'number' ? d.total : null
      };
    });
  }

  function postPlaza(body) {
    return global.Api.post('/api/plaza', { body: String(body == null ? '' : body) })
      .then(function (d) { return d.item; });
  }

  function deletePlaza(id) {
    return global.Api.del('/api/plaza/' + encodeURIComponent(id));
  }

  global.Auth = {
    supported: supported,
    me: me,
    login: login,
    logout: logout,
    isLoggedIn: isLoggedIn,
    currentUser: currentUser,
    currentAccount: currentAccount,
    register: register,
    verifyEmail: verifyEmail,
    requestCode: requestCode,
    resetPassword: resetPassword,
    changeEmail: changeEmail,
    changePassword: changePassword,
    loadDiary: loadDiary,
    createDiary: createDiary,
    updateDiary: updateDiary,
    deleteDiary: deleteDiary,
    checkAnswer: checkAnswer,
    loadPlaza: loadPlaza,
    postPlaza: postPlaza,
    deletePlaza: deletePlaza
  };
})(window);
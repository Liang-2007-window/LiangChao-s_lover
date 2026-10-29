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

  var state = { user: null, checked: false };

  function remember(name) {
    state.user = name || null;
    state.checked = true;
    return state.user;
  }

  /** 问服务器「我是谁」。页面打开时调用一次，日记页据此决定要不要跳回登录页。 */
  function me() {
    if (!supported) return Promise.resolve(null);
    return global.Api.get('/api/auth/me').then(function (d) {
      return remember(d && d.user ? d.user.name : null);
    }, function () {
      return remember(null);
    });
  }

  /**
   * 登录。总是 resolve，不抛异常：
   *   { ok: true }
   *   { ok: false, reason: 'bad' | 'locked' | 'unsupported' | 'net' | 'error', retryAfter }
   */
  function login(user, password) {
    if (!supported) return Promise.resolve({ ok: false, reason: 'unsupported' });
    return global.Api.post('/api/auth/login', { account: user, password: password }).then(function (d) {
      remember(d && d.user ? d.user.name : null);
      return { ok: true, count: d && d.diaryCount };
    }, function (err) {
      if (!err || !err.status) return { ok: false, reason: 'net' };
      if (err.status === 401) return { ok: false, reason: 'bad' };
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

  global.Auth = {
    supported: supported,
    me: me,
    login: login,
    logout: logout,
    isLoggedIn: isLoggedIn,
    currentUser: currentUser,
    loadDiary: loadDiary,
    createDiary: createDiary,
    updateDiary: updateDiary,
    deleteDiary: deleteDiary,
    checkAnswer: checkAnswer
  };
})(window);
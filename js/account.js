/**
 * 注册 / 找回密码 / 账号设置三个页面共用的表单小工具
 *
 * 这里只做「把服务端错误码翻译成人话」这类展示工作：
 * 账号是否存在、验证码对不对、密码够不够强，全部由服务端判定。
 */
(function (global) {
  'use strict';

  var TEXT = {
    bad_account: '账号要 2–32 个字，可以用中文、字母、数字、下划线和点',
    weak_password: '密码至少 8 位，而且要同时有字母和数字',
    bad_email: '这个邮箱地址看起来不太对',
    name_taken: '这个账号名已经有人用了，换一个吧',
    email_taken: '这个邮箱已经绑定过别的账号了',
    bad_code: '验证码不对，再看看邮件？',
    code_expired: '验证码过期了，重新发一封吧',
    too_many_attempts: '试错次数有点多，重新发一封新的验证码吧',
    too_soon: '刚发过一封，等一会儿再发',
    too_many: '操作太频繁了，歇一会儿再试',
    mail_unavailable: '邮件服务暂时发不出去，稍后再试或联系管理员',
    sent: '验证码已经发出，收不到先翻翻垃圾箱和「广告邮件」分类',
    already_verified: '这个账号已经验证过了，直接登录就好',
    unauthorized: '登录状态过期了，重新登录一下',
    no_email: '这个账号还没绑定邮箱',
    unverified: '这个账号还没验证邮箱',
    quota_exceeded: '这个账号存的东西已经到上限了',
    bad_purpose: '请求不对，刷新页面再试',
    network: '网络好像断了，检查一下连接再试',
    http_500: '服务器出了点小问题，稍后再试'
  };

  function msg(el, text, kind) {
    if (!el) return;
    el.textContent = text || '';
    el.className = 'msg' + (kind ? ' is-' + kind : '');
  }

  /**
   * 「还要等 3000 秒」是给人看的吗？超过一分半就换成分钟，别让人自己除。
   */
  function waitText(seconds) {
    var s = Math.max(0, Math.ceil(Number(seconds) || 0));
    if (s <= 90) return s + ' 秒';
    return Math.ceil(s / 60) + ' 分钟';
  }

  function errorText(err) {
    if (!err) return TEXT.network;
    if (err.status === 0) return TEXT.network;
    if (err.status === 429 && err.retryAfter) {
      return '操作太频繁了，等 ' + waitText(err.retryAfter) + '再试';
    }
    if (err.status === 410 && err.error === 'code_expired') return TEXT.code_expired;
    return TEXT[err.error] || ('出错了（' + err.status + '），稍后再试');
  }

  function busy(btn, on, label) {
    if (!btn) return;
    if (on) {
      btn.dataset.label = btn.dataset.label || btn.textContent;
      btn.disabled = true;
      if (label) btn.textContent = label;
    } else {
      btn.disabled = false;
      if (btn.dataset.label) btn.textContent = btn.dataset.label;
    }
  }

  /** 发送按钮的「还有 N 秒」倒计时，避免连点把邮件额度刷掉。 */
  function countdown(btn, seconds, idleLabel) {
    if (!btn) return;
    var idle = idleLabel || btn.dataset.label || btn.textContent;
    var left = Math.max(0, Math.ceil(seconds));
    if (left <= 0) {
      btn.disabled = false;
      btn.textContent = idle;
      return;
    }
    btn.disabled = true;
    btn.textContent = waitText(left) + '后重发';
    var timer = setInterval(function () {
      left -= 1;
      if (left <= 0) {
        clearInterval(timer);
        btn.disabled = false;
        btn.textContent = idle;
      } else {
        btn.textContent = waitText(left) + '后重发';
      }
    }, 1000);
  }

  function val(form, name) {
    var el = form.elements[name];
    return el ? String(el.value || '').trim() : '';
  }

  function mark(el, bad) {
    if (!el) return;
    if (bad) el.setAttribute('aria-invalid', 'true');
    else el.removeAttribute('aria-invalid');
  }

  // 服务端才是裁判，这里只是让明显的错误不必等一次网络往返。
  function nameOk(v) { return /^[\w\u4e00-\u9fa5.-]{2,32}$/.test(v); }
  function passOk(v) { return v.length >= 8 && v.length <= 64 && /[A-Za-z]/.test(v) && /\d/.test(v); }
  function emailOk(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }

  function query(name) {
    var m = new RegExp('[?&]' + name + '=([^&]*)').exec(global.location.search || '');
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
  }

  global.AccountUI = {
    TEXT: TEXT,
    msg: msg,
    errorText: errorText,
    waitText: waitText,
    busy: busy,
    countdown: countdown,
    val: val,
    mark: mark,
    nameOk: nameOk,
    passOk: passOk,
    emailOk: emailOk,
    query: query
  };
})(window);
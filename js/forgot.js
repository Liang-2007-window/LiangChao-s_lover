/**
 * 找回密码：账号 + 邮件验证码 + 新密码。
 * 服务端对不存在的账号也回「已发送」，所以这里的提示不能透露账号是否存在。
 */
(function () {
  'use strict';

  var UI = window.AccountUI;
  var $ = function (id) { return document.getElementById(id); };

  var form = $('form');
  var msgEl = $('msg');
  var sendBtn = $('send');
  var resetBtn = $('do-reset');

  sendBtn.addEventListener('click', function () {
    if (sendBtn.disabled) return;
    var account = UI.val(form, 'account');
    if (!account) {
      UI.mark(form.elements.account, true);
      UI.msg(msgEl, '先填一下账号名', 'error');
      form.elements.account.focus();
      return;
    }
    UI.mark(form.elements.account, false);

    UI.busy(sendBtn, true, '发送中…');
    UI.msg(msgEl, '正在发送…');

    window.Auth.requestCode('reset', account).then(function (res) {
      UI.msg(msgEl, '如果这个账号绑了邮箱，验证码已经发出去了', 'ok');
      UI.countdown(sendBtn, (res && res.retryAfter) || 60, '发送验证码');
      $('code').focus();
    }, function (err) {
      UI.msg(msgEl, UI.errorText(err), 'error');
      UI.busy(sendBtn, false);
      if (err && err.status === 429 && err.retryAfter) {
        UI.countdown(sendBtn, err.retryAfter, '发送验证码');
      }
    });
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();

    var account = UI.val(form, 'account');
    var code = UI.val(form, 'code').replace(/\s+/g, '');
    var pass = String(form.elements.password.value || '');
    var pass2 = String(form.elements.password2.value || '');

    UI.mark(form.elements.account, false);
    UI.mark($('code'), false);
    UI.mark(form.elements.password, false);
    UI.mark(form.elements.password2, false);

    if (!account) {
      UI.mark(form.elements.account, true);
      UI.msg(msgEl, '先填一下账号名', 'error');
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      UI.mark($('code'), true);
      UI.msg(msgEl, '验证码是 6 位数字', 'error');
      $('code').focus();
      return;
    }
    if (!UI.passOk(pass)) {
      UI.mark(form.elements.password, true);
      UI.msg(msgEl, '新密码至少 8 位，而且要同时有字母和数字', 'error');
      form.elements.password.focus();
      return;
    }
    if (pass !== pass2) {
      UI.mark(form.elements.password2, true);
      UI.msg(msgEl, '两次输的密码不一样', 'error');
      form.elements.password2.focus();
      return;
    }

    UI.busy(resetBtn, true, '正在重设…');
    UI.msg(msgEl, '');

    window.Auth.resetPassword(account, code, pass).then(function () {
      UI.msg(msgEl, '重设好了，2 秒后带你去登录…', 'ok');
      // 用原型上的 reset，防止表单里某个控件叫 reset 把方法盖掉
      HTMLFormElement.prototype.reset.call(form);
      window.setTimeout(function () {
        window.location.replace('index.html');
      }, 2000);
    }, function (err) {
      UI.msg(msgEl, UI.errorText(err), 'error');
      UI.busy(resetBtn, false);
    });
  });

  var preset = UI.query('account');
  if (preset) form.elements.account.value = preset;
  form.elements.account.focus();
})();
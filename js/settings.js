/**
 * 账号设置：看当前账号、换绑邮箱、改密码。
 * 两个操作都要先往「现在的邮箱」发一封验证码，服务端会核对验证码再改。
 */
(function () {
  'use strict';

  var UI = window.AccountUI;
  var $ = function (id) { return document.getElementById(id); };

  var formMail = $('form-mail');
  var formPass = $('form-pass');
  var msgMail = $('msg-mail');
  var msgPass = $('msg-pass');

  var currentEmail = '';

  function paint(user) {
    $('who').textContent = user.name;
    currentEmail = user.email || '';
    $('mail').textContent = currentEmail || '还没绑定';
    if (!currentEmail) {
      UI.msg(msgMail, '这个账号没有邮箱，换绑和改密码都用不了，需要管理员在服务器上设置。', 'error');
      $('send-mail-code').disabled = true;
      $('send-pass-code').disabled = true;
    }
  }

  window.Auth.me().then(function (name) {
    if (!name) {
      window.location.replace('index.html');
      return;
    }
    paint(window.Auth.currentAccount() || { name: name, email: '' });
  });

  $('logout').addEventListener('click', function () {
    window.Auth.logout().then(function () {
      window.location.replace('index.html');
    });
  });

  function sendCode(purpose, account, btn, msgEl) {
    if (btn.disabled) return;
    UI.busy(btn, true, '发送中…');
    UI.msg(msgEl, '正在发送…');
    window.Auth.requestCode(purpose, account).then(function (res) {
      UI.msg(msgEl, '验证码已经发到 ' + (currentEmail || '你的邮箱') + ' 了', 'ok');
      UI.countdown(btn, (res && res.retryAfter) || 60, '发验证码');
    }, function (err) {
      UI.msg(msgEl, UI.errorText(err), 'error');
      UI.busy(btn, false);
      if (err && err.status === 429 && err.retryAfter) {
        UI.countdown(btn, err.retryAfter, '发验证码');
      }
    });
  }

  $('send-mail-code').addEventListener('click', function () {
    sendCode('change-email', null, $('send-mail-code'), msgMail);
  });

  $('send-pass-code').addEventListener('click', function () {
    sendCode('change-password', null, $('send-pass-code'), msgPass);
  });

  formMail.addEventListener('submit', function (event) {
    event.preventDefault();
    var email = UI.val(formMail, 'email');
    var code = UI.val(formMail, 'code').replace(/\s+/g, '');

    UI.mark(formMail.elements.email, false);
    UI.mark($('mail-code'), false);

    if (!UI.emailOk(email)) {
      UI.mark(formMail.elements.email, true);
      UI.msg(msgMail, '这个邮箱地址看起来不太对', 'error');
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      UI.mark($('mail-code'), true);
      UI.msg(msgMail, '验证码是 6 位数字', 'error');
      return;
    }

    UI.busy($('save-mail'), true, '正在保存…');
    UI.msg(msgMail, '');

    window.Auth.changeEmail(email, code).then(function (res) {
      currentEmail = (res.user && res.user.email) || email;
      $('mail').textContent = currentEmail;
      $('new-email').value = '';
      $('mail-code').value = '';
      UI.msg(msgMail, '换好了，以后验证码发到 ' + currentEmail, 'ok');
      UI.busy($('save-mail'), false);
    }, function (err) {
      UI.msg(msgMail, UI.errorText(err), 'error');
      UI.busy($('save-mail'), false);
    });
  });

  formPass.addEventListener('submit', function (event) {
    event.preventDefault();
    var pass = String(formPass.elements.password.value || '');
    var code = UI.val(formPass, 'code').replace(/\s+/g, '');

    UI.mark(formPass.elements.password, false);
    UI.mark($('pass-code'), false);

    if (!UI.passOk(pass)) {
      UI.mark(formPass.elements.password, true);
      UI.msg(msgPass, '新密码至少 8 位，而且要同时有字母和数字', 'error');
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      UI.mark($('pass-code'), true);
      UI.msg(msgPass, '验证码是 6 位数字', 'error');
      return;
    }

    UI.busy($('save-pass'), true, '正在保存…');
    UI.msg(msgPass, '');

    window.Auth.changePassword(pass, code).then(function () {
      formPass.reset();
      UI.msg(msgPass, '密码改好了，其它设备已经退出登录', 'ok');
      UI.busy($('save-pass'), false);
    }, function (err) {
      UI.msg(msgPass, UI.errorText(err), 'error');
      UI.busy($('save-pass'), false);
    });
  });
})();
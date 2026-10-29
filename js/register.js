/**
 * 注册页：一步填资料，第二步填邮件验证码。
 * 会话只在验证成功后才下发，所以「注册了但没验证」的账号登不进来。
 */
(function () {
  'use strict';

  var UI = window.AccountUI;
  var $ = function (id) { return document.getElementById(id); };

  var stepForm = $('step-form');
  var stepCode = $('step-code');
  var form = $('form');
  var formCode = $('form-code');
  var msgEl = $('msg');
  var msgCodeEl = $('msg-code');
  var sendBtn = $('send');
  var verifyBtn = $('verify');
  var resendBtn = $('resend');

  var account = '';

  function showStep(which) {
    stepForm.classList.toggle('hidden', which !== 'form');
    stepCode.classList.toggle('hidden', which !== 'code');
    if (which === 'code') $('code').focus();
    else form.elements.account.focus();
  }

  function validateForm() {
    var name = UI.val(form, 'account');
    var email = UI.val(form, 'email');
    var pass = String(form.elements.password.value || '');
    var pass2 = String(form.elements.password2.value || '');

    UI.mark(form.elements.account, false);
    UI.mark(form.elements.email, false);
    UI.mark(form.elements.password, false);
    UI.mark(form.elements.password2, false);

    if (!UI.nameOk(name)) {
      UI.mark(form.elements.account, true);
      UI.msg(msgEl, '账号名要 2–32 个字，可以用中文、字母、数字、下划线和点', 'error');
      form.elements.account.focus();
      return null;
    }
    if (!UI.emailOk(email)) {
      UI.mark(form.elements.email, true);
      UI.msg(msgEl, '这个邮箱地址看起来不太对', 'error');
      form.elements.email.focus();
      return null;
    }
    if (!UI.passOk(pass)) {
      UI.mark(form.elements.password, true);
      UI.msg(msgEl, '密码至少 8 位，而且要同时有字母和数字', 'error');
      form.elements.password.focus();
      return null;
    }
    if (pass !== pass2) {
      UI.mark(form.elements.password2, true);
      UI.msg(msgEl, '两次输的密码不一样', 'error');
      form.elements.password2.focus();
      return null;
    }
    return { name: name, email: email, pass: pass };
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var data = validateForm();
    if (!data) return;

    UI.msg(msgEl, '正在发送验证码…');
    UI.busy(sendBtn, true, '发送中…');

    window.Auth.register(data.name, data.pass, data.email).then(function (res) {
      account = res.account || data.name;
      $('sent-to').textContent = res.email || data.email;
      UI.msg(msgEl, '');
      showStep('code');
      UI.msg(msgCodeEl, UI.TEXT.sent, 'ok');
      if (res.retryAfter) UI.countdown(resendBtn, res.retryAfter, '重新发送');
    }, function (err) {
      UI.msg(msgEl, UI.errorText(err), 'error');
    }).then(function () {
      UI.busy(sendBtn, false);
      if (!stepForm.classList.contains('hidden')) sendBtn.textContent = '发送验证码';
    });
  });

  formCode.addEventListener('submit', function (event) {
    event.preventDefault();
    var code = UI.val(formCode, 'code').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(code)) {
      UI.mark($('code'), true);
      UI.msg(msgCodeEl, '请输入 6 位数字', 'error');
      $('code').focus();
      return;
    }
    UI.mark($('code'), false);

    UI.busy(verifyBtn, true, '验证中…');
    UI.msg(msgCodeEl, '');

    window.Auth.verifyEmail(account, code).then(function () {
      UI.msg(msgCodeEl, '好，进去了', 'ok');
      window.location.replace('diary.html');
    }, function (err) {
      UI.msg(msgCodeEl, UI.errorText(err), 'error');
      if (err && err.error === 'code_expired') resendBtn.disabled = false;
      UI.busy(verifyBtn, false);
    });
  });

  resendBtn.addEventListener('click', function () {
    if (resendBtn.disabled) return;
    UI.msg(msgCodeEl, '正在重新发送…');
    window.Auth.requestCode('register', account).then(function (res) {
      UI.msg(msgCodeEl, '新的验证码已经发出去了，' + UI.TEXT.sent, 'ok');
      UI.countdown(resendBtn, (res && res.retryAfter) || 60, '重新发送');
    }, function (err) {
      UI.msg(msgCodeEl, UI.errorText(err), 'error');
      if (err && err.status === 429 && err.retryAfter) {
        UI.countdown(resendBtn, err.retryAfter, '重新发送');
      }
    });
  });

  $('back').addEventListener('click', function () {
    showStep('form');
    UI.msg(msgCodeEl, '');
    UI.msg(msgEl, '');
  });

  // 从登录页点「还没验证」跳过来时，直接把账号带上，跳过第一步。
  var preset = UI.query('account');
  if (preset) {
    account = preset;
    $('sent-to').textContent = '你注册时填的邮箱';
    showStep('code');
    UI.msg(msgCodeEl, '这个账号还没验证邮箱，点「重新发送」拿一封新的验证码。');
  } else {
    showStep('form');
  }
})();
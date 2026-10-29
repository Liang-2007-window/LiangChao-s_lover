/**
 * 写日记 / 改日记的弹窗（日记页专用）
 *
 *   Editor.init({ onSaved: reload });
 *   Editor.open();              // 新建
 *   Editor.open(entry);         // 编辑某一篇
 *
 * 保存与删除都直接打 API，成功后调用 onSaved 让日记页重新拉一遍列表。
 * 用原生 <dialog>，焦点陷阱、Esc 关闭、背景遮罩都是浏览器自带的。
 */
(function (global) {
  'use strict';

  var dlg = null;
  var form = null;
  var msgEl = null;
  var titleEl = null;
  var deleteBtn = null;
  var saveBtn = null;
  var fields = null;
  var current = null;
  var onSaved = null;
  var busy = false;

  var WEATHER = ['晴', '多云', '阴', '小雨', '大雨', '雪', '风'];
  var MOOD = ['开心', '安静', '想他', '累', '难过', '平常'];

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function today() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function build() {
    dlg = el('dialog', 'editor');
    dlg.id = 'editor';
    dlg.setAttribute('aria-labelledby', 'editor-heading');

    form = el('form', 'editor-form');
    form.noValidate = true;

    var head = el('header', 'editor-head');
    titleEl = el('h2', 'editor-heading', '写一篇');
    titleEl.id = 'editor-heading';
    var close = el('button', 'editor-x', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭');
    close.addEventListener('click', function () { dlg.close(); });
    head.appendChild(titleEl);
    head.appendChild(close);
    form.appendChild(head);

    fields = {};

    function label(text, input) {
      var l = el('label', 'editor-field');
      l.appendChild(el('span', 'editor-label', text));
      l.appendChild(input);
      return l;
    }

    var date = document.createElement('input');
    date.type = 'date';
    date.name = 'date';
    date.required = true;
    fields.date = date;
    form.appendChild(label('日期', date));

    var titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.name = 'title';
    titleInput.maxLength = 80;
    titleInput.placeholder = '不写也行';
    fields.title = titleInput;
    form.appendChild(label('标题', titleInput));

    var row = el('div', 'editor-row');

    var weather = document.createElement('input');
    weather.type = 'text';
    weather.name = 'weather';
    weather.maxLength = 16;
    weather.setAttribute('list', 'editor-weather');
    fields.weather = weather;
    var wl = document.createElement('datalist');
    wl.id = 'editor-weather';
    WEATHER.forEach(function (w) { wl.appendChild(new Option(w, w)); });
    row.appendChild(label('天气', weather));
    row.appendChild(wl);

    var mood = document.createElement('input');
    mood.type = 'text';
    mood.name = 'mood';
    mood.maxLength = 16;
    mood.setAttribute('list', 'editor-mood');
    fields.mood = mood;
    var ml = document.createElement('datalist');
    ml.id = 'editor-mood';
    MOOD.forEach(function (m) { ml.appendChild(new Option(m, m)); });
    row.appendChild(label('心情', mood));
    row.appendChild(ml);

    form.appendChild(row);

    var body = document.createElement('textarea');
    body.name = 'body';
    body.rows = 12;
    body.maxLength = 100000;
    body.placeholder = '今天发生了什么…（空一行就是新的一段）';
    fields.body = body;
    var bodyLabel = label('正文', body);
    bodyLabel.className = 'editor-field editor-body';
    form.appendChild(bodyLabel);

    msgEl = el('p', 'editor-msg');
    msgEl.setAttribute('role', 'status');
    msgEl.setAttribute('aria-live', 'polite');
    form.appendChild(msgEl);

    var foot = el('footer', 'editor-foot');
    deleteBtn = el('button', 'pill danger', '删除');
    deleteBtn.type = 'button';
    deleteBtn.hidden = true;
    deleteBtn.addEventListener('click', remove);
    var spacer = el('span', 'editor-spacer');
    var cancel = el('button', 'link-btn', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', function () { dlg.close(); });
    saveBtn = el('button', 'pill primary', '保存');
    saveBtn.type = 'submit';
    foot.appendChild(deleteBtn);
    foot.appendChild(spacer);
    foot.appendChild(cancel);
    foot.appendChild(saveBtn);
    form.appendChild(foot);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      save();
    });
    dlg.addEventListener('close', function () {
      document.body.classList.remove('editor-open');
    });

    dlg.appendChild(form);
    document.body.appendChild(dlg);
  }

  function say(text, kind) {
    msgEl.className = 'editor-msg' + (kind ? ' is-' + kind : '');
    msgEl.textContent = text || '';
  }

  function setBusy(on) {
    busy = on;
    saveBtn.disabled = on;
    deleteBtn.disabled = on;
    saveBtn.textContent = on ? '保存中…' : '保存';
    Array.prototype.forEach.call(form.querySelectorAll('input, textarea'), function (n) {
      n.readOnly = on;
    });
  }

  function open(entry) {
    if (!dlg) build();
    current = entry || null;
    fields.date.value = current ? current.date : today();
    fields.title.value = current ? current.title : '';
    fields.weather.value = current ? current.weather : '';
    fields.mood.value = current ? current.mood : '';
    fields.body.value = current ? current.body : '';
    titleEl.textContent = current ? '改一篇' : '写一篇';
    deleteBtn.hidden = !current;
    say('');
    setBusy(false);
    document.body.classList.add('editor-open');
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    (current ? fields.body : fields.title).focus({ preventScroll: true });
  }

  function collect() {
    return {
      date: fields.date.value,
      title: fields.title.value,
      weather: fields.weather.value,
      mood: fields.mood.value,
      body: fields.body.value
    };
  }

  function save() {
    if (busy) return;
    var entry = collect();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) { say('选一下日期吧', 'error'); return; }
    if (!entry.body.trim()) { say('正文还空着，写一点再保存～', 'error'); fields.body.focus(); return; }
    setBusy(true);
    say('');
    var task = current
      ? global.Auth.updateDiary(current.id, entry)
      : global.Auth.createDiary(entry);
    task.then(function () {
      setBusy(false);
      dlg.close();
      if (onSaved) onSaved();
    }, function (err) {
      setBusy(false);
      say(errorText(err), 'error');
    });
  }

  function remove() {
    if (busy || !current) return;
    if (!global.confirm('删除这一篇？删了就找不回来了。')) return;
    setBusy(true);
    global.Auth.deleteDiary(current.id).then(function () {
      setBusy(false);
      dlg.close();
      if (onSaved) onSaved();
    }, function (err) {
      setBusy(false);
      say(errorText(err), 'error');
    });
  }

  function errorText(err) {
    var code = err && err.error;
    if (!err || !err.status) return '连不上服务器，等一下再试';
    if (err.status === 401) return '登录过期了，刷新页面重新登录一下';
    if (err.status === 413 || code === 'too_long') return '写得太长了，删掉一些再保存';
    if (code === 'bad_date') return '日期格式不对';
    if (err.status === 429) return '写得太快了点，歇一秒再试';
    return '保存失败，再试一次';
  }

  global.Editor = {
    init: function (opts) {
      onSaved = (opts && opts.onSaved) || null;
      if (!dlg) build();
    },
    open: open
  };
})(window);
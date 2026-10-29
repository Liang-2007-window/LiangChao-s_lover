/**
 * 日记页：确认登录 → 从服务器取日记 → 排版显示
 *
 * 重构后内容存在服务器上（正文 AES-256-GCM 加密后落库），登录状态由服务端 Cookie 维持。
 * 每篇日记的格式（date 和 body 必填，其余选填）：
 *   { "date": "2026-10-17", "title": "标题", "weather": "晴", "mood": "开心", "body": "正文\n\n空一行是新的一段" }
 * 页面上所有文字都用 textContent 写入，日记里即使出现 < > 之类的符号也只会当普通文字显示。
 */
(function () {
  'use strict';

  var LOGIN_URL = 'index.html';
  var SORT_KEY = 'ld_diary_sort';
  var WEEK = '日一二三四五六';

  var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function toLogin() { window.location.replace(LOGIN_URL); }

  if (!window.Auth || !window.Auth.supported) {
    // 直接双击打开的本地文件没有后端，日记页只能回首页
    toLogin();
    return;
  }

  var $ = function (id) { return document.getElementById(id); };
  var entriesEl = $('entries');
  var stateEl = $('state');
  var subEl = $('sub');
  var sortBtn = $('sort');
  var sortLabel = $('sort-label');
  var endEl = $('end');
  var progressEl = $('progress');
  var newBtn = $('new-entry');

  var list = [];
  var order = readSort();
  var me = null;

  // ---------- 小工具 ----------
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function parseDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    var dt = new Date(y, mo - 1, d);
    if (dt.getMonth() !== mo - 1) return null;       // 比如 2026-02-31
    return { y: y, m: mo, d: d, w: dt.getDay(), key: m[0] };
  }

  function readSort() {
    try { return window.localStorage.getItem(SORT_KEY) === 'old' ? 'old' : 'new'; } catch (e) { return 'new'; }
  }
  function writeSort(v) {
    try { window.localStorage.setItem(SORT_KEY, v); } catch (e) { /* 忽略 */ }
  }

  // ---------- 状态区（加载中 / 空 / 出错） ----------
  function showState(text, actions, loading) {
    stateEl.hidden = false;
    stateEl.className = 'state' + (loading ? ' loading' : '');
    stateEl.textContent = '';
    stateEl.appendChild(el('p', 'state-text', text));
    (actions || []).forEach(function (a) {
      var b = el('button', 'pill', a.label);
      b.type = 'button';
      b.addEventListener('click', a.fn);
      stateEl.appendChild(b);
    });
  }
  function hideState() { stateEl.hidden = true; stateEl.textContent = ''; }

  // ---------- 排版 ----------
  function subText() {
    var keys = list.map(function (e) { return parseDate(e.date); }).filter(Boolean)
      .map(function (d) { return d.key; }).sort();
    var head = '共 ' + list.length + ' 篇';
    if (!keys.length) return head;
    var a = keys[0], b = keys[keys.length - 1];
    var fa = a.slice(0, 7).replace('-', '.'), fb = b.slice(0, 7).replace('-', '.');
    if (a === b) return head + ' · ' + a.replace(/-/g, '.');
    return head + ' · ' + (fa === fb ? fa : fa + ' — ' + fb);
  }

  function yearRow(y) {
    var row = el('div', 'year');
    row.setAttribute('role', 'presentation');
    row.appendChild(el('span', 'ynum', String(y)));
    row.appendChild(el('i', 'yline'));
    return row;
  }

  function entryEl(it) {
    var e = it.e, d = it.d;
    var art = el('article', 'entry');

    var when = el('time', 'when');
    if (d) {
      when.setAttribute('datetime', d.key);
      when.appendChild(el('span', 'day', pad(d.d)));
      when.appendChild(el('span', 'ym', d.y + '.' + pad(d.m)));
      when.appendChild(el('span', 'wk', '周' + WEEK.charAt(d.w)));
    } else {
      when.appendChild(el('span', 'day', '·'));
    }
    art.appendChild(when);

    var what = el('div', 'what');
    var title = e.title ? String(e.title).trim() : '';
    if (title) {
      var h = el('h2', 'etitle', title);
      h.id = 'entry-' + it.i;
      art.setAttribute('aria-labelledby', h.id);
      what.appendChild(h);
    }
    var tags = [e.weather, e.mood].filter(function (t) { return t && String(t).trim(); });
    if (tags.length) {
      var meta = el('p', 'meta');
      tags.forEach(function (t) { meta.appendChild(el('span', null, String(t).trim())); });
      what.appendChild(meta);
    }
    var text = el('div', 'text');
    String(e.body).replace(/\r\n?/g, '\n').split(/\n{2,}/).forEach(function (para) {
      para = para.trim();
      if (para) text.appendChild(el('p', null, para));
    });
    what.appendChild(text);

    // 只有登录着的本人看得到这两个按钮（服务端同样会校验，不只是藏起来）
    var actions = el('div', 'entry-actions');
    var edit = el('button', 'link-btn', '编辑');
    edit.type = 'button';
    edit.addEventListener('click', function () { window.Editor.open(e); });
    var del = el('button', 'link-btn', '删除');
    del.type = 'button';
    del.addEventListener('click', function () { removeEntry(e); });
    actions.appendChild(edit);
    actions.appendChild(del);
    what.appendChild(actions);

    art.appendChild(what);
    return art;
  }

  // 滚到哪里，哪里浮现
  var io = (!reduceMotion && 'IntersectionObserver' in window)
    ? new IntersectionObserver(function (items) {
        items.forEach(function (x) {
          if (x.isIntersecting) { x.target.classList.add('in'); io.unobserve(x.target); }
        });
      }, { threshold: 0.06, rootMargin: '0px 0px -5% 0px' })
    : null;

  function render() {
    entriesEl.textContent = '';
    var items = list.map(function (e, i) { return { e: e, i: i, d: parseDate(e.date) }; });
    items.sort(function (a, b) {
      var ka = a.d ? a.d.key : '', kb = b.d ? b.d.key : '';
      var c = ka < kb ? -1 : (ka > kb ? 1 : a.i - b.i);
      return order === 'new' ? -c : c;
    });
    var lastYear = null;
    items.forEach(function (it) {
      if (it.d && it.d.y !== lastYear) { lastYear = it.d.y; entriesEl.appendChild(yearRow(it.d.y)); }
      entriesEl.appendChild(entryEl(it));
    });
    Array.prototype.forEach.call(entriesEl.querySelectorAll('.entry, .year'), function (n) {
      if (io) io.observe(n); else n.classList.add('in');
    });
    sortBtn.setAttribute('data-order', order);
    sortLabel.textContent = order === 'new' ? '最新在前' : '最早在前';
    sortBtn.setAttribute('aria-label', '当前' + sortLabel.textContent + '，点击切换顺序');
    sortBtn.hidden = list.length < 2;
    endEl.hidden = !list.length;
  }

  function paint() {
    subEl.textContent = list.length ? subText() : '';
    if (!list.length) {
      entriesEl.textContent = '';
      showState('这里还空着，等着写下第一篇。', [{ label: '写第一篇', fn: function () { window.Editor.open(); } }]);
      endEl.hidden = true;
      return;
    }
    hideState();
    render();
  }

  sortBtn.addEventListener('click', function () {
    order = order === 'new' ? 'old' : 'new';
    writeSort(order);
    render();
    var top = entriesEl.getBoundingClientRect().top + window.pageYOffset - 24;
    if (window.pageYOffset > top) window.scrollTo(0, Math.max(0, top));   // 换了顺序，从头开始读
  });

  if (newBtn) newBtn.addEventListener('click', function () { window.Editor.open(); });

  // ---------- 加载 ----------
  function load() {
    showState('翻开中…', null, true);
    return window.Auth.loadDiary(order).then(function (data) {
      list = (data || []).filter(function (e) {
        return e && typeof e === 'object' && typeof e.body === 'string' && e.body.trim();
      });
      paint();
    }).catch(onLoadError);
  }

  /** 保存/删除后重新拉一遍，尽量不动读者的滚动位置 */
  function reload() {
    var y = window.pageYOffset;
    return window.Auth.loadDiary(order).then(function (data) {
      list = (data || []).filter(function (e) {
        return e && typeof e === 'object' && typeof e.body === 'string' && e.body.trim();
      });
      paint();
      window.scrollTo(0, Math.min(y, document.documentElement.scrollHeight - window.innerHeight));
    }, function (err) {
      onLoadError(err);
    });
  }

  function removeEntry(e) {
    if (!window.confirm('删除「' + (e.title || e.date) + '」？删了就找不回来了。')) return;
    window.Auth.deleteDiary(e.id).then(function () {
      list = list.filter(function (x) { return x.id !== e.id; });
      paint();
    }, function (err) {
      if (err && err.status === 401) { toLogin(); return; }
      window.alert('没删掉，再试一次。');
    });
  }

  function relogin() { window.Auth.logout(); toLogin(); }

  function onLoadError(err) {
    if (err && err.status === 401) { toLogin(); return; }
    if (!err || !err.status) {
      showState('网络好像不太稳定，日记没能加载出来。', [{ label: '再试一次', fn: load }]);
      return;
    }
    showState('出了点小问题，日记没能打开。', [{ label: '再试一次', fn: load }, { label: '重新登录', fn: relogin }]);
  }

  // ---------- 退出 / 回到顶部 ----------
  function logout() {
    window.Auth.logout();
    entriesEl.textContent = '';              // 先清空，避免"返回"键从缓存里露出内容
    subEl.textContent = '';
    document.body.classList.add('leaving');
    setTimeout(toLogin, reduceMotion ? 0 : 380);
  }
  $('logout-top').addEventListener('click', logout);
  $('logout-bottom').addEventListener('click', logout);
  $('to-top').addEventListener('click', function () {
    window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
  });

  // 登录状态过期后（退出、超时），从缓存或后台回到这一页，要立刻回登录页
  window.addEventListener('pageshow', function (e) {
    if (e.persisted && !window.Auth.isLoggedIn()) { entriesEl.textContent = ''; toLogin(); }
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && !window.Auth.isLoggedIn()) toLogin();
  });

  // ---------- 阅读进度 ----------
  var ticking = false;
  function paintProgress() {
    ticking = false;
    var de = document.documentElement;
    var max = de.scrollHeight - de.clientHeight;
    var p = max > 0 ? Math.min(1, Math.max(0, window.pageYOffset / max)) : 0;
    progressEl.style.transform = 'scaleX(' + p.toFixed(4) + ')';
  }
  window.addEventListener('scroll', function () {
    if (!ticking) { ticking = true; requestAnimationFrame(paintProgress); }
  }, { passive: true });

  // ---------- 启动：先问服务器登录状态 ----------
  window.Auth.me().then(function (name) {
    if (!name) { toLogin(); return; }
    me = name;
    // 标题上带一下账号名，免得两个账号的日记混在一起看迷糊
    document.title = '我们的日记 · ' + me;
    document.body.setAttribute('data-account', me);
    window.Editor.init({ onSaved: reload });
    load();
  });
})();
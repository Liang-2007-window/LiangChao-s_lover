/**
 * 日记页：确认登录 → 解密日记 → 排版显示
 *
 * 日记内容在 data/diary.enc.json 里是加密的，登录后用会话里的密钥解开。
 * 每篇日记的格式（date 和 body 必填，其余选填）：
 *   { "date": "2026-10-17", "title": "标题", "weather": "晴", "mood": "开心", "body": "正文\n\n空一行是新的一段" }
 * 页面上所有文字都用 textContent 写入，日记里即使出现 < > 之类的符号也只会当普通文字显示。
 */
(function () {
  'use strict';

  var LOGIN_URL = 'index.html';
  var DATA_URL = 'data/diary.enc.json';
  var SORT_KEY = 'ld_diary_sort';
  var WEEK = '日一二三四五六';

  var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function toLogin() { window.location.replace(LOGIN_URL); }

  // 没登录（或登录已过期）就回登录页
  if (!window.Auth || !window.Auth.isLoggedIn()) { toLogin(); return; }

  var $ = function (id) { return document.getElementById(id); };
  var entriesEl = $('entries');
  var stateEl = $('state');
  var subEl = $('sub');
  var sortBtn = $('sort');
  var sortLabel = $('sort-label');
  var endEl = $('end');
  var progressEl = $('progress');

  var list = [];
  var order = readSort();

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
  }

  sortBtn.addEventListener('click', function () {
    order = order === 'new' ? 'old' : 'new';
    writeSort(order);
    render();
    var top = entriesEl.getBoundingClientRect().top + window.pageYOffset - 24;
    if (window.pageYOffset > top) window.scrollTo(0, Math.max(0, top));   // 换了顺序，从头开始读
  });

  // ---------- 加载 ----------
  function load() {
    showState('翻开中…', null, true);
    window.Auth.loadEncrypted(DATA_URL).then(function (data) {
      if (!Array.isArray(data)) throw new Error('shape');
      list = data.filter(function (e) { return e && typeof e === 'object' && typeof e.body === 'string' && e.body.trim(); });
      if (!list.length) {
        subEl.textContent = '';
        showState('这里还空着，等着写下第一篇。');
        return;
      }
      hideState();
      subEl.textContent = subText();
      sortBtn.hidden = list.length < 2;
      render();
      endEl.hidden = false;
    }).catch(onLoadError);
  }

  function relogin() { window.Auth.logout(); toLogin(); }

  function onLoadError(err) {
    var name = err && err.name, msg = (err && err.message) || '';
    if (msg === 'not-logged-in') { toLogin(); return; }
    if (name === 'OperationError' || name === 'DataError' || name === 'InvalidAccessError') {
      // 密钥对不上：多半是密码改过了，或登录信息损坏
      showState('日记暂时打不开：登录信息已经失效，请重新登录。', [{ label: '重新登录', fn: relogin }]);
    } else if (name === 'TypeError' && /^file:/.test(window.location.protocol)) {
      // file:// 下浏览器不允许 fetch 读本地文件，通常是没有一起放 data/diary.enc.js
      showState('日记文件没读到：直接双击打开网页时，日记要跟着 data/diary.enc.js 一起读。请确认它就在网站目录里（或者用一个本地服务器打开）。', [{ label: '刷新试试', fn: function () { window.location.reload(); } }]);
    } else if (name === 'TypeError' || /^http-/.test(msg)) {
      showState('网络好像不太稳定，日记没能加载出来。', [{ label: '再试一次', fn: load }]);
    } else {
      showState('出了点小问题，日记没能打开。', [{ label: '再试一次', fn: load }, { label: '重新登录', fn: relogin }]);
    }
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

  // 登录状态失效后（退出、过期），从缓存或后台回到这一页，要立刻回登录页
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

  load();
})();

/**
 * 广场页：登录之后，所有人都能看见这里的话
 *
 * 和日记页相反：
 *   - 日记是加密后存在服务器、只有本人能读；
 *   - 广场是明文存在服务器、登录的账号都能读，谁发的只在「我的」那条上出现删除按钮。
 * 帖子里即使写了 <script> 也只会当字面文字显示，全页用 textContent 写入。
 */
(function () {
  'use strict';

  var LOGIN_URL = 'index.html';
  var MAX = 500;

  if (!window.Auth || !window.Auth.supported) {
    window.location.replace(LOGIN_URL);
    return;
  }

  var $ = function (id) { return document.getElementById(id); };
  var postsEl = $('posts');
  var stateEl = $('state');
  var subEl = $('sub');
  var moreWrap = $('more-wrap');
  var moreBtn = $('more-btn');
  var bodyEl = $('post-body');
  var countEl = $('count');
  var postBtn = $('post-btn');
  var msgEl = $('post-msg');
  var endEl = $('end');
  var logoutBtn = $('logout-top');
  var toTopBtn = $('to-top');

  var cursor = null;        // 最老那条的 id，翻页时当锚点
  var total = 0;            // 广场上一共有多少条（首页时由服务端给）
  var loading = false;
  var hasMore = false;
  var coolTimer = null;

  // ---------- 小工具 ----------
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function timeText(ms) {
    if (!ms || !isFinite(ms)) return '';
    var d = new Date(ms);
    var now = Date.now();
    var diff = now - ms;
    var today = new Date();
    var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (diff >= 0 && diff < 60e3) return '刚刚';
    if (diff >= 0 && diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
    if (d.toDateString() === today.toDateString()) return '今天 ' + hm;
    var y = new Date(now - 86400e3);
    if (d.toDateString() === y.toDateString()) return '昨天 ' + hm;
    if (d.getFullYear() === today.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
    return d.getFullYear() + '.' + pad(d.getMonth() + 1) + '.' + pad(d.getDate());
  }

  // ---------- 状态区 ----------
  function showState(text, loading2) {
    stateEl.hidden = false;
    stateEl.className = 'state' + (loading2 ? ' loading' : '');
    stateEl.textContent = '';
    stateEl.appendChild(el('p', 'state-text', text));
  }
  function hideState() { stateEl.hidden = true; stateEl.textContent = ''; }

  function msg(text, kind) {
    msgEl.textContent = text || '';
    msgEl.className = 'composer-msg' + (kind ? ' is-' + kind : '');
  }

  // ---------- 一条帖子 ----------
  function postEl(post) {
    var art = el('article', 'post');
    art.setAttribute('data-id', String(post.id));

    var head = el('header', 'post-head');
    head.appendChild(el('span', 'post-author', post.author || '匿名'));
    var time = el('time', 'post-time', timeText(post.createdAt));
    if (post.createdAt) time.setAttribute('datetime', new Date(post.createdAt).toISOString());
    head.appendChild(time);

    if (post.mine) {
      var del = el('button', 'link-btn post-del', '删除');
      del.type = 'button';
      del.setAttribute('aria-label', '删除这条');
      del.addEventListener('click', function () { removePost(post, art, del); });
      head.appendChild(del);
    }
    art.appendChild(head);

    art.appendChild(el('p', 'post-body', post.body));
    return art;
  }

  function append(items, prepend) {
    items.forEach(function (post) {
      var node = postEl(post);
      if (prepend && postsEl.firstChild) postsEl.insertBefore(node, postsEl.firstChild);
      else postsEl.appendChild(node);
    });
  }

  function updateSub(n) {
    subEl.textContent = (n > 0 ? '已有 ' + n + ' 条 · ' : '') + '这里所有人都看得见';
  }

  // ---------- 读取 ----------
  function load(more) {
    if (loading) return;
    loading = true;
    moreBtn.disabled = true;
    if (!more) showState('正在打开广场…', true);

    window.Auth.loadPlaza(more ? cursor : null).then(function (res) {
      loading = false;
      moreBtn.disabled = false;

      if (more) {
        append(res.items);
      } else {
        postsEl.textContent = '';
        append(res.items);
      }
      if (res.items.length) cursor = res.items[res.items.length - 1].id;
      if (!more && typeof res.total === 'number') total = res.total;
      hasMore = res.hasMore;
      moreWrap.hidden = !hasMore;
      endEl.hidden = postsEl.children.length === 0 || hasMore;

      updateSub(total);

      if (postsEl.children.length) hideState();
      else showState('广场还空着，说第一句吧。');
    }, function (err) {
      loading = false;
      moreBtn.disabled = false;
      if (err && err.status === 401) { window.location.replace(LOGIN_URL); return; }
      if (err && err.status === 0) { showState('网络好像断了，等会儿再试～'); return; }
      showState('广场没打开，稍后再试～');
    });
  }

  // ---------- 发帖 ----------
  function updateCount() {
    var n = bodyEl.value.length;
    countEl.textContent = n + '/' + MAX;
    countEl.className = 'count' + (n > MAX * 0.9 ? ' warn' : '');
    postBtn.disabled = !bodyEl.value.trim() || n > MAX;
  }

  function autoGrow() {
    bodyEl.style.height = 'auto';
    bodyEl.style.height = Math.min(bodyEl.scrollHeight, window.innerHeight * 0.46) + 'px';
  }

  function stopCooldown() {
    if (coolTimer) { window.clearInterval(coolTimer); coolTimer = null; }
    postBtn.disabled = false;
    updateCount();
  }

  // 服务端说「等 N 秒」，按钮就陪着一起数，省得用户一下下点。
  function cooldown(seconds, label) {
    stopCooldown();
    var left = Math.max(1, Math.ceil(seconds || 0));
    msg(label + '（' + left + ' 秒）');
    postBtn.disabled = true;
    coolTimer = window.setInterval(function () {
      left -= 1;
      if (left <= 0) { stopCooldown(); msg(''); return; }
      msg(label + '（' + left + ' 秒）');
    }, 1000);
  }

  function submit() {
    var text = bodyEl.value.trim();
    if (!text) { bodyEl.focus(); return; }
    if (text.length > MAX) { msg('太长了，最多 ' + MAX + ' 字', 'error'); return; }
    msg('');
    postBtn.disabled = true;

    window.Auth.postPlaza(text).then(function (post) {
      stopCooldown();
      bodyEl.value = '';
      updateCount();
      autoGrow();

      var node = postEl(post);
      node.classList.add('is-new');
      if (postsEl.firstChild) postsEl.insertBefore(node, postsEl.firstChild);
      else postsEl.appendChild(node);
      hideState();
      endEl.hidden = true;
      moreWrap.hidden = true;
      total += 1;
      updateSub(total);
      msg('发出去了', 'ok');
      window.setTimeout(function () { if (msgEl.textContent === '发出去了') msg(''); }, 2600);
    }, function (err) {
      postBtn.disabled = false;
      updateCount();
      if (!err || err.status === 0) { msg('网络好像断了，再点一次试试', 'error'); return; }
      if (err.status === 401) { window.location.replace(LOGIN_URL); return; }
      if (err.error === 'empty_post') { msg('写点什么再发吧', 'error'); return; }
      if (err.error === 'too_long') { msg('太长了，最多 ' + MAX + ' 字', 'error'); return; }
      if (err.status === 429 && err.error === 'too_fast') { cooldown(err.retryAfter, '刚发过一条，歇一会儿'); return; }
      if (err.status === 429) { cooldown(err.retryAfter, '这一小时发得有点多'); return; }
      msg('没发出去，再点一次试试', 'error');
    });
  }

  // ---------- 删除 ----------
  function removePost(post, node, btn) {
    if (!window.confirm('删除这条？删了就找不回来了。')) return;
    btn.disabled = true;
    window.Auth.deletePlaza(post.id).then(function () {
      node.parentNode && node.parentNode.removeChild(node);
      total = Math.max(0, total - 1);
      updateSub(total);
      if (!postsEl.children.length) showState('广场还空着，说第一句吧。');
      msg('删掉了');
      window.setTimeout(function () { if (msgEl.textContent === '删掉了') msg(''); }, 2200);
    }, function (err) {
      btn.disabled = false;
      if (err && err.status === 401) { window.location.replace(LOGIN_URL); return; }
      if (err && err.status === 404) {   // 已经不在服务器上了，本地也跟着拿掉
        node.parentNode && node.parentNode.removeChild(node);
        return;
      }
      msg(err && err.status === 0 ? '网络好像断了，再点一次试试' : '没删掉，再试一次', 'error');
    });
  }

  // ---------- 退出 ----------
  function leave() {
    document.body.classList.add('leaving');
    window.setTimeout(function () { window.location.replace(LOGIN_URL); }, 220);
  }

  logoutBtn.addEventListener('click', function () {
    logoutBtn.disabled = true;
    window.Auth.logout().then(leave, leave);
  });

  toTopBtn.addEventListener('click', function () {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  moreBtn.addEventListener('click', function () { load(true); });
  postBtn.addEventListener('click', submit);

  bodyEl.addEventListener('input', function () { updateCount(); autoGrow(); });
  bodyEl.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
  });

  // 发出第一次请求前先把按钮关掉，免得空着也能点
  updateCount();
  autoGrow();

  window.Auth.me().then(function (user) {
    if (!user) { window.location.replace(LOGIN_URL); return; }
    document.title = '广场 · ' + user;
    load(false);
  }, function () { window.location.replace(LOGIN_URL); });
})();
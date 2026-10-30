/* 把万圣节背景 SVG 注入 [data-page-bg] 容器。
   用 fetch + innerHTML 而不是 background-image / <img>：
   SVG 里的浮动动画（幽灵、蝙蝠）只在被内联进文档时才会运行。 */
(function () {
  'use strict';

  var host = document.querySelector('[data-page-bg]');
  if (!host) return;

  // 换了素材就改这里的版本号：nginx 给 svg 设了 30 天 immutable，不加参数手机不会重新拉
  var src = host.getAttribute('data-src') || 'images/halloween-bg.svg?v=2';

  function show(markup) {
    host.innerHTML = markup;
    var svg = host.firstElementChild;
    if (!svg || svg.tagName.toLowerCase() !== 'svg') return;
    // 尺寸交给 CSS，SVG 自己的 width/height 会让它在容器里缩成一角
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('aria-hidden', 'true');
    // 等一帧再淡入，避免刚插进来时闪一下
    setTimeout(function () { host.classList.add('is-ready'); }, 60);
  }

  // 背景加载失败不该影响页面，所以整段都在 try 里
  try {
    if (window.fetch) {
      fetch(src, { credentials: 'same-origin' })
        .then(function (res) { return res.ok ? res.text() : ''; })
        .then(function (text) { if (text) show(text); })
        .catch(function () {});
    } else {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', src, true);
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300 && xhr.responseText) show(xhr.responseText);
      };
      xhr.send();
    }
  } catch (err) {
    /* 装饰而已，安静失败 */
  }
})();
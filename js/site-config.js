/* 网站总开关。
 *
 * closed: true  → 任何人打开网站（index.html、diary.html、以及它们的链接）都只会看到
 *                 「站长心情不好」那一页，其他内容一律进不去。
 * closed: false → 恢复正常，原来的小问答 + 登录 + 日记都照旧。
 *
 * 只改这一个 true / false 就行，不用动别的文件。改完刷新一下页面即可。 */
window.SITE_CONFIG = {
  closed: true
};
/**
 * 和服务器说话的唯一入口（登录页、日记页共用）
 *
 * - 会话靠服务端下发的 HttpOnly Cookie，前端手里没有任何密钥
 * - 出错时抛 ApiError：status 是 HTTP 状态码，error 是服务端给的错误码，
 *   retryAfter 是「还要等多少秒才能再试」（限流/锁定用）
 */
(function (global) {
  'use strict';

  function ApiError(status, error, retryAfter) {
    var err = new Error(error || ('http-' + status));
    err.name = 'ApiError';
    err.status = status || 0;
    err.error = error || '';
    err.retryAfter = retryAfter || 0;
    return err;
  }

  function parse(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function request(method, path, body) {
    var init = {
      method: method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'accept': 'application/json' }
    };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return global.fetch(path, init).then(function (res) {
      return res.text().then(function (text) {
        var data = parse(text);
        if (!res.ok) throw ApiError(res.status, data && data.error, data && data.retryAfter);
        return data;
      });
    }, function () {
      throw ApiError(0, 'network');
    });
  }

  global.Api = {
    Error: ApiError,
    get: function (p) { return request('GET', p); },
    post: function (p, b) { return request('POST', p, b === undefined ? {} : b); },
    put: function (p, b) { return request('PUT', p, b); },
    del: function (p) { return request('DELETE', p); }
  };
})(window);
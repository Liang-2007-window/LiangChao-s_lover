# 梁超的恋人 · LiangChao's Lover

一个两层的小站：第一层是夏天的海和一道只有一个人答得对的问题，第二层是黄昏和两个人的日记本。
现在是动态站——日记存在服务器 SQLite 里，密码在服务端校验，正文整体 AES-256-GCM 加密后落库。

## 目录

```
index.html / diary.html      两页入口
css/ js/ images/ audio/ fonts/   静态资源（Nginx 直接发）
server/                      后端：node:http + node:sqlite，零 npm 依赖
  index.mjs                  路由、会话、限流、请求日志
  db.mjs                     建表与预编译语句
  security.mjs               scrypt 口令、AES-GCM、会话 token、锁定
  entry.mjs                  日记载荷加解密（整条加密）
  config.mjs / http.mjs / static.mjs / cli.mjs
tests/api.test.mjs           同进程端到端测试（10 项）
deploy/                      nginx 配置、systemd 单元、安装/备份/发布脚本
docs/dynamic-plan.md         设计说明：架构、加密、容量预算、阶段计划
```

## 本地开发

```powershell
# server/.env 里放 LD_DATA_KEY / LD_DATA_DIR / LD_SERVE_STATIC=1
node server/index.mjs          # http://127.0.0.1:3000 同时发静态和 API
node tests/api.test.mjs        # 10 项接口测试
node server/cli.mjs list       # 账号、篇数
node server/cli.mjs add-account <账号> <密码>
```

## 部署（2 核 2G）

```powershell
pwsh -File deploy\push.ps1     # 打包上传到 /srv/liangchao/app 并重启
ssh root@47.111.150.169 'bash /srv/liangchao/app/deploy/install-server.sh'   # 首次
```

- Nginx 发静态、`/api/` 反代 `127.0.0.1:3000`，Node 不暴露公网。
- 服务用户 `www-data`，`MemoryMax=320M`，`--max-old-space-size=192`。
- 数据在 `/var/lib/liangchao/liangchao.db`，密钥在 `/etc/liangchao.env` 的 `LD_DATA_KEY`。
- 每天 03:20 `/usr/local/bin/liangchao-backup.sh` 备份数据库和密钥，留 7 天。
  **密钥丢了日记就永久打不开**，备份要一起带走。

## 域名与 HTTPS

站点地址是 **https://selfweb.eu.cc**（`www` 同）。用 `https://` 打开，别用 `http://`——

> 阿里云会对未备案域名的 **80 端口**做 ICP 拦截，返回 403 页面（`Non-compliance ICP Filing`，
> 响应头 `server: Beaver`）。443 端口的 TLS 不受影响，所以证书只能用 **tls-alpn-01** 签发，
> 不能用常见的 HTTP-01（那需要 80 端口能被 Let's Encrypt 读到）。

- DNS 在聚名（juyu.com）：`@` 和 `www` 两条 A 记录都指向 `47.111.150.169`。
- 证书 Let's Encrypt，acme.sh 装在 `/opt/acme.sh`（gitee 镜像，GitHub 在这台机器不通），
  签出来的文件在 `/etc/ssl/liangchao/{fullchain,privkey}.pem`。
- 续期：`/usr/local/bin/liangchao-renew.sh`（cron 每天 04:17）。因为 alpn 验证要独占 443，
  脚本会先停 nginx、续完再拉起来，停机 1-2 秒；没到期时 acme.sh 自己跳过。
- 首次签发或换机器：`sudo bash deploy/issue-cert.sh`。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 存活、RSS、Node 版本 |
| POST | `/api/auth/login` | `{account,password}` → 种 `ld_sid` Cookie（HTTPS 下带 `Secure`） |
| POST | `/api/auth/logout` | 清会话 |
| GET | `/api/auth/me` | 当前用户 |
| GET | `/api/diary?order=new\|old` | 列表（解密后返回） |
| POST | `/api/diary` | 新建 |
| PUT / DELETE | `/api/diary/:id` | 修改 / 删除 |
| POST | `/api/quiz/answer` | 问题答案服务端校验（6 次/分钟） |

写操作校验 `Origin`，不匹配返回 403 `bad_origin`；登录同一 IP+账号 5 次/分钟，连错 3 次起 15 秒
翻倍封顶 15 分钟，计数在服务端。
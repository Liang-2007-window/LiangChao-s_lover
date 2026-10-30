# 「夏日海岸」动态化改造计划

> 目标：把现在的纯静态站改成有后端、有数据库的动态站，并针对 2 核 2G 云服务器做容量调优。
> 本文档随实施进度更新；确认后的决策直接改这里。

---

## 1. 现状盘点

| 部分 | 现在怎么做的 | 动态化后的问题 |
| --- | --- | --- |
| 首页 `index.html` | 两幕动画（夏日海岸 / 黄昏骑行），纯前端 | 无需改动，保持原样 |
| 答案校验 | `js/main.js:10` 写死 `CORRECT_ANSWER = '刘克'`，前端比对 | 源码里能直接看到答案 |
| 登录 | `js/auth.js` 前端 PBKDF2-SHA256(60 万次) + HKDF，比对 `auth-config.js` 里的 verify 值 | 密文和配置都在公开目录，没密码也能下载下来离线爆破 |
| 日记 | `data/diary.<账号>.enc.json`，AES-GCM 密文，浏览器端解密 | 加/改一篇要在本机跑 `make-auth.mjs` 再手工上传两个文件 |
| 账号 | `make-auth.mjs` 离线生成盐和校验值 | 无服务端账号体系，无法改密码/加账号 |
| 体积 | 音频 1.6 MB、图片 269 KB(jpg)+140 KB(webp)、JS ≈ 50 KB、CSS ≈ 50 KB | 单页首屏偏重，2 Mbps 出口下体验一般 |

已知账号：`liuke` / `Yangquan`（口令在 `D:\dynamic wed page tools\README.md` 里，明文另有 `diary-src/*.json`，可用于迁移）。

---

## 2. 目标形态

- **一个 Node 服务**（Fastify + SQLite）跑业务接口，**Nginx** 继续发静态文件、反代 `/api`。
- **服务端认证**：scrypt 存口令哈希，HttpOnly Cookie 会话（不再把 verify 值放前端）。
- **日记加密落库**：正文用 AES-256-GCM 加密后写 SQLite，密钥在服务器 `.env`，不进 Git。
- **网页上直接写/改/删日记**，不用再跑离线加密脚本。
- **答案校验搬到服务端**，前端只拿 true/false，并加限流防爆破。
- 现有视觉/动画/文案全部保留，只替换数据来源。

---

## 3. 架构与资源预算（2 核 2 G）

```
浏览器 ──HTTP──> Nginx :80 ──┬── 静态文件（repo 根目录，长缓存）
                             └── /api/* ──> Node Fastify 127.0.0.1:3000 ──> SQLite 文件
```

| 进程 | 常驻内存 | 说明 |
| --- | --- | --- |
| 系统 + sshd + cron | ~150 MB | |
| 宝塔面板 | ~150–200 MB | 面板本体，无法省 |
| Nginx | ~20 MB | 静态文件 + 反代 + gzip |
| Node（Fastify + SQLite） | ~70–90 MB | 单进程，不开 cluster |
| **MySQL** | **0（建议停用）** | 默认 MySQL 8 空跑就 400 MB+，本项目改用 SQLite 后完全不需要 |
| **PHP-FPM** | **0（建议停用）** | 没有 PHP 代码 |
| 合计 | **≈ 400–470 MB** | 余量 1.5 G，足够 |

调优点：

1. **加 2 GB swap**（宝塔 → 软件商店 → Linux 工具箱），防止 OOM 直接杀进程。
2. **停掉 MySQL / PHP**（若面板里其它站点不用）；如必须留 MySQL，把 `innodb_buffer_pool_size` 压到 128 M。
3. **SQLite 参数**：`journal_mode=WAL`、`synchronous=NORMAL`、`busy_timeout=5000`、`cache_size=-8000`（约 8 MB）。
4. **Node 限制**：`--max-old-space-size=256`，pm2 `max_memory_restart: '300M'`。
5. **Nginx**：`gzip on`（js/css/json/svg）、`expires 30d` + `immutable`（fonts/images/audio）、`client_max_body_size 2m`、`sendfile on`。
6. **首屏瘦身**：`bgm.mp3` 转 96 kbps 单声道（≈ 550 KB，现在 1.6 MB），保持 `preload="none"` 点开才加载；图片改 `<picture>` 走 webp，jpg 只做兜底。
7. **日志**：Nginx 日志按天切、留 7 天；Node 用 pm2 日志，`max_size` 10 M 轮转。
8. **防火墙**：只放 80/443 + 面板端口；SSH 改端口 + 禁密码登录。
9. **备份**：每天 `sqlite3 .backup` → gzip → 保留 7 天，另存一份到你本机（日记没法重新生成，必须双备份）。

---

## 4. 目录结构（增量，不搬动现有文件）

```
D:\dynamic wed page\
├─ index.html / diary.html / css / js / images / fonts / audio   ← 原地保留
├─ server\
│  ├─ package.json
│  ├─ src\app.mjs          装配 Fastify、静态目录、路由
│  ├─ src\server.mjs       入口，读 .env，监听 127.0.0.1:3000
│  ├─ src\db.mjs           SQLite 连接 + 建表迁移
│  ├─ src\crypto.mjs       scrypt 口令哈希、AES-GCM 日记加解密、会话 token
│  ├─ src\routes\auth.mjs  登录/登出/我是谁
│  ├─ src\routes\diary.mjs 日记 CRUD
│  ├─ src\routes\quiz.mjs  答案校验（限流）
│  ├─ scripts\seed.mjs     从 tools\diary-src\*.json 导入现有账号和日记
│  └─ test\*.test.mjs      node --test
├─ deploy\  nginx.conf.snippet / ecosystem.config.cjs / backup.sh
└─ docs\dynamic-plan.md    ← 本文
```

`server/.env`（不进 Git）：`DATA_KEY`（32 B base64）、`SESSION_SECRET`、`PORT`、`DB_PATH`。

---

## 5. 数据模型

```sql
accounts(id, name UNIQUE COLLATE NOCASE, pass_hash, created_at)
diary(id, account_id, date TEXT, title TEXT, weather TEXT, mood TEXT,
      ct BLOB, iv BLOB, tag BLOB, created_at, updated_at)   -- 正文加密
sessions(token_hash PRIMARY KEY, account_id, exp, created_at)
login_fails(lkey PRIMARY KEY, n, last, until)                 -- 服务端锁定
```

- 口令：`scrypt(pass, salt, N=32768, r=8, p=1, keylen=64)`，`maxmem=64MB`；只存 `salt:hash`。
- 日记：`AES-256-GCM(key=DATA_KEY, iv=12B, aad="ld-diary-v2")`，加密的是整篇 JSON。
- 会话：32 B 随机 token，库里只存 SHA-256，Cookie `HttpOnly; SameSite=Lax; Max-Age=14d`（14 天滑动续期）。
- 锁定：同一 IP+账号 5 次/分钟，连续错 3 次锁 15 秒起、翻倍、封顶 15 分钟（服务端，刷新页面也逃不掉）。

---

## 6. 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/login` | `{user, pass}` → 种 Cookie，返回 `{ok, user}` |
| POST | `/api/auth/logout` | 清会话 |
| GET | `/api/auth/me` | 当前登录账号（未登录 401） |
| GET | `/api/diary?order=new\|old` | 返回解密后的数组（未登录 401） |
| POST | `/api/diary` | 新建一篇 |
| PUT | `/api/diary/:id` | 修改 |
| DELETE | `/api/diary/:id` | 删除 |
| POST | `/api/quiz/answer` | `{answer}` → `{ok:boolean}`，限流 6 次/分钟 |

写操作校验 `Origin`，只允许本站；所有 SQL 预编译；所有输出走 JSON。

---

## 7. 前端改动

- `js/main.js`：删掉 `CORRECT_ANSWER`，改成 `POST /api/quiz/answer`；网络失败时给中性提示。
- `js/auth.js`：从「本地密码派生」改成「调接口 + 记住会话」，暴露同样的 `login/logout/isLoggedIn/currentUser/loadDiary`。
- `js/login.js`：保留输入锁定动画，判错逻辑交给服务端返回的 `retryAfter`。
- `js/diary.js`：`load()` 改为 `GET /api/diary`，排版逻辑不动。
- 新增 `js/editor.js` + `diary.html` 里的编辑弹窗：日期、标题、天气、心情、正文（空行分段），保存/删除。
- 删除 `js/auth-config.js`、`data/*.enc.json`、`data/diary.blobs.js`（迁移完再删，先留在本机备份）。

---

## 8. 实施阶段

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P0 | 看面板：系统版本、Node 版本、MySQL/PHP 占用、内存实测 | 拿到环境清单，定好端口和路径 |
| P1 | 后端骨架：db/crypto/auth/diary/quiz + 单测 | `npm test` 全绿；curl 跑通登录→读写 |
| P2 | 前端改造：登录、日记、编辑器、答案校验 | 本地 `node server` 起来，手机尺寸下走一遍 |
| P3 | 数据迁移：seed 两个账号 + 7 篇日记 | 登录两个账号各自只看到自己的 |
| P4 | 部署：Nginx 反代、pm2、swap、备份、防火墙、2C2G 调优 | 浏览器能打开站点，`pm2 status` 稳定，内存 < 500 M |
| P5 | Git：分支 `feat/dynamic` → 提交 → 推送 origin | GitHub 上能看到完整提交 |
| P6 | 文档：README 改写（部署/备份/加账号），旧加密工具归档 | 换台机器照着 README 能部署 |

回滚：静态站原文件不动，Nginx 只需把 `/api` 代理去掉、根目录指回原路径即可恢复；数据库文件单独存放（`/www/wwwroot/ld/data/app.db`），不影响仓库。

---

## 9. 待确认 / 风险

1. **没有域名只能走 HTTP**：密码和日记在网络上是明文传输。建议加个免费域名（DuckDNS / eu.org）+ Let's Encrypt，10 分钟能配好，Cookie 才能加 `Secure`。
2. **DATA_KEY 丢失 = 日记永久打不开**：密钥要另存一份（密码管理器/本地文件），并随备份一起保存。
3. **GitHub 推送凭证**：本机凭据在沙箱里可能读不到，push 时可能要你确认一次。
4. **服务器是否已跑着别的站**：停 MySQL/PHP 前要确认没有别的站点依赖它们。

---

## 10. 实际落地（2026-10-29，与上文计划的差异）

上线后这一节才是准的，上面几节保留当时的推演过程。

| 项目 | 计划 | 实际 | 为什么改 |
| --- | --- | --- | --- |
| 框架 | Fastify + 依赖 | `node:http` + `node:sqlite`，零 npm 依赖 | 2C2G 上每装一个包都是磁盘、内存和攻击面；Node 24 自带 SQLite 够用 |
| 进程管理 | pm2 | systemd 单元 `liangchao.service` | systemd 自带 `MemoryMax=320M`、`Restart=always`、日志进 journald，省一个常驻进程 |
| 日记字段 | date/title/weather/mood 明文 + 正文密文 | **整条载荷一起加密**（`server/entry.mjs`） | 标题同样隐私，明细列没有查询需求，多一次 AES 解密可以忽略 |
| 登录字段 | `{user, pass}` | `{account, password}` | 便于和账号名区分 |
| 路由 | 无 health | 多了 `GET /api/health`（RSS/uptime/Node 版本）与 `PATCH /api/diary/:id` | 部署自检与轻量更新 |
| 站点根目录 | `/www/wwwroot/...` | `/srv/liangchao/app`，Nginx `root` 指它，`/server/ /tests/ /deploy/ /docs/` 显式 404 | 一个目录即整站，反过来也能挡住源码和后端代码被下载 |
| 音频 | 转 96 kbps 单声道省 1 MB | **保留原 128 kbps 立体声** | 实测转换只省 25%（1.63 MB → 1.22 MB），背景音乐是这站的情绪内核，不值得为 400 KB 掉质感；已经 `preload="none"`，不点不下载 |

实测（Ubuntu 22.04.5、2 vCPU、1736 MB）：

- 系统已用 280 MB（宝塔 71 MB、云盾监控 60 MB、Node 62 MB），可用 1.27 GB；停掉 snapd / multipathd 又省约 50 MB。
- 800 次请求（并发 10，含 200 次 `/api/health`）：全部 200，p95 ≈ 170 ms（主要是到杭州的公网 RTT），Node RSS 63 → 66 MB，无泄漏迹象。
- gzip 生效（style.css 35 KB → 约 7 KB），html `no-cache`，js/css 1 小时，媒体 30 天。
- 备份脚本已跑通：`/var/backups/liangchao/` 下同时有 db 与 `env-*.txt`（含 LD_DATA_KEY），每日 03:20 由 `/etc/cron.d/liangchao-backup` 触发，校验 `integrity_check` 并留 7 天。
---

## 11. HTTPS：撞上 ICP，改走 tls-alpn-01

原计划（P4 之后）是给站点加域名 + HTTPS，走最常规的 `certbot --webroot`（HTTP-01，需要 80 端口能被 Let's Encrypt 读到）。实际卡在这里：

- 域名 `selfweb.eu.cc` 在聚名解析，`@` / `www` 两条 A 记录指向 `47.111.150.169`，DNS 生效正常。
- 从公网访问 `http://selfweb.eu.cc/` 返回 **403**，页面标题 `Non-compliance ICP Filing`，响应头 `server: Beaver` —— 这是阿里云对**未备案域名 80 端口**的 ICP 拦截，发生在网络侧，服务器本地 `curl -H "Host: selfweb.eu.cc" 127.0.0.1` 是 200。
- 于是 `certbot --webroot` 校验失败：`Invalid response from http://selfweb.eu.cc/.well-known/acme-challenge/…: 403`。
- 实测 **443 端口不受影响**：自签证书做 TLS 握手 + SNI 测试，从公网拿到 200。

结论：只要 80 端口做不了 HTTP-01，就必须换一种**不碰 80** 的校验方式。可选三种：

| 方案 | 可行性 | 结论 |
|---|---|---|
| HTTP-01（80） | 被 ICP 拦死 | 不可用 |
| DNS-01 | 可行，但要 `julydns` 的 API（没有），或把 NS 迁到阿里云/Cloudflare 再要 AccessKey | 要用户交出 API 密钥、且要改 NS，改动面大 |
| **tls-alpn-01（443）** | 可行，acme.sh 自带 standalone alpn 模式 | **采用**：不需要任何密钥，不需要改 NS，只为一次验证临时占用 443 |

落地细节：

- acme.sh 从 GitHub 装不上（`curl https://get.acme.sh` 报 `SSL connection timeout`），改从 **gitee 镜像 `https://gitee.com/neilpang/acme.sh.git`** clone 到 `/opt/acme.sh` 再 `--install`。
- alpn 模式的监听器要 `socat`（服务器原本没装，`apt-get install socat`）。
- 签发：`acme.sh --issue --alpn -d selfweb.eu.cc -d www.selfweb.eu.cc --server letsencrypt`，证书经 `--install-cert` 落到 `/etc/ssl/liangchao/{fullchain,privkey}.pem`。
- **续期与原计划不同**：alpn 验证必须独占 443，而线上 nginx 常驻 443。所以 `--reloadcmd` 写成
  `systemctl is-active --quiet nginx && systemctl reload nginx || true`（nginx 停着时不报错），
  并另加包装脚本 `/usr/local/bin/liangchao-renew.sh`：停 nginx → `acme.sh --cron` → 起 nginx，
  由 cron 每天 04:17 执行（脚本见 `deploy/renew-cert.sh`）。acme.sh 自己装的 cron 会删掉，否则它会在 443 被占时失败。
  实测强制续期成功（停机约 16 秒），未到期时 acme.sh 自己跳过，停机 1-2 秒。
- nginx 1.18 **不认** `http2 on;` 指令（1.25.1 才有），只能写 `listen 443 ssl http2;`。
- `add_header` 没有「继承后追加」的语义：某个 location 里一写 `add_header`，server 级的 HSTS 等安全头就全部失效。
  为避免漏，把四条安全头抽成 `deploy/liangchao-headers.conf`（装到 `/etc/nginx/snippets/`），
  每个自带 `add_header` 的 location 都 `include` 一次。校验过 `/`、`/diary.html`、`/css/*.css` 都带 HSTS。
- HTTPS 生效后 Cookie 自动带 `Secure`：`server/index.mjs:86` 的 `secure: wantsHttps(req)` 读 `X-Forwarded-Proto`，
  nginx 已在 `/api/` 里传 `$scheme`，所以**代码一行没改**。

线上验证：`https://selfweb.eu.cc/` 200、`/diary.html` 200、`/api/health` 200（GET；HEAD 会 404，因为路由只处理 GET）、
`/server/config.mjs` 404；浏览器实测答题 →「刘克」→ 密码 `20050721` → 进入 `我们的日记 · liuke`，6 篇正常渲染，
`document.cookie` 为空（会话 Cookie 是 HttpOnly）。

遗留：`http://selfweb.eu.cc` 仍然会看到阿里云的 ICP 403 页面，这不是配置问题，只能靠备案或让用户始终用 `https://`。
---

## 12. 放开注册：邮箱验证码 + 账号设置（v3）

### 为什么不是手机号

国内短信必须用服务商的「签名 + 模板」，个人签名通常要求**已备案的网站/公众号/小程序/APP**。
`selfweb.eu.cc` 没有备案（见第 11 节：阿里云把 80 端口按 Host 拦了），签名大概率批不下来；
退一步说，短信按条计费、接口公开，被脚本刷一轮就是真金白银。所以验证渠道改成**邮箱验证码**：
`server/mail.mjs` 是自己写的 SMTP 客户端（AUTH LOGIN + 隐式 TLS），没有引 nodemailer——
2 核 2G 上每多一个 npm 包都是磁盘、内存和攻击面。

### 数据模型

`accounts` 加三列（`db.mjs` 里用 `PRAGMA table_info` 判断后 `ALTER TABLE`，可重复执行）：

| 列 | 作用 |
|---|---|
| `email` | 绑定邮箱，部分唯一索引 `WHERE email IS NOT NULL`（老账号可以为 NULL） |
| `verified` | 1=可用；0=注册了但没验证，登录返回 401 `unverified` |
| `updated_at` | 最近一次改密码/改邮箱的时间 |

新增 `email_codes(id, account_id, email, purpose, code_hash, exp, attempts, used, created_at)`：
只存 `sha256(email|purpose|code)`，不存明文码。`purpose` 四类：`register / reset / change-email / change-password`。

### 会话与权限的取舍

- 注册成功**不发**会话，验证码填对才发 —— 否则「注册了但邮箱不是自己的」也能进门。
- 重置密码 = 把这个账号的所有会话删掉，再让用户重新登录；改密码 = 删掉所有会话，但给当前设备发一个新 token。
  两处都是 `stmt.sessionDeleteByAccount`，理由一样：密码变了，旧 Cookie 就不该再有效。
- 换绑邮箱/改密码的验证码发到**当前**邮箱，不是新邮箱：偷到登录态的人改不走账号。
- 防枚举：`/api/auth/code` 对不存在的账号也返回 `{sent:true, retryAfter:60}`；
  验证码校验失败只说「码不对」，不区分「没这个账号」。
- 密码规则：8–64 位且必须同时含字母和数字（用户要求）。scrypt 参数沿用 `N=16384, r=8, p=1`。

### 限流（都存服务端，清 localStorage 绕不过）

| 位置 | 上限 |
|---|---|
| 同一邮箱 + 同一用途 | 60 秒冷却；每小时 5 封 |
| 同一 IP | 每小时 10 封验证码、3 次注册、10 次重置 |
| 同一验证码 | 最多试 5 次，过期 10 分钟 |
| 单账号 | 500 篇、5 MB 密文（开放注册后磁盘要有个上限） |
| 未验证账号 | 24 小时后由 `cli.mjs prune` 删除 |

### 前端

新增 `register.html` / `forgot.html` / `settings.html` + `css/auth.css` + `js/account.js`（错误码翻译、按钮倒计时）
和三个页面脚本。登录页在密码框下面加了「注册 · 忘记密码」两个链接；日记页顶栏加了「账号设置」。
登录返回 401 `unverified` 时，登录页把账号名带进 `register.html?account=...`，直接进第二步收新码。

### 踩坑

`forgot.html` 里提交按钮的 id 原本叫 `reset`，于是 `form.reset` 被这个按钮元素遮住了，
`form.reset()` 抛 `TypeError` 把后面的 `setTimeout` 跳转也带走了（页面停在「正在重设…」）。
改名 `do-reset` 并改用 `HTMLFormElement.prototype.reset.call(form)`。教训：表单里别用 `reset` / `submit` 当 id。

### 遗留

- 邮件走 QQ 的 SMTP，单封约 1 秒；没有队列，`mailMaxConcurrent=2` 只是信号量，发信慢会占着请求。
  以现在的访问量够用，量大了要改成「先落库、后台补发」。
- 邮箱发信失败时注册会回滚（删掉刚建的 pending 账号），但用户看到的是 503 `mail_unavailable`，
  需要管理员修配置，没有自助重试入口（重试其实就是再点一次）。

### 上线状态（2026-10-29 夜）

- 已部署到 `47.111.150.169`，`install-server.sh` 给 `/etc/liangchao.env` 补上了 `LD_SMTP_*` 占位段。
- 服务器上建了账号 `Liangchao`（邮箱 `1373917993@qq.com`，`cli.mjs add-account` 直接置为已验证）。
  线上实测：答题「刘克」→ 登录 `Liangchao` → 日记页是空的「写第一篇」→ 写了一篇 → 删掉，全程正常。
- 注册链路暂时返回 503 `mail_unavailable`（SMTP 账号密码还没填），页面提示「邮件服务暂时发不出去，稍后再试或联系管理员」；
  注册失败时 pending 账号会回滚，实测服务器库里没有留下残号。
- 还差一步：`sudo bash deploy/smtp-setup.sh 1373917993@qq.com <QQ邮箱SMTP授权码>`，然后注册页就能真发信。

### 发信通道已接通（2026-10-29 21:5x）

- 发信用的是小号邮箱 `liangchao_070626@qq.com`（不是站点主邮箱），`LD_MAIL_FROM` 与之相同，
  发件人显示「我们的小站」。授权码写在 `/etc/liangchao.env` 的 `LD_SMTP_PASS`，权限 640 root:www-data。
- 先用 `1373917993@qq.com` 试过，QQ 返回 `535 Login fail`——授权码和生成它的那个账号绑定，
  换账号就对不上，只能用小号本身。
- 直连 SMTP 发一封测试信 → `SEND OK`；`POST /api/auth/register` 真实调用 → 201 `pending`（不再 503），
  说明邮件被 QQ 接受了；浏览器里走完注册页第一步，界面正常进到「填验证码」并开始 58 秒倒计时。
- 测试用的待验证账号（`MailTest` / `MailTest2`）验证完即从库里删掉，邮箱不占用。
- 未做：邮件进入垃圾箱的概率、QQ 对高频发信的限流，等有真实注册量再看。

## 13. 广场：登录账号共用的墙（2026-10-29 深夜）

### 边界

- 只有登录的账号能看、能发（和日记同一道门）；不做回复、点赞、发图，不渲染 HTML/Markdown。
- 作者可删自己的帖子，别人删一律 404；站长用 `cli.mjs plaza-rm <id>` 兜底。
- **明文存储**：日记整条加密是因为私密，广场本来就是给所有人看的，加密只会让每次翻页多 20 次
  AES 解密。代价写进 README：数据库和备份里的广场正文可以直接读。

### 数据模型

```sql
CREATE TABLE plaza (
  id         INTEGER PRIMARY KEY,        -- 也当时间序用，id 只增不减
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  body       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX plaza_account ON plaza(account_id, id DESC);
```

删账号时帖子跟着走（`foreign_keys=ON` 已在建库时打开）。分页游标就是「上一页最后一个 id」，
`WHERE id < ? ORDER BY id DESC LIMIT ?`，多取一条判断 `hasMore`，不需要 count 也能翻页；
`total` 只在第一页算一次。

### 限流

| 规则 | 值 | 实现 |
|---|---|---|
| 一条最长 | 500 字 | `LD_PLAZA_MAXLEN`，服务端 trim 后按字符数算 |
| 冷却 | 20 秒一条 | `LD_PLAZA_COOLDOWN`，查该账号最后一条的 `created_at` |
| 每小时 | 20 条 | `LD_PLAZA_HOURLY`，数 `created_at > now-1h` 的行数 |
| 每页 | 20 条（最多 50） | `LD_PLAZA_PAGE` |

限流**不从内存桶算**（那是登录/答题的 `hitRate`）：重启后进程内的窗口会清零，
而「20 秒一条」必须跨重启也成立；同时被拒绝的请求不该吃掉一次额度。
代价是每次发帖多两条走索引的小查询，量级上可以忽略。

### 前端

`plaza.html` + `css/plaza.css` + `js/plaza.js`，直接复用 `diary.css` 的纸色、顶栏、masthead——
两个页面是同一个房间的两面，颜色跳变比省几行 CSS 更刺眼。`js/auth.js` 加 `loadPlaza / postPlaza / deletePlaza`。

帖子里所有内容走 `textContent`，`<b>` 只会显示成字面的 `<b>`；正文用 `white-space: pre-line`
保留换行，`overflow-wrap: anywhere` 防止一串英文数字撑破版面。429 时按钮跟着服务端给的
`retryAfter` 一起倒数，省得用户一下下点。

### 踩坑

- **浏览器缓存的旧 `auth.js`**：改了 `js/auth.js` 加 `loadPlaza`，页面里 `Auth.loadPlaza` 是 `undefined`，
  表现为广场一直停在「正在打开广场…」，服务器日志里**根本没有 `/api/plaza` 请求**。
  nginx/静态服务给 js 设了 `Cache-Control: max-age=3600`，刷新不会重新拉。
  修法：`fetch('/js/auth.js', {cache:'reload'})` 把缓存换掉再刷新；以后改 js 要么换 URL 后缀，要么强制 reload。
- 表单/按钮 id 别和 DOM 内置属性重名（上一次是 `forgot.html` 的 `reset`），这次没有新犯，记着。

### 遗留

- 没有实时刷新：别人新发的帖子要重新进页面才看得到（没上 SSE/WebSocket，2C2G 不划算）。
- 广场内容明文进备份（`pull-backup.ps1` 拉回本机的 db 里同样能读）。
- 没有举报/屏蔽；只有站长 CLI 能强行删。

## 14. 两个线上 bug：等 3000 秒 / 收不到验证码

上线后用户报的两件事，起因是同一个：**发信失败没有和限流分开算**。

### 症状一：等候时间 3000 多秒

- `issueCode` 先写 `email_codes` 行、再发信。信发不出去时行留在库里，
  于是 60 秒冷却照算、每小时 5 封的额度照扣。
- 用户收不到信 → 一分钟后重试 → 再扣一格……第五次之后 `too_many` 返回
  `retryAfter` 最大 3600，页面按秒显示就成了「等 3000 多秒」。
- 修法：
  - 发信失败（`sendCode` 抛错）→ `stmt.codeDelete.run(rowid)` 把行删掉，冷却与额度都不消耗；
  - 失败另有独立计数 `sendFailures`（同一地址 15 分钟内 3 次），失败多时返回 `mail_unavailable` + `retryAfter`，
    不再无限打 SMTP；
  - 限流窗口从 1 小时改成 **15 分钟**（`codeWindowSec`、`plazaWindowSec`），最坏等待从 3600 秒降到 900 秒；
  - 前端 `AccountUI.waitText()`：超过 90 秒换成「12 分钟」，不再打印裸秒数。

### 症状二：服务端说发了，收不到

先分清「我们没发」和「对方没收」：

- 日志里 `[mail] sent purpose=... to=域名` 是 SMTP 收下了；`[mail] failed ... err=...` 才是我们没发。
- `cli mail-test <地址>` 会真发一封测试信，用来验证通道。
- 常见原因：收件方丢进垃圾箱 / 「广告邮件」分类；地址打错；对端拦截。
- 这次顺手补了 `Message-ID`（之前缺，QQ/163 会因此给垃圾分）和 `Reply-To`；
  页面在「已发送」提示里加了「收不到先翻翻垃圾箱」。

### 教训

- **别把「我们这边失败」算成「用户操作太频繁」**：限流额度要发信成功才扣。
- 给人看的等待时间要换单位；3600 秒这种数字本身就是 bug 的信号。
- 「已发送」只代表 SMTP 收下，投递是别人的事——所以要能事后从日志里区分。

## 15. 导出明文：服务器过期时怎么把日记还给作者

需求是「服务器到期了能不能把日记导出来给用户」——这决定了数据必须**在任何时候都能离线解开**，
而不只是「站长有权限看」。所以做了两个入口，都只读，都不碰线上库：

- `server/cli.mjs export-diary <账号> [dir]` / `export-all [dir]`：在线导出，`0600` 权限；
- `deploy/export-from-backup.ps1`：完全离线，拿 `pull-backup.ps1` 已经拉到本机的
  `liangchao.db` + `ld-key.env`，用 `LD_DATA_DIR` 指向临时副本、`LD_DATA_KEY` 从 key 文件里抠出来，
  跑同一套 `export-all`。服务器整台消失也不影响。

每个账号输出 `.json`（全字段，便于迁移或再导入）和 `.md`（按日期排好，可以直接发给作者）。
实现上唯一新增的解密点就是 `exportAccount()` 里的 `openEntry()`——`openEntry` 本来就在用，
所以命令很短，落地成本几乎为零。

写这个时的两个取舍：

- **不做「站长查看某人的日记」这个功能**，只做「导出」。前者是静默私读，后者有明确用途
  （返还数据、迁移、关站），并且在文件层面留下痕迹（谁在什么时候让谁导了什么）。
- 导出物必须提醒是明文。`.md` 就是准备直接发给人的，`.json` 是给程序用的，
  两者都不该留在服务器上，也不该进 git。

### 遗留

- 没有网页端的「导出我的日记」按钮。要做的话得先想清楚限流与体积（单人 5 MB 上限已经存在），
  以及导出期间的内存占用（一次全解出来再写文件，2C2G 上 5 MB 没问题，但别做成流式循环之外的放大）。
- 导出没有审计日志，只在 shell 历史里。真要多账号运营时应该记一行。

## 16. 万圣节背景：给「纸页」加一层夜色

需求只有一句「换成网站背景，适当调整大小和不透明度」，实际要解决三件事：

### 为什么不直接 background-image

素材是带 CSS 动画的 SVG（幽灵飘、蝙蝠扇翅）。SVG 一旦作为 `<img>` 或 `background-image`
加载，就变成「独立文档」渲染，**文档内的 CSS 动画不跑**。所以 `js/page-bg.js` 用 `fetch`
取回源码再 `innerHTML` 内联进 `<div class="page-bg" data-page-bg>`，SVG 才和主文档同属一棵树。

代价是 id 会进主文档：素材里 26 个 id 全部加了 `hb-` 前缀，否则会和 `index.html` 已有的
`id="cloud"` 撞车（内联后同一个文档里 id 必须唯一，撞了 CSS 选择器会串）。

### 怎么「调整大小」

- 去掉 SVG 根节点写死的 `width="1920" height="1080"`，交给 CSS `width/height:100%`；
- SVG 自带 `preserveAspectRatio="xMidYMid slice"`，于是**等比裁切**铺满，手机竖屏也不会压扁；
- `position:fixed; inset:0` 而不是塞进文档流——纸页内容很长，塞进流里会跟着滚。

### 怎么「调整不透明度」

直接压低整体 opacity 会让中间正文一起发灰，所以是两层：

1. `--bg-opacity`（默认 `.62`，窄屏 `.5`）控制整层浓淡；
2. 叠一层径向 `mask-image`，中间近乎透明、四周才露夜色——正文区保住纸色（实测正文 luma 241，
   纯纸 246），页边降到 132–211。

`z-index:-2` 是刻意的：`diary.css` 里 `body::before` 是纸张颗粒层（`z-index:-1`），背景要压在它下面，
颗粒才盖得住夜色，不至于看起来像贴在玻璃上。

### 范围

只给「纸页」加：日记、广场、注册、找回密码、账号设置。首页（问答 + 登录）用户明确说不要动，
所以 `index.html` 与改动前完全一致（`git diff -- index.html` 为空）。

### 遗留

- 背景是装饰，`aria-hidden="true"`；`page-bg.js` 整段 try/catch，取不到就静默不显示，不影响任何功能。
- 换图要改文件名或加 `?v=2`：nginx 给 svg 设了 30 天 immutable 缓存。
- 素材版权要自己确认（这次是用户提供的 `halloween-bg-v5.svg`）。

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
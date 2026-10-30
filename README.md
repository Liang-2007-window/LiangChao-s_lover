# 梁超的恋人 · LiangChao's Lover

一个两层的小站：第一层是夏天的海和一道只有一个人答得对的问题，第二层是黄昏和两个人的日记本。
现在是动态站——日记存在服务器 SQLite 里，密码在服务端校验，正文整体 AES-256-GCM 加密后落库。
账号可以自己注册（邮箱验证码验证），彼此看不到对方的日记；广场是登录后所有人都看得见的一面墙。

## 目录

```
index.html / diary.html      两个主页面
plaza.html                   广场：登录账号共用的留言墙
register.html / forgot.html / settings.html   注册、找回密码、账号设置
css/ js/ images/ audio/ fonts/   静态资源（Nginx 直接发）
css/theme.css                 万圣节背景层（只影响日记/广场/账号这几张纸页）
js/page-bg.js                 把 images/halloween-bg.svg 内联进页面（背景图里的动画才会跑）
server/                      后端：node:http + node:sqlite，零 npm 依赖
  index.mjs                  路由、会话、限流、请求日志
  db.mjs                     建表与预编译语句
  security.mjs               scrypt 口令、AES-GCM、会话 token、锁定
  entry.mjs                  日记载荷加解密（整条加密）
  mail.mjs                   发信：自己写的 SMTP 客户端（无 nodemailer）
  codes.mjs                  邮箱验证码：签发、冷却、次数上限、校验
  config.mjs / http.mjs / static.mjs / cli.mjs
tests/api.test.mjs           同进程端到端测试（18 项）
tests/mail.test.mjs          SMTP 客户端测试，跑在进程内的假邮件服务器上（6 项）
tests/plaza.test.mjs         广场测试：权限、分页、限流（9 项）
deploy/                      nginx 配置、systemd 单元、安装/备份/发布脚本
docs/dynamic-plan.md         设计说明：架构、加密、容量预算、阶段计划
```

## 本地开发

```powershell
# server/.env 里放 LD_DATA_KEY / LD_DATA_DIR / LD_SERVE_STATIC=1
node server/index.mjs          # http://127.0.0.1:3000 同时发静态和 API
node tests/api.test.mjs        # 18 项接口测试
node tests/mail.test.mjs       # 6 项 SMTP 测试
node tests/plaza.test.mjs      # 9 项广场测试
node server/cli.mjs list       # 账号、邮箱、篇数
node server/cli.mjs add-account <账号> <密码> [邮箱]
node server/cli.mjs plaza-list [条数]    # 最近几条广场帖
node server/cli.mjs plaza-rm <id>        # 删任意一条（作者自己也能在页面上删）
```

本地不想配邮箱时，启动前设 `LD_DEV_MAIL=1`：验证码不发送，直接打在服务器日志里（`[mail:dev] ... code=123456`），
注册页照常用。

## 账号体系

- **注册**：账号 + 邮箱 + 密码 → 服务端校验并建「待验证」账号 → 发 6 位验证码（10 分钟有效）
  → 填对验证码才真正可用，并直接登录。没验证的账号登不进来，24 小时后由 `cli.mjs prune` 清掉。
- **密码规则**：8–64 位，必须同时含字母和数字。校验在服务端（`server/index.mjs` 的 `checkPassword`）。
- **每个账号的日记彼此隔离**：所有查询都带 `account_id`，换账号只看得到自己的。
- **忘记密码**：账号 + 邮件验证码 + 新密码。重置会同时清掉这个账号的全部会话（别处已登录的设备全部掉线）。
- **账号设置**（`settings.html`）：换绑邮箱、改密码，两者都要往**当前**邮箱发验证码确认；
  改密码后只保留当前设备的登录。
- **防枚举**：找回密码时账号不存在也返回「已发送」；验证码只存 `sha256(email|purpose|code)`。
- **限制**：同一邮箱每个用途 60 秒冷却、**15 分钟**内最多 5 封；同一 IP 15 分钟内 10 封验证码、3 次注册；
  验证码最多试 5 次；单账号最多 500 篇 / 5 MB 密文。
  发信失败的次数单独记，**不占用户额度**——邮件发不出去时不会把人越锁越久（这条是给「等 3000 秒」那个 bug 用的）。

### 配置发验证码的邮箱（QQ 邮箱）

QQ 邮箱「设置 → 账户 → 开启 SMTP 服务 → 生成授权码」（**不是**登录密码），然后在服务器上：

```bash
sudo bash /srv/liangchao/app/deploy/smtp-setup.sh 1373917993@qq.com <授权码>
```

脚本会改写 `/etc/liangchao.env` 里的 `LD_SMTP_*` 并重启服务。没配置时注册接口返回 503
`mail_unavailable`，已有账号的登录不受影响。

线上当前用的是小号邮箱 `liangchao_070626@qq.com` 发信（发件人显示「我们的小站」）。
它只用来发验证码，不读信，授权码泄露了随时在 QQ 邮箱里吊销重生成。

**「说发出去了但没收到」怎么查**：

1. 先翻收件人的垃圾箱 / 「广告邮件」分类——QQ 邮箱对陌生发件人的首封信偶尔会这么放。
2. 服务器上有 `mail-test`，会真发一封：
   ```bash
   runuser -u www-data -- env LD_ENV_FILE=/etc/liangchao.env \
     /usr/local/bin/node /srv/liangchao/app/server/cli.mjs mail-test 收件地址
   ```
   打印 `ok: the SMTP server accepted the message` 说明是我们这边交出去了；
   收不到就是收件方丢了（垃圾箱、拦截规则、地址写错），不是服务端问题。
3. 服务日志里有 `[mail] sent purpose=... to=域名` 和 `[mail] failed ... err=...`，
   区分「我们发了」和「我们没发」。日志不记验证码本身。

## 页面背景（万圣节）

日记、广场、注册、找回密码、账号设置这几张“纸页”背后铺了一层万圣节夜景。

- 素材：`images/halloween-bg.svg`（1920×1080，自带幽灵/蝙蝠浮动动画）。
- 注入：`js/page-bg.js` 读 SVG 后 **内联**进 `<div class="page-bg" data-page-bg>`。
  用 `background-image` 或 `<img>` 引进来动画是停的——SVG 作为图片文档不跑 CSS 动画。
- 尺寸：SVG 的 `width/height` 被去掉，交给 CSS `width/height:100%`，靠文件自带的
  `preserveAspectRatio="xMinYMid slice"` 自动铺满（等比裁切，不变形；竖屏从**最左边**开始裁，
  居中裁会把主体切掉）。竖屏一屏只能看到 16:9 素材左侧约 1/4 宽的画面，这是 slice 的固有代价。
- 浓淡：`css/theme.css` 的 `--bg-opacity`（默认 `.62`，窄屏 `--bg-opacity-narrow`）。
  再配一层径向遮罩，中间文字区保持纸色，只在四周露出来——不然深色夜空会把正文对比度压垮。
- 首页（问答 + 登录）**没有**这一层，保持原样。
- 想关掉某个页面：删掉该页的 `<div class="page-bg" …>` 和 `js/page-bg.js` 两行即可。
- 换图注意：SVG 内联后 id 会进主文档，必须加前缀（现有素材已改成 `hb-` 前缀，
  `index.html` 里就有一个 `id="cloud"`）；nginx 给 svg 设了 30 天 immutable，
  换图时必须把 `js/page-bg.js` 里默认地址的 `?v=N` 加一，否则手机不会重新拉。

## 广场

`plaza.html`：登录之后所有人都能看见的一面墙，和日记正好相反。

- **谁能看**：只有登录的账号。没登录打开广场会被送回首页；`/api/plaza` 未登录返回 401。
- **谁能删**：只有作者本人。别人的帖子在删除接口上返回 404，和其他账号无关的 id 表现一致。
- **存储**：广场内容**明文**存进 `plaza` 表——它本来就是公开的，明文让翻页不必逐条解密。
  日记正文仍是 AES-256-GCM 密文，两者不要混为一谈：**备份文件里的广场内容是能直接读的**。
- **限制**：一条最多 500 字（`LD_PLAZA_MAXLEN`）、同一账号 20 秒内只能发一条
  （`LD_PLAZA_COOLDOWN`）、15 分钟内最多 20 条（`LD_PLAZA_HOURLY`，窗口长度 `LD_PLAZA_WINDOW`）；
  列表每页 20 条（`LD_PLAZA_PAGE`，最多 50）。限流按数据库里的发帖记录算，重启不会清零。
- **不做**：回复、点赞、发图、渲染 HTML 或 Markdown。帖子里写的 `<b>` 只会当字面文字显示。
- **清场**：作者自己删，或站长在服务器上 `node server/cli.mjs plaza-rm <id>`。

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

### 本机异地备份

服务器上那份备份和服务器同生共死，所以再拉一份到自己的电脑：

```powershell
pwsh -File deploy\pull-backup.ps1        # 手动拉一次
```

- 落在 `D:\liangchao-backup\yyyy-MM-dd\`（`liangchao.db` + `ld-key.env`），另有 `latest\` 一份最新的。
- 拉完会自己校验：db 文件头是 `SQLite format 3`、密钥里有 64 位 `LD_DATA_KEY`。
- 本机保留 30 天，日志在 `D:\liangchao-backup\pull.log`。
- 已注册 Windows 任务计划 `Liangchao-Diary-Backup`，每天 09:00 跑一次；错过时间（电脑没开）
  会在下次开机后补跑。删掉用：`Unregister-ScheduledTask -TaskName Liangchao-Diary-Backup`
- 拉下来的 `ld-key.env` 是能解开全部日记的密钥，**不要**放进 git 仓库或共享网盘目录；
  想更保险可以用加密压缩包再扔网盘（7z/zip 带密码）。

### 导出明文日记（把日记还给作者 / 服务器不在了）

有两个入口，都**只读**，不会动线上数据：

```bash
# 服务器还在：单个账号，导出到服务器目录（0600）
runuser -u www-data -- env LD_ENV_FILE=/etc/liangchao.env \
  /usr/local/bin/node /srv/liangchao/app/server/cli.mjs export-diary <账号> /var/backups/liangchao/export

# 服务器还在：全部账号各一份
runuser -u www-data -- env LD_ENV_FILE=/etc/liangchao.env \
  /usr/local/bin/node /srv/liangchao/app/server/cli.mjs export-all /var/backups/liangchao/export
```

```powershell
# 服务器已经没了：用本机备份离线导，不需要连服务器
pwsh -File deploy\export-from-backup.ps1
pwsh -File deploy\export-from-backup.ps1 -Db D:\liangchao-backup\2026-10-29\liangchao.db `
  -KeyEnv D:\liangchao-backup\2026-10-29\ld-key.env -Out D:\liangchao-export
```

每个账号得到两个文件：`<账号>-<时间>.json`（原样全字段，便于再导入或写进别的程序）和
`<账号>-<时间>.md`（按日期排好、能直接发给人看）。两条路径都要求 `LD_DATA_KEY`
能对上——**密钥丢了就只剩密文**，db 和 key 必须一起备份、一起保存。

导出物是**明文**：给人之后就不是秘密了，导完记得清理中间文件。

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
| GET | `/api/auth/me` | 当前用户 + 已写篇数 |
| POST | `/api/auth/register` | `{account,password,email}` → 建待验证账号并发码 |
| POST | `/api/auth/verify-email` | `{account,code}` → 激活并登录 |
| POST | `/api/auth/code` | `{purpose,account?}`，purpose=`register\|reset\|change-email\|change-password` |
| POST | `/api/auth/reset` | `{account,code,password}` → 重置密码并清掉全部会话 |
| PUT | `/api/account/email` | `{email,code}` → 换绑邮箱（码发到旧邮箱） |
| PUT | `/api/account/password` | `{password,code}` → 改密码，其它设备掉线 |
| GET | `/api/diary?order=new\|old` | 列表（解密后返回） |
| POST | `/api/diary` | 新建 |
| PUT / DELETE | `/api/diary/:id` | 修改 / 删除 |
| POST | `/api/quiz/answer` | 问题答案服务端校验（6 次/分钟） |
| GET | `/api/plaza?before=&limit=` | 广场列表（需登录），按 id 倒序，`hasMore` / `total` |
| POST | `/api/plaza` | `{body}` → 发一条（≤500 字，20 秒冷却） |
| DELETE | `/api/plaza/:id` | 删自己那条，别人的一律 404 |

写操作校验 `Origin`，不匹配返回 403 `bad_origin`；登录同一 IP+账号 5 次/分钟，连错 3 次起 15 秒
翻倍封顶 15 分钟，计数在服务端。
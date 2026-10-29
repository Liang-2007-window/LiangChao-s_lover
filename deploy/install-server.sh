#!/usr/bin/env bash
# ============================================================
#  服务器一次性安装（可重复执行）：目录 / 权限 / systemd / nginx / cron
#  用法（服务器上）：sudo bash deploy/install-server.sh
#  前置：node 已装在 /usr/local/bin/node，nginx 已装
# ============================================================
set -euo pipefail

APP_DIR=/srv/liangchao/app
DATA_DIR=/var/lib/liangchao
ENV_FILE=/etc/liangchao.env
HERE=$(cd "$(dirname "$0")" && pwd)

echo "==> 1/7 目录"
install -d -o www-data -g www-data -m 750 "$DATA_DIR"
install -d -o www-data -g www-data -m 755 /srv/liangchao
chown -R www-data:www-data "$APP_DIR" 2>/dev/null || true

echo "==> 2/7 环境文件"
if [ ! -f "$ENV_FILE" ]; then
  umask 077
  KEY=$(openssl rand -hex 32)
  cat >"$ENV_FILE" <<EOF
# 主密钥：解密全部日记，务必和数据库一起备份，丢了日记就永久打不开
LD_DATA_KEY=$KEY
LD_DATA_DIR=$DATA_DIR
LD_HOST=127.0.0.1
LD_PORT=3000
LD_SESSION_DAYS=14
LD_QUIZ_ANSWER=刘克
LD_LOG=1
EOF
  echo "    已生成新密钥 -> $ENV_FILE"
else
  echo "    已存在，跳过（不会覆盖你的密钥）"
fi
chown root:www-data "$ENV_FILE"
chmod 640 "$ENV_FILE"

echo "==> 3/7 systemd 服务"
install -m 644 "$HERE/liangchao.service" /etc/systemd/system/liangchao.service
systemctl daemon-reload
systemctl enable liangchao >/dev/null
systemctl restart liangchao
sleep 1
systemctl --no-pager --lines=5 status liangchao || true

echo "==> 4/7 Nginx 站点"
install -d -m 755 /etc/nginx/snippets
install -m 644 "$HERE/liangchao-headers.conf" /etc/nginx/snippets/liangchao-headers.conf
if [ -f /etc/ssl/liangchao/fullchain.pem ]; then
  install -m 644 "$HERE/nginx-liangchao-tls.conf" /etc/nginx/sites-available/liangchao
  echo "    已找到证书（/etc/ssl/liangchao），装 HTTPS 版配置"
else
  install -m 644 "$HERE/nginx-liangchao.conf" /etc/nginx/sites-available/liangchao
  echo "    还没有证书，先用 HTTP 版；签好证书后跑 deploy/issue-cert.sh"
fi
ln -sfn /etc/nginx/sites-available/liangchao /etc/nginx/sites-enabled/liangchao
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "==> 5/7 备份脚本 + 定时任务"
install -m 755 "$HERE/backup.sh" /usr/local/bin/liangchao-backup.sh
cat >/etc/cron.d/liangchao-backup <<'EOF'
# 每天 03:20 备份数据库与主密钥
20 3 * * * root /usr/local/bin/liangchao-backup.sh >>/var/log/liangchao-backup.log 2>&1
EOF
chmod 644 /etc/cron.d/liangchao-backup

echo "==> 6/7 日志轮转（nginx 自带 logrotate 已覆盖；Node 日志走 journald）"
mkdir -p /var/log/journal
systemctl restart systemd-journald 2>/dev/null || true

echo "==> 7/7 自检"
if [ -f /etc/ssl/liangchao/fullchain.pem ]; then
  curl -fsS -o /dev/null -w "api  /api/health -> %{http_code}\n" --resolve selfweb.eu.cc:443:127.0.0.1 https://selfweb.eu.cc/api/health || { echo "!! API 没起来，看 journalctl -u liangchao -n 50"; exit 1; }
  curl -fsS -o /dev/null -w "static / -> %{http_code}\n" --resolve selfweb.eu.cc:443:127.0.0.1 https://selfweb.eu.cc/
else
  curl -fsS -o /dev/null -w "api  /api/health -> %{http_code}\n" http://127.0.0.1/api/health || { echo "!! API 没起来，看 journalctl -u liangchao -n 50"; exit 1; }
  curl -fsS -o /dev/null -w "static / -> %{http_code}\n" http://127.0.0.1/
fi
echo "完成。"
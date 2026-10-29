#!/usr/bin/env bash
# ============================================================
#  申请 Let's Encrypt 证书并切到 HTTPS
#
#  为什么不用 certbot + HTTP-01：
#    这台机器在阿里云，未备案域名走 80 端口会被 ICP 拦截
#    （返回 403 + "Non-compliance ICP Filing"），Let's Encrypt 的
#    HTTP-01 校验必然失败。但 443 端口的 TLS 不受影响，所以改用
#    acme.sh 的 tls-alpn-01 模式（standalone，临时占 443 端口验证）。
#
#  前置：selfweb.eu.cc / www 的 A 记录已指向本机；443 端口公网可达
#  用法：sudo bash deploy/issue-cert.sh
#  续期：cron 每天 04:17 跑 /usr/local/bin/liangchao-renew.sh（本脚本会装好）
# ============================================================
set -euo pipefail

DOMAIN=selfweb.eu.cc
ALT=www.$DOMAIN
EMAIL=1373917993@qq.com
SSL_DIR=/etc/ssl/liangchao
ACME_HOME=/root/.acme.sh
ACME_REPO=/opt/acme.sh
HERE=$(cd "$(dirname "$0")" && pwd)
export LE_WORKING_DIR="$ACME_HOME"

# nginx 起来时 reload，没起来时跳过（续期时 nginx 是停着的，不能报错中断）
RELOAD_CMD="systemctl is-active --quiet nginx && systemctl reload nginx || true"

echo "==> 0/6 检查 DNS 是否已指向本机"
IP=$(curl -fsS https://4.ipw.cn 2>/dev/null || curl -fsS ifconfig.me 2>/dev/null || echo "")
echo "    本机公网 IP: $IP"
for d in "$DOMAIN" "$ALT"; do
  got=$(getent ahostsv4 "$d" | awk 'NR==1{print $1}')
  echo "    $d -> ${got:-（无解析）}"
  if [ -n "$IP" ] && [ "$got" != "$IP" ]; then
    echo "!! $d 还没指向本机，先改 DNS 再来（生效后等 1-5 分钟）" >&2
    exit 1
  fi
done

echo "==> 1/6 安装 socat（acme.sh 的 alpn 监听器要用）"
export DEBIAN_FRONTEND=noninteractive
command -v socat >/dev/null || apt-get install -y socat >/dev/null

echo "==> 2/6 安装 acme.sh（从 gitee 拉，GitHub raw 在这台机器上不通）"
if [ ! -x "$ACME_HOME/acme.sh" ]; then
  rm -rf "$ACME_REPO"
  GIT_TERMINAL_PROMPT=0 git clone --depth 1 https://gitee.com/neilpang/acme.sh.git "$ACME_REPO" >/dev/null
  (cd "$ACME_REPO" && ./acme.sh --install -m "$EMAIL" --home "$ACME_HOME" >/dev/null)
fi
"$ACME_HOME/acme.sh" --version

echo "==> 3/6 用 tls-alpn-01 签发（需要 443 端口空闲）"
if [ -f "$SSL_DIR/fullchain.pem" ]; then
  echo "    已存在证书，跳过签发（要强制重签就删掉 $SSL_DIR 再跑）"
else
  if ss -lnt | grep -q ':443 '; then
    echo "!! 443 被占用，先停 nginx；已经上了 HTTPS 的话改用 /usr/local/bin/liangchao-renew.sh 续期" >&2
    exit 1
  fi
  "$ACME_HOME/acme.sh" --set-default-ca --server letsencrypt >/dev/null
  "$ACME_HOME/acme.sh" --issue --alpn -d "$DOMAIN" -d "$ALT" --server letsencrypt

  echo "==> 4/6 安装证书到 $SSL_DIR"
  install -d -m 755 "$SSL_DIR"
  "$ACME_HOME/acme.sh" --install-cert -d "$DOMAIN" --ecc \
    --key-file "$SSL_DIR/privkey.pem" \
    --fullchain-file "$SSL_DIR/fullchain.pem" \
    --reloadcmd "$RELOAD_CMD"
fi

echo "==> 5/6 切到 HTTPS 配置"
install -d -m 755 /etc/nginx/snippets
install -m 644 "$HERE/liangchao-headers.conf" /etc/nginx/snippets/liangchao-headers.conf
install -m 644 "$HERE/nginx-liangchao-tls.conf" /etc/nginx/sites-available/liangchao
nginx -t
systemctl reload nginx

echo "==> 6/6 续期包装脚本 + cron"
install -m 755 "$HERE/renew-cert.sh" /usr/local/bin/liangchao-renew.sh
# acme.sh 自己装的 cron 会在 nginx 占着 443 时失败，删掉换成带停/起 nginx 的包装脚本
crontab -l 2>/dev/null | grep -v 'acme.sh --cron' | grep -v 'liangchao-renew.sh' >/tmp/ct.now || true
echo '17 4 * * * /usr/local/bin/liangchao-renew.sh' >>/tmp/ct.now
crontab /tmp/ct.now && rm -f /tmp/ct.now

echo "==> 自检"
curl -fsS -o /dev/null -w "https 首页     -> %{http_code}\n" --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/"
curl -fsS -o /dev/null -w "https /api/health -> %{http_code}\n" --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health"
openssl x509 -in "$SSL_DIR/fullchain.pem" -noout -subject -dates
echo "完成。续期：cron 每天 04:17 跑 liangchao-renew.sh（停 nginx → acme.sh 检查 → 起 nginx）。"
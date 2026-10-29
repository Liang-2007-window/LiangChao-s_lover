#!/usr/bin/env bash
# ============================================================
#  配置「发验证码」用的邮箱，并重启服务
#  用法（服务器上）：sudo bash deploy/smtp-setup.sh <邮箱> <SMTP授权码> [发件人名字]
#
#  例：sudo bash deploy/smtp-setup.sh 1373917993@qq.com abcdabcdabcdabcd
#
#  QQ 邮箱的授权码不是登录密码：设置 → 账户 → 开启 SMTP → 生成授权码。
#  重复执行会覆盖上一次的值。
# ============================================================
set -euo pipefail

ENV_FILE=/etc/liangchao.env
USER_MAIL=${1:-}
AUTH=$(printf '%s' "${2:-}" | tr -d ' ')
FROM_NAME=${3:-我们的小站}

if [ -z "$USER_MAIL" ] || [ -z "$AUTH" ]; then
  echo "用法: $0 <邮箱> <SMTP授权码> [发件人名字]" >&2
  exit 2
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "找不到 $ENV_FILE，先跑 deploy/install-server.sh" >&2
  exit 1
fi

TMP=$(mktemp)
# 先删掉旧的 SMTP 行，再统一追加，避免同一个键出现两次
grep -v -E '^LD_SMTP_|^LD_MAIL_FROM|^LD_MAIL_FROM_NAME=' "$ENV_FILE" >"$TMP" || true
cat >>"$TMP" <<EOF
LD_SMTP_HOST=smtp.qq.com
LD_SMTP_PORT=465
LD_SMTP_TLS=1
LD_SMTP_USER=$USER_MAIL
LD_SMTP_PASS=$AUTH
LD_MAIL_FROM=$USER_MAIL
LD_MAIL_FROM_NAME=$FROM_NAME
EOF

install -m 640 -o root -g www-data "$TMP" "$ENV_FILE"
rm -f "$TMP"

systemctl restart liangchao
sleep 1

# 服务起来了吗
if ! curl -fsS -o /dev/null http://127.0.0.1:3000/api/health; then
  echo "!! 服务没起来，看 journalctl -u liangchao -n 50" >&2
  exit 1
fi

echo "已写入 $ENV_FILE 并重启服务。"
echo "发件人：$FROM_NAME <$USER_MAIL>"
echo "现在去网站上试一下注册，或者在服务器上看日志确认："
echo "  journalctl -u liangchao -f | grep -i mail"
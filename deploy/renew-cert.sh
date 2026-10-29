#!/usr/bin/env bash
# ============================================================
#  证书续期包装脚本（装到 /usr/local/bin/liangchao-renew.sh，由 cron 每天调用）
#
#  为什么需要它：该域名在阿里云未备案，80 端口被 ICP 拦截，只能用
#  acme.sh 的 tls-alpn-01 模式验证——而 alpn 验证必须独占 443，
#  所以先停 nginx，续完再拉起来。acme.sh 自己的 cron 在没有这层包装时
#  会因为 443 被 nginx 占着而失败。
#
#  没到期时 acme.sh 会自己跳过，nginx 停/起只有 1-2 秒。
# ============================================================
set -uo pipefail

export LE_WORKING_DIR=/root/.acme.sh
LOG=/var/log/liangchao-renew.log

[ "$(id -u)" = 0 ] || { echo "must run as root" >&2; exit 1; }
[ -x /root/.acme.sh/acme.sh ] || { echo "acme.sh not installed" >&2; exit 1; }

systemctl stop nginx
/root/.acme.sh/acme.sh --cron --home /root/.acme.sh >>"$LOG" 2>&1
rc=$?
systemctl start nginx

# 续期日志会越长越大，超过 1MB 就截断
if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt 1048576 ]; then
  tail -c 200000 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

echo "$(date -Is) renew rc=$rc nginx=$(systemctl is-active nginx)" >>"$LOG"
exit 0
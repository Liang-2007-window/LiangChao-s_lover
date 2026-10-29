#!/usr/bin/env bash
# ============================================================
#  每日备份：数据库 + 主密钥 + 站点配置
#  /usr/local/bin/liangchao-backup.sh   ·  由 cron 每天 03:20 调用
#  保留 7 天；额外复制一份到 /root/backups（脱离 www-data 权限）
# ============================================================
set -euo pipefail

APP_DIR=/srv/liangchao/app
DATA_DIR=/var/lib/liangchao
OUT=/var/backups/liangchao
KEEP=7
STAMP=$(date +%Y%m%d-%H%M%S)
DB="$DATA_DIR/liangchao.db"

mkdir -p "$OUT"
chown www-data:www-data "$OUT" 2>/dev/null || true
chmod 700 "$OUT"

# 1) SQLite 热备份（.backup 在 WAL 模式下也安全）
sqlite3 "$DB" ".backup '$OUT/liangchao-$STAMP.db'"

# 2) 主密钥与配置（丢了密钥 = 日记永久不可读，必须单独备）
#    线上密钥在 /etc/liangchao.env 的 LD_DATA_KEY；若改用了 master.key 文件也一并备
if [ -f "$DATA_DIR/master.key" ]; then
  cp -a "$DATA_DIR/master.key" "$OUT/master-$STAMP.key"
fi
cp -a /etc/liangchao.env     "$OUT/env-$STAMP.txt" 2>/dev/null || true

chmod 600 "$OUT"/*

# 3) 校验备份能打开
sqlite3 "$OUT/liangchao-$STAMP.db" "PRAGMA integrity_check;" | grep -qx ok \
  || { echo "integrity_check failed on $STAMP" >&2; exit 1; }

# 4) 清理过期
find "$OUT" -maxdepth 1 -type f -mtime +$KEEP -delete

# 5) 本机第二份
mkdir -p /root/backups/liangchao
cp -a "$OUT/liangchao-$STAMP.db" /root/backups/liangchao/ 2>/dev/null || true
find /root/backups/liangchao -type f -mtime +$KEEP -delete 2>/dev/null || true

echo "[backup] ok $STAMP"
ls -lh "$OUT" | tail -n 5
#!/usr/bin/env bash
# 自动生成本机 IP / 域名的来源白名单并启动，避免「请求来源校验失败」(403)。
# 白名单通过环境变量传给 compose（优先级高于 .env），不会改写用户的 .env。
set -euo pipefail
cd "$(dirname "$0")"

PORT="$(sed -n 's/^HOST_PORT=//p' .env 2>/dev/null | head -1)"
PORT="${PORT:-8080}"
ORIGINS="http://127.0.0.1:${PORT},http://localhost:${PORT}"

IPS="$( { hostname -I 2>/dev/null || true; ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 || true; } )"
for ip in ${IPS}; do
  case "$ip" in
    127.*|"") continue ;;
  esac
  ORIGINS="${ORIGINS},http://${ip}:${PORT}"
done

EXTRA="$(sed -n 's/^EXTRA_ORIGINS=//p' .env 2>/dev/null | head -1)"
if [ -n "$EXTRA" ]; then
  ORIGINS="${ORIGINS},${EXTRA}"
fi

ORIGINS="$(printf '%s' "$ORIGINS" | tr ',' '\n' | sed '/^$/d' | awk '!seen[$0]++' | tr '\n' ',' | sed 's/,$//')"
export PUBLIC_ORIGINS="$ORIGINS"
printf '来源白名单：%s\n' "$ORIGINS"
docker compose up -d

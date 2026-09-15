#!/bin/sh
# 2026-09-15: Keep member cloud configuration refreshed without storing credentials in UCI.
# Usage: member-sync-cron.sh enable|disable
ACTION="$1"
CRONTAB=/etc/crontabs/root
TAG="# luci-app-daede member-sync"
SCRIPT=/usr/share/luci-app-daede/member-sync.sh

clean() {
    [ -f "$CRONTAB" ] || return 0
    sed -i "\\|$TAG|d;\\|$SCRIPT sync|d" "$CRONTAB"
}

clean
if [ "$ACTION" = enable ] && [ "$(uci -q get daede.member.auto_sync 2>/dev/null)" = 1 ]; then
    interval="$(uci -q get daede.member.sync_interval 2>/dev/null)"
    case "$interval" in
        ''|*[!0-9]*) interval=6 ;;
    esac
    if [ "$interval" -lt 1 ] 2>/dev/null || [ "$interval" -gt 24 ] 2>/dev/null; then
        interval=6
    fi
    schedule="0 */$interval * * *"
    if [ "$(uci -q get daede.member.sync_interval 2>/dev/null)" != "$interval" ]; then
        uci -q set daede.member.sync_interval="$interval"
        uci -q commit daede
    fi
    mkdir -p "$(dirname "$CRONTAB")"
    {
        cat "$CRONTAB" 2>/dev/null
        printf '%s\n' "$TAG"
        printf '%s %s sync >/dev/null 2>&1\n' "$schedule" "$SCRIPT"
    } > "$CRONTAB.tmp" && mv "$CRONTAB.tmp" "$CRONTAB"
fi
/etc/init.d/cron enable >/dev/null 2>&1 || true
/etc/init.d/cron restart >/dev/null 2>&1 || true
exit 0

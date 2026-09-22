#!/bin/sh
# update-pkg.sh <dae|daed|luci-app-daede>
# Refresh package indexes and upgrade the named package via apk (25.12+) or
# opkg (24.10). Forks the work to background so the LuCI RPC call returns
# immediately; the result is streamed to /tmp/luci-app-daede.pkg.<name>.log.

PKG="$1"
case "$PKG" in
	dae|daed|luci-app-daede) ;;
	*)
		echo "usage: $0 <dae|daed|luci-app-daede>" >&2
		exit 64
		;;
esac

# 2026-09-23: package migration is not an ordinary in-place upgrade.
TARGET="$PKG"
case "$PKG" in
 dae|daed) TARGET="$PKG-daede"; LEGACY_PACKAGES="$PKG" ;;
 luci-app-daede) LEGACY_PACKAGES="dae daed" ;;
esac
for legacy_package in $LEGACY_PACKAGES; do
 legacy=""
 if command -v apk >/dev/null 2>&1; then
  apk info -e "$legacy_package" >/dev/null 2>&1 && legacy=1
 elif command -v opkg >/dev/null 2>&1; then
  legacy=$(opkg status "$legacy_package" 2>/dev/null | awk -F': ' '$1=="Status" && $2 ~ / installed$/ {print 1}')
 fi
 if [ -n "$legacy" ]; then
  echo "Migration required: back up configuration and replace $legacy_package with $legacy_package-daede before using Upgrade." >&2
  exit 65
 fi
done

# run from a /tmp copy so upgrading luci-app-daede (which replaces this script)
# can't corrupt the in-flight upgrade
case "$0" in
	/tmp/.daede-upd-*) ;;
	*)
		_self="/tmp/.daede-upd-$$"
		cp "$0" "$_self" 2>/dev/null && exec sh "$_self" "$@"
		;;
esac

LOCK="/tmp/luci-app-daede.pkg-${PKG}.lock"
LOG="/tmp/luci-app-daede.pkg-${PKG}.log"

if [ -f "$LOCK" ]; then
	mtime=$(date -r "$LOCK" +%s 2>/dev/null || echo 0)
	age=$(( $(date +%s) - mtime ))
	if [ "$age" -lt 300 ]; then
		echo "${PKG} update already in progress (PID $(cat "$LOCK" 2>/dev/null), age ${age}s)" >&2
		exit 75
	fi
	rm -f "$LOCK"
fi

if ! ( set -C; echo "$$" >"$LOCK" ) 2>/dev/null; then
	echo "${PKG} update already in progress" >&2
	exit 75
fi

(
	exec >"$LOG" 2>&1
	trap 'rm -f "$LOCK"; [ "${0#/tmp/.daede-upd-}" != "$0" ] && rm -f "$0"' EXIT INT TERM

	echo "$(date '+%F %T') begin upgrade: $PKG"

	if command -v apk >/dev/null 2>&1; then
		# shared apk lock with the bg index refresh (avoid "Unable to lock database")
		(
			flock 9
			apk update 2>&1 || exit $?
			ver=$(apk list "$TARGET" 2>/dev/null | awk -v p="$TARGET" '$1 ~ "^" p "-[0-9]" { v=$1; sub("^" p "-", "", v); print v }' | sort -V | tail -1)
			if [ -n "$ver" ]; then
				constraint="$TARGET=$ver"
			else
				echo "result: 软件源中没有找到 $PKG，请检查网络或软件源配置"
				exit 1
			fi

			echo "--- apk add -s $constraint ---"
			if ! apk add -s "$constraint" 2>&1; then
				echo "note: apk 预检失败，通常是系统上其它软件包的问题，继续尝试升级"
			fi
			echo "--- apk add $constraint ---"
			apk add "$constraint" 2>&1
			exit $?
		) 9>/tmp/luci-app-daede.apk.lock
		rc=$?
		if [ "$rc" != 0 ]; then
			:
		elif ! apk list --installed 2>/dev/null | grep -q "^${TARGET}-[0-9]"; then
			echo "result: $PKG is not installed"
			rc=1
		elif apk list -u 2>/dev/null | grep -q "^${TARGET}-[0-9]"; then
			echo "result: $PKG still has a pending upgrade"
			rc=1
		else
			echo "result: $PKG is at the latest available version"
			rc=0
		fi
	elif command -v opkg >/dev/null 2>&1; then
		echo "--- opkg update ---"
		opkg update 2>&1
		rc=$?
		if [ "$rc" = 0 ]; then
			echo "--- opkg upgrade $TARGET ---"
			opkg upgrade "$TARGET" 2>&1
			rc=$?
		fi
	else
		echo "no package manager found"
		exit 3
	fi

	if [ "$rc" = 0 ]; then echo "$(date '+%F %T') ✓ 完成"; else echo "$(date '+%F %T') ✗ 失败 (rc=$rc)"; fi

	# luci-app-daede upgrade replaces ACL JSON — reload rpcd so changes apply.
	if [ "$PKG" = "luci-app-daede" ] && [ "$rc" = "0" ]; then
		echo "reloading rpcd to pick up new ACL"
		/etc/init.d/rpcd reload 2>&1
	fi
) </dev/null >/dev/null 2>&1 &

echo "started in background, see $LOG"
exit 0

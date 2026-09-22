#!/bin/sh
# Prints installed version, candidate version, and migration state (tab-separated).
# Backend names remain dae/daed; package identity is deliberately independent.
PKG="$1"
case "$PKG" in
	dae|daed) TARGET="$PKG-daede" ;;
	luci-app-daede) TARGET="$PKG" ;;
	*) echo ""; exit 64 ;;
esac

installed_version() {
	if command -v apk >/dev/null 2>&1; then
		apk info -e "$1" >/dev/null 2>&1 || return 0
		apk list -I "$1" 2>/dev/null | awk -v p="$1" '$1 ~ "^" p "-[0-9]" {sub("^" p "-", "", $1); print $1; exit}'
	elif command -v opkg >/dev/null 2>&1; then
		opkg status "$1" 2>/dev/null | awk -F': ' '
			$1=="Version" {v=$2}
			$1=="Status" && $2 ~ / installed$/ {ok=1}
			END {if (ok) print v}'
	fi
}

installed=$(installed_version "$TARGET")
latest=""
state=""
# 2026-09-23: show legacy truth, but never advertise it as a routine upgrade.
case "$PKG" in
 dae|daed) LEGACY_PACKAGES="$PKG" ;;
 luci-app-daede) LEGACY_PACKAGES="dae daed" ;;
esac
for legacy_package in $LEGACY_PACKAGES; do
 legacy=$(installed_version "$legacy_package")
 if [ -n "$legacy" ]; then
  if [ "$TARGET" != "$PKG" ]; then
   [ -n "$installed" ] || installed="$legacy"
  fi
  state=migration-required
 fi
done
if [ -z "$state" ]; then
	if command -v apk >/dev/null 2>&1; then
		latest=$(apk list "$TARGET" 2>/dev/null | awk -v p="$TARGET" '$1 ~ "^" p "-[0-9]" {sub("^" p "-", "", $1); print $1}' | sort -V | tail -1)
	elif command -v opkg >/dev/null 2>&1; then
		latest=$(opkg list "$TARGET" 2>/dev/null | awk -v p="$TARGET" '$1==p && $2=="-" {print $3}' | sort -V | tail -1)
	fi
fi
printf '%s\t%s\t%s\n' "$installed" "$latest" "$state"

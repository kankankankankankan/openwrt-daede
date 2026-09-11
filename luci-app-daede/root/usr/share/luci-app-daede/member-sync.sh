#!/bin/sh
# 2026-09-11: keep member credentials in private temporary files; apply cloud config transactionally.
umask 077
# The root override is exclusively for isolated tests; production always leaves it unset.
ROOT="${DAEDE_MEMBER_TEST_ROOT:-}"
STATE="$ROOT/tmp/daede-member"
LOCK="$ROOT/tmp/daede-member.lock"
REQUEST=""
case "$1" in
 login)
  case "$2" in ''|*[!0-9a-f]*) printf '%s\n' '{"ok":false,"error":"Invalid request identifier"}'; exit 1;; esac
  [ "${#2}" = 32 ] || { printf '%s\n' '{"ok":false,"error":"Invalid request identifier"}'; exit 1; }
  REQUEST="$ROOT/tmp/daede-member-request.$2.json";;
esac
. "$ROOT/usr/share/libubox/jshn.sh"
error() { json_init; json_add_boolean ok 0; json_add_string error "$1"; json_dump; exit 1; }
success() { json_init; json_add_boolean ok 1; json_dump; }
mkdir "$LOCK" 2>/dev/null || { [ -z "$REQUEST" ] || rm -f "$REQUEST"; error 'Another member operation is running'; }
WORK="$(mktemp -d "$ROOT/tmp/daede-member-work.XXXXXX")" || { rmdir "$LOCK"; error 'Cannot create temporary directory'; }
cleanup() { [ -z "$REQUEST" ] || rm -f "$REQUEST"; rm -rf "$WORK"; rmdir "$LOCK" 2>/dev/null; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
mkdir -p "$STATE" || error 'Cannot create session directory'
chmod 700 "$STATE"
get() { uci -q get "$1"; }
origin_valid() {
 case "$1" in https://*) ;; *) return 1;; esac
 # Deliberately accept only DNS/IPv4 origins, optionally with a numeric port.
 printf '%s' "$1" | LC_ALL=C grep -Eq '^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$'
}
interface_valid() {
 case "$1" in ''|*[!a-zA-Z0-9_.:-]*) return 1;; esac
 [ "${#1}" -le 15 ] && [ -d "$ROOT/sys/class/net/$1" ]
}
# curl config contains private paths only; body and cookie values never enter argv.
request() {
 local method="$1" route="$2" jar="$3" body="$4" limit="$5"
 cat > "$WORK/curl.conf" <<CURL
silent
show-error
proto = "=https"
connect-timeout = 15
max-time = 120
max-filesize = $limit
user-agent = "daede-member-sync/1"
request = "$method"
url = "$URL$route"
output = "$WORK/response"
write-out = "%{http_code}"
cookie = "$jar"
cookie-jar = "$jar"
CURL
 [ -z "$body" ] || printf 'header = "Content-Type: application/json"\ndata-binary = "@%s"\n' "$body" >> "$WORK/curl.conf"
 HTTP="$(ulimit -f "$((limit / 1024))"; curl --config "$WORK/curl.conf" 2> "$WORK/curl-error")" || return 1
 [ -f "$WORK/response" ] && [ "$(wc -c < "$WORK/response")" -le "$limit" ] || return 1
 case "$HTTP" in 2??) return 0;; *) return 1;; esac
}
load_session() {
 [ -s "$STATE/origin" ] && [ -s "$STATE/cookie" ] || return 1
 URL="$(cat "$STATE/origin")"
 origin_valid "$URL"
}
check_session() {
 cp "$STATE/cookie" "$WORK/cookie" || return 1
 request GET /api/state "$WORK/cookie" '' 1048576 || return 1
 json_load "$(cat "$WORK/response")" || return 1
 # /api/state returns user:null when unauthenticated.
 json_get_type session_type user
 [ "$session_type" = object ]
}
service() { "$ROOT/etc/init.d/dae" "$@" >/dev/null 2>&1; }
case "$1" in
 status)
  logged=0; note="$(get daede.member.warning)"
  if load_session; then
   if check_session; then logged=1; else note='Session could not be verified. Log in again if synchronization fails.'; fi
  fi
  URL="$(get daede.member.url)"
  json_init; json_add_boolean ok 1; json_add_boolean logged_in "$logged"
  json_add_string url "$URL"; json_add_string lan_interface "$(get daede.member.lan_interface)"
  json_add_string mode "$(get daede.member.mode)"; json_add_string last_sync "$(get daede.member.last_sync)"
  json_add_string warning "$note"; running=0; service running && running=1; json_add_boolean running "$running"; json_dump;;
 login)
  [ -f "$REQUEST" ] && [ ! -L "$REQUEST" ] && [ "$(wc -c < "$REQUEST")" -le 16384 ] || error 'Invalid login request'
  mv "$REQUEST" "$WORK/login-request" || error 'Cannot consume login request'
  json_load_file "$WORK/login-request" || error 'Invalid login JSON'
  json_get_var URL url; json_get_var USERNAME username; json_get_var PASSWORD password; json_get_var LAN lan_interface
  origin_valid "$URL" || error 'Enter an HTTPS server origin without a path'
  interface_valid "$LAN" || error 'Select an existing LAN interface'
  [ -n "$USERNAME" ] && [ -n "$PASSWORD" ] || error 'Account and password are required'
  json_init; json_add_string username "$USERNAME"; json_add_string password "$PASSWORD"; json_dump > "$WORK/body"
  unset PASSWORD; rm -f "$WORK/login-request"
  request POST /api/login "$WORK/cookie" "$WORK/body" 1048576 || error 'Login failed. Check credentials, server availability or required CAPTCHA in the member website.'
  rm -f "$WORK/body"
  [ -s "$WORK/cookie" ] || error 'Server did not establish a session'
  request GET /api/state "$WORK/cookie" '' 1048576 || error 'Cannot verify the new session'
  json_load "$(cat "$WORK/response")" || error 'Invalid server response'
  json_get_type session_type user
  [ "$session_type" = object ] || error 'Server did not authenticate the new session'
  printf '%s' "$URL" > "$WORK/origin"
  cp "$WORK/origin" "$STATE/origin" && cp "$WORK/cookie" "$STATE/cookie" || error 'Cannot save session'
  uci set daede.member=member && uci set "daede.member.url=$URL" && uci set "daede.member.lan_interface=$LAN" && uci commit daede || error 'Cannot save member settings'
  json_init; json_add_boolean ok 1; json_add_boolean logged_in 1; json_dump;;
 logout)
  if load_session; then cp "$STATE/cookie" "$WORK/cookie"; request POST /api/logout "$WORK/cookie" '' 1048576 || :; fi
  rm -f "$STATE/cookie" "$STATE/origin"; success;;
 local)
  uci set daede.member=member && uci set daede.member.mode=local && uci commit daede || error 'Cannot change configuration mode'
  success;;
 sync)
  [ "$(get daede.config.active_backend)" = dae ] || error 'Select the dae backend before synchronizing'
  if [ -x "$ROOT/etc/init.d/daed" ] && "$ROOT/etc/init.d/daed" running >/dev/null 2>&1; then error 'Stop daed before synchronizing'; fi
  LAN="$(get daede.member.lan_interface)"; interface_valid "$LAN" || error 'Saved LAN interface no longer exists'
  load_session || error 'Please log in first'
  cp "$STATE/cookie" "$WORK/cookie" || error 'Cannot read session'
  printf '%s' '{"platform":"dae","forceRefresh":true}' > "$WORK/body"
  request POST /api/convert "$WORK/cookie" "$WORK/body" 1048576 || error 'Configuration generation failed. Check your session and membership in the member website.'
  json_load "$(cat "$WORK/response")" || error 'Invalid generation response'
  json_select job || error 'Generation response has no job'
  json_get_var JOB id
  case "$JOB" in ''|*[!a-zA-Z0-9_-]*) error 'Invalid job identifier';; esac
  WARNING=''; json_get_var STALE staleSnapshot; json_get_type wt warnings
  if [ "$STALE" = 1 ] || [ "$STALE" = true ]; then
   WARNING='Upstream unavailable: this configuration uses a saved subscription snapshot. Review the member website.'
  elif [ "$wt" = array ]; then
   WARNING='Review the adaptation report in the member website before relying on all rules.'
  fi
  request GET "/api/dae/$JOB/config.dae" "$WORK/cookie" '' 8388608 || error 'Configuration download failed; current configuration was kept'
  [ -s "$WORK/response" ] || error 'Downloaded configuration is empty'
  COUNT="$(awk '{n+=gsub(/__DAE_LAN_INTERFACE__/, "&")} END {print n+0}' "$WORK/response")"
  [ "$COUNT" = 1 ] || error 'Configuration must contain exactly one LAN interface placeholder'
  sed "s/__DAE_LAN_INTERFACE__/$LAN/" "$WORK/response" > "$WORK/config.dae"
  "$ROOT/usr/bin/dae" validate -c "$WORK/config.dae" >/dev/null 2>&1 || error 'dae configuration validation failed; current configuration was kept'
  CONF="$ROOT/etc/dae/config.dae"; mkdir -p "$ROOT/etc/dae" || error 'Cannot create configuration directory'
  uci export daede > "$WORK/daede.uci" || error 'Cannot back up member settings'
  uci export dae > "$WORK/dae.uci" || error 'Cannot back up daemon settings'
  HAD=0; WAS_RUNNING=0; WAS_ENABLED=0
  service running && WAS_RUNNING=1; service enabled && WAS_ENABLED=1
  if [ -f "$CONF" ]; then cp -p "$CONF" "$WORK/previous" || error 'Cannot back up current configuration'; HAD=1; fi
  cp "$WORK/config.dae" "$CONF.member-new" && chmod 600 "$CONF.member-new" && mv "$CONF.member-new" "$CONF" || error 'Cannot install downloaded configuration'
  apply_ok=0
  if uci set daede.member=member && uci set daede.member.mode=cloud && uci commit daede && uci set dae.config.enabled=1 && uci set dae.config.config_file=/etc/dae/config.dae && uci commit dae && service enable && service restart; then
   sleep 2; service running && apply_ok=1
  fi
  if [ "$apply_ok" != 1 ]; then
   service stop || :
   if [ "$HAD" = 1 ]; then cp "$WORK/previous" "$CONF.member-new" && mv "$CONF.member-new" "$CONF"; else rm -f "$CONF"; fi
   uci import dae < "$WORK/dae.uci" && uci commit dae
   uci import daede < "$WORK/daede.uci" && uci commit daede
   [ "$WAS_ENABLED" = 1 ] && service enable || service disable
   recovered=1
   if [ "$WAS_RUNNING" = 1 ]; then service restart && sleep 2 && service running || recovered=0; fi
   [ "$recovered" = 1 ] && error 'New configuration failed to start; previous configuration restored'
   error 'New configuration failed and previous service could not restart; check the dae service log'
  fi
  [ "$HAD" != 1 ] || cp "$WORK/previous" "$ROOT/etc/dae/config.dae.member-backup"
  NOW="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  uci set daede.member=member && uci set daede.member.mode=cloud && uci set "daede.member.last_sync=$NOW" && uci set "daede.member.warning=$WARNING" && uci commit daede || error 'Configuration is running but member status could not be saved'
  json_init; json_add_boolean ok 1; json_add_string last_sync "$NOW"; json_add_string warning "$WARNING"; json_dump;;
 *) error 'Unknown member operation';;
esac

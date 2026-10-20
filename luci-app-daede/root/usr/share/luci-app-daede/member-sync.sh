#!/bin/sh
# 2026-09-11: keep member credentials in private temporary files; apply cloud config transactionally.
umask 077
# The root override is exclusively for isolated tests; production always leaves it unset.
ROOT="${DAEDE_MEMBER_TEST_ROOT:-}"
STATE="$ROOT/tmp/daede-member"
LOCK="$ROOT/tmp/daede-member-operation.lock"
REQUEST=""
case "$1" in
 login)
  case "$2" in ''|*[!0-9a-f]*) printf '%s\n' '{"ok":false,"error":"Invalid request identifier"}'; exit 1;; esac
  [ "${#2}" = 32 ] || { printf '%s\n' '{"ok":false,"error":"Invalid request identifier"}'; exit 1; }
  REQUEST="$ROOT/tmp/daede-member-request.$2.json";;
esac
. "$ROOT/usr/share/libubox/jshn.sh"
error() {
 if [ "${SYNC_TRACK:-0}" = 1 ]; then
  printf '%s' "$1" > "$STATE/last-error.tmp"; mv "$STATE/last-error.tmp" "$STATE/last-error"
 fi
 json_init; json_add_boolean ok 0; json_add_string error "$1"; json_dump; exit 1; }
success() { json_init; json_add_boolean ok 1; json_dump; }
# 2026-10-16: Long operations outlive LuCI's 30-second RPC budget.
valid_id() { case "$1" in ''|*[!0-9a-f]*) return 1;; esac; [ "${#1}" = 32 ]; }
mkdir -p "$STATE" || error 'Cannot create session directory'
chmod 700 "$STATE"
case "$1" in
 start)
  valid_id "$2" || error 'Invalid job identifier'
  case "$3" in login) valid_id "$4" || error 'Invalid request identifier';; sync|logout) ;; *) error 'Invalid background action';; esac
  command -v setsid >/dev/null 2>&1 || error '缺少 setsid，请安装固件的 BusyBox 标准组件'
  JOBDIR="$STATE/job.$2"
  mkdir "$JOBDIR" 2>/dev/null || error '任务编号已存在，请刷新后重试'
  setsid /bin/sh "$0" _run "$2" "$3" "$4" </dev/null >"$JOBDIR/worker.log" 2>&1 &
  printf '%s' "$!" > "$JOBDIR/pid"
  json_init; json_add_boolean ok 1; json_add_string job "$2"; json_dump; exit 0;;
 _run)
  valid_id "$2" || exit 1
  JOBDIR="$STATE/job.$2"
  [ -d "$JOBDIR" ] || exit 1
  case "$3" in login|sync|logout) ;; *) exit 1;; esac
  DAEDE_MEMBER_JOBDIR="$JOBDIR" /bin/sh "$0" "$3" "$4" > "$JOBDIR/result.tmp"
  mv "$JOBDIR/result.tmp" "$JOBDIR/result"
  exit 0;;
 result)
  valid_id "$2" || error 'Invalid job identifier'
  JOBDIR="$STATE/job.$2"
  [ -d "$JOBDIR" ] || error '任务记录已失效，请刷新状态后重试'
  if [ -s "$JOBDIR/result" ]; then cat "$JOBDIR/result"; rm -rf "$JOBDIR"; exit 0; fi
  pid="$(cat "$JOBDIR/pid" 2>/dev/null)"
  if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then rm -rf "$JOBDIR"; error '操作已中断，请刷新状态后重试'; fi
  json_init; json_add_boolean ok 1; json_add_boolean pending 1; json_add_string phase "$(cat "$JOBDIR/phase" 2>/dev/null)"; json_dump; exit 0;;
esac
# Kernel-held locks are released even if a worker is killed. Status never locks writers.
if [ "$1" != status ]; then
 exec 9>"$LOCK"
 flock -n 9 || { [ -z "$REQUEST" ] || rm -f "$REQUEST"; error '另一项会员操作正在进行，请稍后重试'; }
fi
WORK="$(mktemp -d "$ROOT/tmp/daede-member-work.XXXXXX")" || error 'Cannot create temporary directory'
cleanup() { [ -z "$REQUEST" ] || rm -f "$REQUEST"; rm -rf "$WORK"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
REQUEST_TIMEOUT=120
[ "$1" != status ] || REQUEST_TIMEOUT=8
get() { uci -q get "$1"; }
# 2026-10-20: Persist the due time, expose actual phases, keep failures visible.
phase() { [ -z "${DAEDE_MEMBER_JOBDIR:-}" ] || printf '%s' "$1" > "$DAEDE_MEMBER_JOBDIR/phase"; }
interval_seconds() {
 HOURS="$(get daede.member.sync_interval)"
 case "$HOURS" in ''|*[!0-9]*) HOURS=6;; esac
 [ "$HOURS" -ge 1 ] && [ "$HOURS" -le 24 ] || HOURS=6
 HOURS="$(expr "$HOURS" + 0)"
 INTERVAL=$((HOURS * 3600))
}
wait_running() {
 # Require a stable process over five checks; this does not claim node connectivity.
 stable=0; tries=0
 while [ "$tries" -lt 15 ]; do
  if service running; then stable=$((stable + 1)); else stable=0; fi
  [ "$stable" -lt 5 ] || return 0
  sleep 1; tries=$((tries + 1))
 done
 return 1
}
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
max-time = $REQUEST_TIMEOUT
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
 CURL_CODE=0
 HTTP="$(ulimit -f "$((limit / 1024))"; curl --config "$WORK/curl.conf" 2> "$WORK/curl-error")" || { CURL_CODE=$?; return 1; }
 [ -f "$WORK/response" ] && [ "$(wc -c < "$WORK/response")" -le "$limit" ] || return 1
 case "$HTTP" in 2??) return 0;; *) return 1;; esac
}
# Report protocol/transport facts; do not echo HTML, cookies, or subscription secrets.
request_error() {
 local label="$1"
 case "$CURL_CODE" in
  6) error "${label}：域名解析失败，请检查路由器 DNS";;
  7) error "${label}：无法连接会员服务器";;
  28) error "${label}：请求超时，原配置保持不变，请稍后重试";;
  35|60) error "${label}：HTTPS 连接或证书校验失败";;
 esac
 case "$HTTP" in
  401) error "${label}：登录已过期，请重新登录";;
  403) error "${label}：服务器拒绝访问（HTTP 403），请检查会员权限或网站防护";;
  429) error "${label}：请求过于频繁，请稍后重试";;
  5??) error "${label}：服务器或网关异常（HTTP ${HTTP}），请稍后重试";;
 esac
 error "${label}：请求失败（HTTP ${HTTP:-000}，连接错误 ${CURL_CODE:-0}）"
}
load_session() {
 [ -s "$STATE/origin" ] && [ -s "$STATE/cookie" ] || return 1
 URL="$(cat "$STATE/origin")"
 origin_valid "$URL"
}
check_session() {
 QUOTA_STATUS=unavailable
 cp "$STATE/cookie" "$WORK/cookie" || return 1
 request GET /api/state "$WORK/cookie" '' 1048576 || { [ "$HTTP" != 401 ] || QUOTA_STATUS=unauthenticated; return 1; }
 json_load "$(cat "$WORK/response")" || return 1
 json_get_type response_type ok; json_get_var response_ok ok
 [ "$response_type" = boolean ] && [ "$response_ok" = 1 ] || return 1
 # /api/state returns user:null when unauthenticated.
 json_get_type session_type user
 if [ "$session_type" = null ]; then QUOTA_STATUS=unauthenticated; return 1; fi
 [ "$session_type" = object ] || return 1
 QUOTA_STATUS=available
}
# Read only approved display fields from the already verified /api/state response.
quota_text() {
 local type value
 json_get_type type "$1"; [ "$type" = string ] || return 0
 json_get_var value "$1"; printf '%s' "$value"
}
quota_bytes() {
 local type value
 json_get_type type "$1"
 case "$type" in int|double) ;; *) return 0;; esac
 json_get_var value "$1"
 case "$value" in ''|*[!0-9]*) return 0;; esac
 printf '%s' "$value"
}
read_quota() {
 json_select user || return
 q_member="$(quota_text username)"
 q_plan="$(quota_text planName)"; q_expiry="$(quota_text expiresAt)"
 q_expiry_text="$(quota_text expiresText)"; q_updated="$(quota_text updatedAt)"
 json_select usage || return 0
 q_upload="$(quota_bytes upload)"; q_download="$(quota_bytes download)"
 q_used="$(quota_bytes used)"; q_total="$(quota_bytes total)"; q_remaining="$(quota_bytes remaining)"
}
add_quota() {
 json_add_object quota
 json_add_string memberName "$q_member"
 json_add_string planName "$q_plan"; json_add_string expiresAt "$q_expiry"
 json_add_string expiresText "$q_expiry_text"; json_add_string updatedAt "$q_updated"
 # jshn integers are 32-bit on some routers; doubles preserve normal byte counters.
 [ -z "$q_upload" ] || json_add_double upload "$q_upload"
 [ -z "$q_download" ] || json_add_double download "$q_download"
 [ -z "$q_used" ] || json_add_double used "$q_used"
 [ -z "$q_total" ] || json_add_double total "$q_total"
 [ -z "$q_remaining" ] || json_add_double remaining "$q_remaining"
 json_close_object
}
service() { "$ROOT/etc/init.d/dae" "$@" >>"$WORK/service.log" 2>&1; }
case "$1" in
 status)
  logged=0; QUOTA_STATUS=unauthenticated; note="$(get daede.member.warning)"
  if load_session; then
   if check_session; then logged=1; read_quota; else
    if [ "$QUOTA_STATUS" = unauthenticated ]; then note='登录已过期，请重新登录';
    else logged=1; note='登录凭据已保留，暂时无法核验会员状态，请稍后重试'; fi
   fi
  fi
  URL="$(get daede.member.url)"
  json_init; json_add_boolean ok 1; json_add_boolean logged_in "$logged"
  json_add_string quota_status "$QUOTA_STATUS"
  [ "$QUOTA_STATUS" != available ] || add_quota
  json_add_string url "$URL"; json_add_string lan_interface "$(get daede.member.lan_interface)"
  json_add_string mode "$(get daede.member.mode)"; json_add_string last_sync "$(get daede.member.last_sync)"; json_add_boolean auto_sync "$(get daede.member.auto_sync)"; json_add_string sync_interval "$(get daede.member.sync_interval)"
  json_add_string next_sync "$(get daede.member.next_sync)"; json_add_string last_error "$(cat "$STATE/last-error" 2>/dev/null)"; json_add_string warning "$note"; running=0; service running && running=1; json_add_boolean running "$running"; json_dump;;
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
  request POST /api/login "$WORK/cookie" "$WORK/body" 1048576 || request_error '会员登录失败'
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
 schedule)
  case "$2" in ''|*[!0-9]*) error 'Invalid sync interval';; esac
  [ "$2" -ge 1 ] 2>/dev/null && [ "$2" -le 24 ] 2>/dev/null || error 'Sync interval must be between 1 and 24 hours'
  HOURS="$(expr "$2" + 0)"
  NEXT=$(($(date +%s) + HOURS * 3600))
  uci set daede.member=member && uci set "daede.member.next_sync=$NEXT" && uci set daede.member.auto_sync=1 && uci set daede.member.sync_interval="$2" && uci commit daede || error 'Cannot save sync schedule'
  "$ROOT/usr/share/luci-app-daede/member-sync-cron.sh" enable || error 'Cannot apply sync schedule'
  json_init; json_add_boolean ok 1; json_add_string sync_interval "$2"; json_add_string next_sync "$NEXT"; json_dump;;
 sync|scheduled)
  # Timed tasks never start a stopped service or replace locally edited rules.
  if [ "$1" = scheduled ]; then
   [ "$(get daede.member.auto_sync)" = 1 ] && [ "$(get daede.member.mode)" = cloud ] && service running || { success; exit 0; }
   due="$(get daede.member.next_sync)"; case "$due" in ''|*[!0-9]*) due=0;; esac
   [ "$(date +%s)" -ge "$due" ] || { success; exit 0; }
  fi
  SYNC_TRACK=1
  interval_seconds
  NEXT=$(($(date +%s) + INTERVAL))
  uci set "daede.member.next_sync=$NEXT" && uci commit daede || error 'Cannot save next sync time'
  phase '正在生成配置'
  [ "$(get daede.config.active_backend)" = dae ] || error 'Select the dae backend before synchronizing'
  if [ -x "$ROOT/etc/init.d/daed" ] && "$ROOT/etc/init.d/daed" running >/dev/null 2>&1; then error 'Stop daed before synchronizing'; fi
  LAN="$(get daede.member.lan_interface)"; interface_valid "$LAN" || error 'Saved LAN interface no longer exists'
  load_session || error 'Please log in first'
  cp "$STATE/cookie" "$WORK/cookie" || error 'Cannot read session'
  printf '%s' '{"platform":"dae","forceRefresh":true}' > "$WORK/body"
  request POST /api/convert "$WORK/cookie" "$WORK/body" 1048576 || request_error '云端配置生成失败'
  json_load "$(cat "$WORK/response")" || error 'Invalid generation response'
  json_select job || error 'Generation response has no job'
  json_get_var JOB id
  case "$JOB" in ''|*[!a-zA-Z0-9_-]*) error 'Invalid job identifier';; esac
  WARNING=''; json_get_var STALE staleSnapshot; json_get_type wt warnings
  if [ "$STALE" = 1 ] || [ "$STALE" = true ]; then
   WARNING='云端暂时无法获取最新订阅，本次使用已保存的订阅快照。请稍后再次同步。'
  elif [ "$wt" = array ]; then
   json_get_keys warning_keys warnings
   if [ -n "$warning_keys" ]; then
    WARNING='云端返回兼容提示，但未提供可展示的详细原因；同步完成后请测试节点连通性。'
    json_select warnings
    for warning_key in $warning_keys; do
     json_get_type warning_type "$warning_key"
     if [ "$warning_type" = string ]; then
      json_get_var warning_text "$warning_key"
      # Only expose the server's known node compatibility summary.
      case "$warning_text" in '已跳过 '*个不支持协议节点*) WARNING="订阅转换提示：$(printf '%s' "$warning_text" | head -c 300)";; esac
     fi
     break
    done
   fi
  fi
  phase '正在下载配置'
  request GET "/api/dae/$JOB/config.dae" "$WORK/cookie" '' 8388608 || request_error '云端配置下载失败'
  [ -s "$WORK/response" ] || error 'Downloaded configuration is empty'
  COUNT="$(awk '{n+=gsub(/__DAE_LAN_INTERFACE__/, "&")} END {print n+0}' "$WORK/response")"
  [ "$COUNT" = 1 ] || error 'Configuration must contain exactly one LAN interface placeholder'
  sed "s/__DAE_LAN_INTERFACE__/$LAN/" "$WORK/response" > "$WORK/config.dae"
  # dae 1.0.0 不支持新版 DNS 缓存字段，下载后清理以保证配置可启动。
  sed -i -e '/^[[:space:]]*optimistic_cache[[:space:]]*:/d' -e '/^[[:space:]]*optimistic_cache_ttl[[:space:]]*:/d' -e '/^[[:space:]]*max_cache_size[[:space:]]*:/d' "$WORK/config.dae"
  phase '正在校验配置'
  "$ROOT/usr/bin/dae" validate -c "$WORK/config.dae" >/dev/null 2>&1 || error 'dae configuration validation failed; current configuration was kept'
  CONF="$ROOT/etc/dae/config.dae"; mkdir -p "$ROOT/etc/dae" || error 'Cannot create configuration directory'
  uci export daede > "$WORK/daede.uci" || error 'Cannot back up member settings'
  uci export dae > "$WORK/dae.uci" || error 'Cannot back up daemon settings'
  HAD=0; WAS_RUNNING=0; WAS_ENABLED=0
  service running && WAS_RUNNING=1; service enabled && WAS_ENABLED=1
  if [ -f "$CONF" ]; then cp -p "$CONF" "$WORK/previous" || error 'Cannot back up current configuration'; HAD=1; fi
  if [ "$1" = scheduled ] && ! service running; then success; exit 0; fi
  cp "$WORK/config.dae" "$CONF.member-new" && chmod 600 "$CONF.member-new" && mv "$CONF.member-new" "$CONF" || error 'Cannot install downloaded configuration'
  phase '正在应用配置'
  APPLY=restart
  if [ "$WAS_RUNNING" = 1 ] && [ "$HAD" = 1 ] && [ "$(get dae.config.config_file)" = /etc/dae/config.dae ] && cmp -s "$WORK/previous" "$WORK/config.dae"; then APPLY=hot_reload; fi
  apply_ok=0
  if uci set daede.member=member && uci set daede.member.mode=cloud && uci commit daede && uci set dae.config.enabled=1 && uci set dae.config.config_file=/etc/dae/config.dae && uci commit dae && service enable && service "$APPLY"; then
   wait_running && apply_ok=1
  fi
  if [ "$apply_ok" != 1 ]; then
   # 2026-09-23: stop_service deletes dae.log; preserve failure evidence before rollback.
   { cat "$WORK/service.log"; [ ! -f "$ROOT/var/log/dae/dae.log" ] || tail -n 100 "$ROOT/var/log/dae/dae.log"; } > "$STATE/last-start.log"
   chmod 600 "$STATE/last-start.log"
   service stop || :
   if [ "$HAD" = 1 ]; then cp "$WORK/previous" "$CONF.member-new" && mv "$CONF.member-new" "$CONF"; else rm -f "$CONF"; fi
   uci import dae < "$WORK/dae.uci" && uci commit dae
   uci import daede < "$WORK/daede.uci" && uci commit daede
   [ "$WAS_ENABLED" = 1 ] && service enable || service disable
   recovered=1
   if [ "$WAS_RUNNING" = 1 ]; then service restart && wait_running || recovered=0; fi
   [ "$recovered" = 1 ] && error 'New configuration failed to start; previous configuration restored. See /tmp/daede-member/last-start.log'
   error 'New configuration failed and previous service could not restart; check the dae service log'
  fi
  # 2026-09-23: cloud sync must not restore the retired acceleration URLs.
  [ -n "$(get daede.config.geoip_url)" ] || uci set daede.config.geoip_url='https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geoip.dat'
  [ -n "$(get daede.config.geosite_url)" ] || uci set daede.config.geosite_url='https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geosite.dat'
  [ -n "$(get daede.config.geo_auto)" ] || uci set daede.config.geo_auto='1'
  [ -n "$(get daede.config.geo_auto_freq)" ] || uci set daede.config.geo_auto_freq='daily'
  uci commit daede || error 'Configuration is running but data update settings could not be saved'
  "$ROOT/usr/share/luci-app-daede/geo-cron.sh" "$( [ "$(get daede.config.geo_auto)" = 1 ] && echo enable || echo disable )" || error 'Configuration is running but data update schedule could not be enabled'
  uci -q get daede.member.auto_sync 2>/dev/null | grep -qx 1 && "$ROOT/usr/share/luci-app-daede/member-sync-cron.sh" enable || true
  [ "$HAD" != 1 ] || cp "$WORK/previous" "$ROOT/etc/dae/config.dae.member-backup"
  NOW="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  uci set daede.member=member && uci set daede.member.mode=cloud && uci set "daede.member.last_sync=$NOW" && uci set "daede.member.warning=$WARNING" && uci commit daede || error 'Configuration is running but member status could not be saved'
  rm -f "$STATE/last-error"
  json_init; json_add_boolean ok 1; json_add_string next_sync "$NEXT"; json_add_string last_sync "$NOW"; json_add_string warning "$WARNING"; json_add_boolean running 1; json_dump;;
 *) error 'Unknown member operation';;
esac

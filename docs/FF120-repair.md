# FF-120 固件选源与更新页面修复（2026-09-23）

## 已落地

192.168.124.253 热修复了 `pkg-info.sh`、`update-geo.sh`、`updates.js`，并清除旧内置 ghfast GeoIP/GeoSite 地址，回到直连默认值。更新前文件 SHA256 与仓库基线一致，更新后与修复源码一致。dae PID 在操作前后均为 22454，没有重启代理服务；192.168.124.2 未修改。

实机逐包返回：dae `1.0.0-r1`、daed `1.24.0-r1`、LuCI `1.15-r9`。这是文件热修复，不伪造包版本；源码下一版为 `1.15-r10`。浏览器强制刷新更新页面后应不再显示加速预设。尚未做浏览器视觉验收。

## 固件内核修复的交付顺序

1. 合并 openwrt-daede 的 `fix/ff120-version-geodata`。
2. 在 ImmortalWrt-Packages 运行 `sync.yml`，确认 `openwrt-daede/luci-app-daede/Makefile` 为 `1.15-r10`；README 的包来源已核对为本仓库。
3. 合并 ImmortalWrt-Actions 的 `fix/ff120-daede-feed`，再运行固件构建。
4. 构建先卸载三个旧同名 feed 链接，再指定 `immortalwrt` 安装；下载前验证链接和 `.config`，编译后验证全部固件 manifest。三包必须与定制 feed 中版本一致，否则停止发布。
5. 验证生成固件后，另安排刷机/核心包升级及代理回归。此次未触发固件构建、未刷机、未替换运行中的内核。运行时系统 opkg 源也未新增日期版源。

## 验证与审查

- `python3 tests/package-info-test.py`：opkg/apk、semver/日期版/未安装，精确迁移自定义 URL，旧备份下载回落。
- `node --test tests/*.test.cjs`：38 项通过，含空 installed 字段与直连预设。
- 三个变动 shell 文件 `sh -n`、页面 `node --check`、两仓 `git diff --check` 通过。
- 固件脚本 `python3 scripts/test-daede-feed.py` 覆盖正确产物、错误版本、缺 manifest、未内置包、错误 feed 链接。
- 独立代码审查发现并修复 `feeds install -f` 不覆盖其他 feed 的问题；最终复核无新增阻断项。未完成真实固件编译或完整代理功能回归。

## 回退与临时文件

路由器备份：`/root/ff120-before-20260923/original.tar.gz`（含三文件与原 `/etc/config/daede`），同目录 `dae.pid` 保存进程证据。目录权限 0700，备份留在设备，不公开上传配置。

如需恢复本次热修复，在该设备执行 `tar -xzf /root/ff120-before-20260923/original.tar.gz -C /`，然后强制刷新浏览器。此操作会同时恢复原 GeoData 地址，请留意后续手动修改。源码通过 Git revert 对应修复提交回退。

单元测试使用的临时目录已自动清理。设备未创建临时路由、未重启服务；备份与 PID 证据保留用于回退。

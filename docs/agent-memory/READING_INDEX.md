# 阅读索引

| 模块/路径/符号 | 状态 | 阅读范围 | 结论或问题 | 证据/版本 | 下次入口 |
| --- | --- | --- | --- | --- | --- |
| `luci-app-daede/Makefile`、`po/` | 已验证 | 定义、Prepare/Install、翻译恢复 | 依赖/会员脚本保留，只有一份安装中文 LMO，release 9 | `946327d`，两套实际 SDK LuCI 包检查 | 同版本 release 冲突仍需处理 |
| `member-sync.sh`、`geo-cron.sh`、`tests/member-sync-test.py` | 已验证 | 同步事务、GeoData 计划、测试夹具 | 原 3 项失败由缺失 helper 导致；真实 helper 在隔离根运行 | `946327d`，15/15 | 设备运行验证 |
| `dae.js`、会员/LAN 接入 | 已验证 | 上游新增日志级别的合并区及原接入 | 原会员/LAN 入口保留 | Node 35/35，独立审查 | LuCI 浏览器/设备验证 |
| `log.js` | 已验证 | buildLine、appendLines、applyFilter | 以原始行筛选，避免 span 拼接丢失词边界 | `946327d`，2 项新增回归 | 真实浏览器展示 |
| `widgets.js` | 已读 | 本次上游 probeState 差异 | 接收上游探测结果保持逻辑 | `91fa0c7` | 未做真实浏览器验证 |
| `.github/workflows/release.yml` | 已验证 | 合并差异、矩阵、SDK 结果门槛 | x86_64 × 24.10/25.12；拒绝失败 SDK 的残留包 | `946327d`，工作流本地夹具 | 本地 SDK 包通过；完整发布工作流待验证 |
| `.github/workflows/auto-bump.yml` | 已验证 | 本次差异、发布 wait_run | 结论为空时仍正确核验 SHA；现有自动化并非整包同步器 | `946327d`，工作流本地夹具 | 后续独立自动通道阶段 |
| `dae/`、`daed/`、`ci/pins.env`、`scripts/audit-upstream.sh` | 已验证 | 冻结资产哈希、19 补丁应用、SSR/QUIC Go 检查 | 资产匹配，补丁可应用且未重复吸收 | `946327d`，本地源码审计通过 | SDK 包通过；设备 eBPF/流量仍待验收 |
| `scripts/upload-source-asset*.sh` | 已验证 | 只执行 mock selftest | 新建、复用、摘要冲突及错误路径自测通过 | `946327d` | 未执行真实上传 |

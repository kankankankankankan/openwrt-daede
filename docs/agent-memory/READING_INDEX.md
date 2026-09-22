# 阅读索引

| 模块 | 状态 | 范围与结论 | 后续入口 |
| --- | --- | --- | --- |
| pkg-info.sh / updates.js | 已验证 | 真实版本保留、TAB 解析、移除预设；JS 38 测试通过 | tests/updates.test.cjs |
| uci-defaults / update-geo.sh | 已验证 | 精准迁移、旧备份直连回落；自定义不变 | tests/package-info-test.py |
| ImmortalWrt-Actions workflow / check-daede-feed.py | 已验证（夹具） | 三包指定 feed 与产物版本门禁；静态复核通过 | 实际构建与 manifest |
| .253 | 已验证（SSH） | 热修复 SHA256、UCI、版本和 PID | 浏览器强刷与视觉验收 |
| .2 / 完整代理转发 | 未验证（本轮） | 未修改 | 刷机后单独回归 |

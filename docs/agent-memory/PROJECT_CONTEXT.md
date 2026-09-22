# openwrt-daede 项目续接

- 项目 / Issue：DAEDE路由插件二次编写，FF-110。
- 代码入口：本项目 Git 工作树；下游 `kankankankankankan/openwrt-daede`，上游 `kenzok8/openwrt-daede`。
- 本次授权：2026-09-22 用户同意首次上游基线合并与本地冲突/回归检查，明确禁止向 GitHub 提交。本地 merge commit 用于保留上游祖先关系。
- 范围：保留会员/LAN 定制，接收 8 个上游提交，修复集成时发现的回归。自动同步 PR、排程启用、仓库权限配置、发布和设备升级不在本阶段。
- 决策：保留 `zh_Hans` 上游源目录；Makefile 仍仅编译安装 `zh-cn` 一份 LMO。相同 `PKG_VERSION` 的本次 release 取 `max(8,3)+1=9`。
- 版本：下游 `ad3ed69`，上游 `91fa0c7`，本地合并 `9801d0d`，兼容修复 `946327d`；2026-09-22 核验。
- 总控维护：通用交付｜项目总控。状态见 [CURRENT_STATE.md](CURRENT_STATE.md)，阅读入口见 [READING_INDEX.md](READING_INDEX.md)，验证与恢复见 [../upstream-baseline-validation.md](../upstream-baseline-validation.md)。

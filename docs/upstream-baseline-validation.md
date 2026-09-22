# FF-110 首次上游基线：本地验证记录

日期：2026-09-22。用户要求本地实施、复测冲突，暂不向 GitHub 提交。本地候选已完成合并、回归和两套 SDK 包构建，等待用户验收。本报告记录实际证据及环境处理，不代表设备发布验收。

## 版本与变更

- 下游 main：`ad3ed693e66e3cd070562f4d5e55a38bfafb275c`。
- 上游 main：`91fa0c7da6d63b1654ebf1e615dbc2a6498216a6`，共同旧祖先 `051b254`，8 个待合入提交。
- 本地分支：`agent/agent/ff-110`。本轮起点 `d5a88d8`（产品树与下游 main 相同，另有先前方案和截图）。
- `c7f9fc7`：记录下游 main 祖先关系，产品树未变化。
- `9801d0d`：上游 merge commit，保留完整合并历史。
- `946327de407d2ea9721a76476cc71c1668aec70c`：回归修复及测试，以下产品证据针对该版本。

两处文本冲突已处理：LuCI release 从下游 8 / 上游 3 统一至 9；恢复上游 `po/zh_Hans/daede.po`，与 `zh-cn` 内容一致。默认 dae 后端、curl/ca-bundle、会员脚本安装项及会员/LAN 接入点均保留。

随上游成套接收源码 pins、dae/daed 版本、兼容补丁、日志和构建更新。独立审查发现并修复：

1. 发布轮询将空 conclusion 放在 SHA 前，Bash 分词后丢失 SHA；改为可选字段最后读取。
2. SDK `continue-on-error` 后仅检查包文件可能放行失败构建；加入真实 step outcome 检查。
3. 日志切换筛选使用渲染后的 span 拼接文本，破坏词边界；改用原始日志行。

## 已执行验证

| 检查 | 结果与边界 |
| --- | --- |
| `node --test tests/*.test.cjs` | 35/35，通过；模拟 DOM，不等于真实 LuCI 浏览器验收 |
| `python3 tests/member-sync-test.py` | 15/15，通过；原 13 项中的 3 项失败已复现并定位到缺少 geo-cron 夹具。补齐真实 helper 的隔离副本，新增重复同步计划去重/计划失败可见性测试 |
| `python3 tests/generator-lan-test.py` | 4/4，通过 |
| `python3 tests/workflow-gates-test.py` | 4/4，通过；需要本机 `bash`、`jq`；GitHub 调用全部 mock |
| 新增回归反证 | 将新测试放到修复前 `9801d0d` 副本，日志 2 项失败，工作流 3 项失败；修复后全部通过 |
| `bash scripts/audit-upstream.sh` | `PASS patches=19 absorbed=0`；下载冻结源码并核对 SHA256，x86/ARM 补丁全部正向可应用，outbound SSR Go 测试与 quic-go 构建通过（宿主 macOS arm64 Go 1.27.1） |
| `sh scripts/upload-source-asset-selftest.sh` | PASS，8 种资产场景；仅使用 fake gh，没有实际上传 |
| Makefile 暂存打包检查 | 隔离运行实际 Build/Prepare 与 install，41 个文件，会员脚本可执行；仅生成 `daede.zh-cn.lmo`，新增“日志级别”和既有“继续”均可查到中文。SDK includes 使用占位、po2lmo 使用仓库 Python 实现，因此不算真实 SDK 编译 |
| 语法/格式 | 25 个 shell、15 个 JavaScript、2 个 JSON、5 个 workflow YAML 解析通过。`git diff --check` 的自有修改通过；上游 `.patch` 文件的补丁上下文空格会被全量检查报告，未破坏补丁格式去除这些空格；其他合并文件通过 |
| 工作流静态检查 | actionlint v1.7.7 通过（关闭其可选 shellcheck/pyflakes），另对 32 段内嵌 Bash 独立做语法检查，全部通过 |
| 独立代码审查 | 首轮 3 项发现均在 `946327d` 修复；复审无剩余发现，未覆盖设备运行 |

## Git 冲突演练

在临时 bare 仓库创建合成上游提交，未修改实际分支和远端：

- 上游 `91fa0c7` 和下游 `ad3ed69` 均是候选祖先。
- `git merge-tree --write-tree HEAD upstream/main` 等于 HEAD 的 tree：重复同步同一上游不再冲突、不增加版本。
- 当前下游 main 合入候选无冲突，结果等于候选树。
- 上游在 `zh_Hans` 再追加翻译修改可正常合并，原修改/删除冲突已消除。
- **上游将 `PKG_RELEASE` 从 3 改 4 的演练仍报版本行冲突。** 本阶段没有安装自动冲突消解策略，因此不承诺后续任意上游更新零人工。

## SDK 与运行验证

本地 Docker Desktop / Linux amd64 仿真（宿主 Apple arm64）。构建使用产品/测试提交 `946327d` 的独立 feed 副本，四个目标为 `dae`、`daed`、`luci-app-daede`、`vmlinux-btf`。SDK action 固定为 `44f98c51d04aebd1aa79fe4f603559c1ec2085da`，应用仓库 pahole 1.28 补丁。SDK 基础镜像为 `immortalwrt/sdk:x86_64-openwrt-24.10`（digest `7507e792197c386bb0c307dc2b8ada7f1407e983cb84eead405382c419df1214`）和 `x86_64-openwrt-25.12`（digest `832638cc9b894f155c62abbca029e85b1ae1027575b4e308864897a935c17e87`）。各 feed 的完整输入记录在验证日志附件的 `sdk-inputs.json`，packages feed 为：

- 24.10：`7730b958f2a23b7c2ef6ccbde00447ad03f68cdb`。
- 25.12：`84bd86384928955b568988ca0e09e2c78c75173d`。
- golang feed：`581510430190ecf3f25c3c66385de758b6538dfc`（1.26 分支，Go 1.26.8）。

本地验证与完整发布工作流有以下明确差异：

1. SDK 默认选中超过 1,100 个无关内核模块。仅在隔离 SDK 中关闭 ALL 开关及 `Config-build.in` 的隐式模块默认值，再让依赖 `select` 选择所需项。两套配置保留且只选择 `kmod-sched-bpf`、`kmod-sched-core`、`kmod-veth` 三个模块；仓库包依赖未删减。四个目标及依赖采用 `IGNORE_ERRORS=` 严格编译，再生成索引、检查四包齐全。
2. 两套 SDK 的 Lua 5.1.5 均在 `-j4` 编译时出现 GNU Make jobserver 的 `Bad file descriptor`，并非本项目源码编译诊断。重试先 `make -j1 package/lua/compile`。两套 SDK 的 vmlinux-btf 随后也在嵌套 make 发生同类错误；SDK 捕获外层 jobserver 参数并清除 MAKEFLAGS，诊断指向继承的描述符问题，精确关闭路径尚未证明。BTF 续跑采用清除继承 MAKEFLAGS/MFLAGS/MAKE_JOBSERVER、外层 `make -j1`、内层 `PKG_JOBS=-j4`，让内核创建新队列。初次失败日志保留，不抹成一次通过。
3. 25.12 的 SDK 外部依赖生成器沿 curl → openldap → libsasl2 → libcrypt-compat 传播约束，生成两条 `depends on !(LIBCURL_LDAP && USE_GLIBC) || USE_GLIBC`。该式对 Boolean USE_GLIBC 恒真，却让 Kconfig 检出 libcurl/LDAP 循环。经独立复核，在 SDK 生成文件 `tmp/.config-package.in` 中只移除这两条冗余表达式：前后完整 `.config` 字节相同，musl、LDAP 关闭、目标及依赖选择不变，defconfig 循环诊断消失。保留原文件、精确差异及前后配置，未修改项目或外部 feed 源文件。
4. 25.12 下载 compress 1.18.4 缓慢，复用 24.10 已下载并由 Go 校验的同一 zip/ziphash；24.10 重跑时 SQLite 1.23.1 下载停滞，同样复用 25.12 已校验的缓存。两次转移 SHA256 均一致，保留停滞日志后续跑，不更换依赖版本。准备镜像和编译缓存用于本地续跑。早期全模块构建及范围调整尝试由本任务主动停止，不能当作源码失败，也不当作通过证据。
5. 24.10 的四包编译完成后，本地索引命令最初将 `CONFIG_SIGNED_PACKAGES=n` 作为关闭签名，Make 却把非空的 n 视为启用，因此报缺少 `key-build`。已明确这是本地调用参数错误；改为 `CONFIG_SIGNED_PACKAGES=` 生成未签名本地索引，无须引入签名密钥或修改仓库。

两套 SDK 实际核心包的启动冒烟已通过：从 IPK/APK 解包后执行 `dae --version`、`daed --version`，均输出 `2026.09.20`（dae 显示 Go 1.26.8 linux/amd64），临时解包目录已清理。这仅验证基本启动，不涉及服务、流量和 eBPF 加载。

另以真实生成器的三种有效 LAN 输入（单接口、逗号列表、空格列表）生成配置，配上 SDK 实际 GeoIP/GeoSite 包数据及生产要求的 0600 权限，交给 25.12 包中的 `dae validate -c` 校验，3/3 通过；没有启动代理服务。

25.12 实际 LuCI APK 已通过包校验及内容检查：`1.15-r9`、`noarch`，依赖包含 dae/luci-base/curl/ca-bundle；44 个文件（41 个应用文件及 3 个 APK 包管理记录），会员 helper 可执行且与源码一致，所有 JS 字节一致，仅一份 `daede.zh-cn.lmo`，新增“日志级别”和“继续”的中文查找通过。

24.10 实际 LuCI IPK 内容检查亦通过：`1.15-r9`、`all`，同样保留默认 dae 和会员依赖，41 个应用文件，会员 helper 权限、所有 JS 字节及唯一中文 LMO 查找均通过。

最终 SDK 结果：

| SDK / 格式 | 结果 |
| --- | --- |
| 24.10 / IPK | 四包及未签名索引全部通过，最终退出码 0；索引中四包条目及 SHA256 与实际文件一致，BTF `6.6.151-r1` 的原始格式/区段范围检查通过，最终配置仍仅选择三个所需 kmod |
| 25.12 / APK | 四包及索引全部通过，最终退出码 0；四个 APK 校验通过，BTF `6.12.103-r1` 的原始格式/区段范围检查通过，最终配置仍仅选择三个所需 kmod，循环依赖诊断没有重现 |
本地通过结果仅证明上述固定输入、SDK 局部处理下的包构建；未执行未修改的完整 GitHub release 工作流，尚不能证明远端 CI 无须环境修复即可通过。

真实浏览器、路由器安装、eBPF 加载、会员服务联网及真实流量未验证。不自动升级设备。

## 复用与恢复

日后继续同步前 fetch 两个远端并核对 SHA；保留 merge commit，不 squash/rebase 掉上游祖先关系。本阶段未新增整包同步 PR/排程，现有 `auto-bump.yml` 仍是底层依赖更新器，后续自动化阶段需按 `upstream-sync-plan.md` 处理双更新来源和发布配置。

交付附件 `ff110-upstream-baseline.bundle` 是以现有下游 main 为基础的增量 Git 包，保留本地分支和 merge 历史；使用已有该基线的仓库可执行：

```sh
git bundle verify ./ff110-upstream-baseline.bundle
git fetch ./ff110-upstream-baseline.bundle refs/heads/agent/agent/ff-110:refs/heads/review/ff110-upstream-baseline
git worktree add ../ff110-review review/ff110-upstream-baseline
```

这些命令建立独立审阅分支，不向 GitHub 写入。不要在原 main 上直接覆盖文件或丢弃合并历史。

本地版本控制作为恢复基线，没有额外 `.bak` 文件。查看合并前产品可使用独立 worktree 指向 `c7f9fc7`；不要 reset 覆盖用户的 main 或任务分支。若将来需要在共享历史撤回，先评估并回滚补充修复 `946327d`，再对 `9801d0d` 以主线父提交 1 做 revert。回滚后 Git 仍记录上游已合入，不能认为再 merge 同一 SHA 会自动重做更新。

暂存安装目录、合成冲突仓库和回归反证副本均由测试自动清理。SDK 下载、工具副本及日志保存在任务 `.multica/` 下；用于复测，未纳入 Git 提交；本轮构建及临时检查容器均已退出，Docker Desktop 与 SDK 镜像缓存保留。最终 SDK 脚本、输入版本、初次失败/重试日志和包校验结果通过 `ff110-validation-evidence.tar.gz` 附件交付。未执行 git push、创建 PR、Actions dispatch、Release 或平台配置变更。

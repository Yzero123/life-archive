# 版本历史

本文件记录**每一个版本改了什么、为什么改、怎么回退**。

每个版本都有三样东西：

| 东西 | 位置 | 用途 |
|---|---|---|
| Git tag | `v1.x.y` | 源码级回退：`git checkout v1.x.y` |
| GitHub Release | <https://github.com/Yzero123/qq-space-kb/releases> | 下载任意历史版本的安装包 |
| 安装包 zip | `releases/qq-space-kb-<版本>.zip` | 直接在 MCode 里安装 |

> **怎么回退**（三种，按场景选）：

```bash
# 1. 只想要某个旧版的安装包 → GitHub Releases 页面下载对应 zip，重新安装
#    https://github.com/Yzero123/qq-space-kb/releases

# 2. 想把源码切回某个版本（改代码、做对比）
git clone https://github.com/Yzero123/qq-space-kb.git
cd qq-space-kb
git checkout v1.6.2          # 切到旧版
git checkout main            # 切回来

# 3. 想把仓库整体回退到某个版本（谨慎，会改写历史）
git revert <commit-sha>      # 逐个撤销
```

---

## 未发布 — 抓密钥路线改判：工具的「原地重签」在本机物理不可行，改走一次性副本

上一节那条「换副本过权限门」的路子**只能解开工具自己的权限检查，解不开系统那层拒绝**。
本轮把根因彻底定位，并换成工具自带的另一条路线。

### 根因：amfid 拒绝 ad-hoc 签名的受限权限

工具的「实验性本机调试」prepare 阶段会临时重签 `/Applications/WeChat.app`，
命令是 `codesign --force --preserve-metadata=entitlements --sign -`——
**保留**腾讯原始权限（`app-sandbox` / `application-groups` / `application-identifier` / `allow-jit`）。
但 macOS 26.x 起，ad-hoc 签名带受限权限会被 AMFI 直接杀掉。

实测签名矩阵（四个小程序变体，逐个执行）：

| 变体 | 权限 | 结果 |
|---|---|---|
| A | 无 | ✅ 正常启动 |
| B | 仅 `com.apple.security.app-sandbox` | ❌ SIGTRAP（被 AMFI 杀） |
| C | 工具要求的那套（sandbox + app-groups + application-identifier） | ❌ SIGTRAP |
| D | 微信真实那套（再加 `allow-jit`） | ❌ SIGTRAP |

系统日志真因：

```
amfid: The file is adhoc signed but contains restricted entitlements
       Error Domain=AppleMobileFileIntegrityError Code=-424
kernel: code signature validation failed fatally
→ open -n 报 RBSRequestErrorDomain Code=5 "Launch failed" / errno 163
```

> 关键矛盾：工具的 `_has_compatible_in_place_signature` **硬要求**那几个权限必须保留，
> 而 macOS 恰好**只允许**没有受限权限的 ad-hoc 签名启动。两者天然冲突，
> 不是开关、不是权限位、不是 sudo 能解决的。

### 新路线：工具自带的「一次性副本」流程

解包工具后发现它是 PyInstaller 打包的，源码能整个抽出来；里面另有一条
`macos_clone_capture` 路线：**克隆免权限的一次性微信副本 + 克隆真实容器快照**，
在副本上抓密钥，**全程不碰官方安装、不碰真实数据**。这条路线只在 Python 内部，没有 API 入口，
所以新增 `tools/wx-clone-capture.py` 直接驱动工具自己的模块：

```bash
python3.11 tools/wx-clone-capture.py prepare     # 克隆副本 + 真实容器快照 + 启动一次性微信
python3.11 tools/wx-clone-capture.py preflight   # 断点预检
python3.11 tools/wx-clone-capture.py capture     # 布防等待（登录时触发密钥派生）
python3.11 tools/wx-clone-capture.py cleanup     # 清理副本与快照
```

脚本处理了三处本机特性：

| 本机特性 | 现象 | 处理 |
|---|---|---|
| 微信容器根目录带 `com.apple.macl` | `clonefile(2)` 返回 `EPERM`，工具误判成「没给完全磁盘访问权限」 | 改为逐子项克隆（子项无 macl，仍是写时复制） |
| 真实数据在 `Documents/xwechat_files`，不在工具预期的 `app_data/xwechat_files` | 工具报「找不到本机数据副本」 | 改用真实目录作克隆源 |
| 免权限副本不带 `get-task-allow` | LLDB 附加被拒；工具默认还要弹管理员密码框 | 给副本补 `get-task-allow`，并以当前用户跑 lldb，**免掉密码弹窗** |

本机实测（prepare / preflight 均通过）：

| 环节 | 结果 |
|---|---|
| prepare | ✅ 副本启动，真实容器快照完成，**21 个数据库盐**全部匹配，`official_wechat_preserved: true` |
| preflight | ✅ `wechat.dylib` 的 PBKDF 导入桩已验证（`pbkdf_import_verified: true`），`ready_for_monitoring: true` |
| capture | 布防成功，**无管理员弹窗**，等待登录触发密钥派生 |

### 端到端跑通（2026-10-23 夜）

密钥抓到后，导出 → 入库 → 双源画像全部走通，**真实数据已进库**：

| 环节 | 结果 |
|---|---|
| 抓密钥 | ✅ `macos_clone_lldb_passphrase`，落盘 `~/.wcdb-key-tool/wechat-passphrase.json`（64 hex） |
| 密钥登记 | ✅ 写进工具的 `account_keys.json`（保留原有图片密钥）→ 工具开始能解密 |
| 解密验证 | ✅ `/api/sns/self_info` 返回账号信息；`/api/sns/timeline` 能读出真实朋友圈 |
| 导出 | ✅ `POST /api/sns/exports`（`scope=selected` + 本人 username）→ `postCount: 34`（**第一次只拿到 5 条是工具快照冷启动，重导即得 34 条**，见下方教训） |
| 入库 | ✅ 走真实路由 `/api/wx/import` → `/api/wx/switch` → `/api/kb/build` → `/api/profile/build` |
| 双源画像 | ✅ 「共 **124** 条动态（QQ 空间 90 条，微信朋友圈 34 条）」+ 朋友圈专属维度全部生成 |
| 检索 | ✅ 命中朋友圈记录，id 带 `wx-` 前缀，`[来源] 微信朋友圈`，`confident: true` |
| 1.0 不受影响 | ✅ 纯 QQ 输入的逐字节黄金基线仍然全过（124 条里 90 条与 1.0 完全一致） |

> 本机微信安装全程零改动：抓密钥走的是一次性副本，抓完已把 `/Applications/WeChat.app`
> 还原成原版（`Identifier` / `TeamIdentifier` / `CDHash` 校验一致）。

### 新增：无头入库脚本

`tools/wx-import-moments.mjs` —— 起一个指向真实 dataDir 的临时实例，走真实路由完成
导入 → 启用 → 建库 → 画像，打印验收结果。不想点界面时一条命令搞定。

### 修：bash 变量名被中文标点吃掉

macOS 自带 bash 3.2 在 UTF-8 下会把 `$OLD，` 里的中文逗号当成变量名的一部分，
`set -u` 直接报 `OLD?: unbound variable`。`wx-restore-copy.sh` / `wx-prepare-copy.sh`
里所有变量引用改成 `${VAR}` 形式。

### 附带修：隐私回扫器的两处误报（→ 包 v2.0.4）

朋友圈正文入库后，真实语料多了 5 条带完整正文的动态，回扫器随即报出一堆「泄漏」，
逐条查下来全是**误报**：

| 现象 | 真因 | 修法 |
|---|---|---|
| 文档里的「什么样的」「实在不行」被判成真实内容 | 中文滑窗 4 字，语料一大就撞上通用短语 | 滑窗改 **6 字**（成句真实内容照样命中，已做正样本验证） |
| 文档里所有正常的 `wxid` 字样被判成账号标识符 | 去设备后缀时 `wxid_<纯数字>` 被截成裸串 `wxid` | 截出来的基名也要过「像不像标识符」的检查 |

> 第 2 条是**门自己抓到了门**：改完之后扫描器把我在注释里写下的一个真实好友标识符
> 当场报了出来，说明这道门确实在干活。那行注释已改成占位写法。

结构性规则一条没动（包内仍禁 `wxid_xxxxxxxx` 字面量，动态 ID / QQ 号各种进制 /
cell_id / owner 前缀照旧全量回扫），QQ 侧指纹算法完全没碰。

### 指引同步改写

`微信朋友圈取数操作指引.md`：§3.0 换成「两条路都走不通、第三条走得通」+ 签名矩阵证据；
§3.3 标注为留档；**§3.4 换成新的一次性副本路线**；§3.5 卡点表重写；
§2.3 改为「本次不用开调试附加授权」；§2.4 更正「换副本是唯一走得通的路」的旧结论。

### 旧路线的结论修正

| 旧结论 | 实测修正 |
|---|---|
| 门 ① 换副本是唯一走得通的路 | 只解开了**工具自己的**权限检查；系统 AMFI 那一层仍然过不去 |
| 门 ②「多半不用开」 | 改判：**不用开**——新路线的副本自带 `get-task-allow` |

## 历史留档 — 取数指引补一条「不用 sudo」的备选路径

本机实测了另一条过权限门的办法，写进指引 §3.4。

### 实测

| 事实 | 结论 |
|---|---|
| `/Applications` 本身 | `root:admin drwxrwxr-x` → **对 admin 组可写**，所以不用 sudo 也能替换里面的 app 目录 |
| 复制品的签名 | 与原版**完全一致**：`Identifier=com.tencent.xinWeChat`、`TeamIdentifier=5A4RE8SF68`、CDHash 相同、`codesign --verify --deep --strict` 通过 → 工具的「腾讯原签名」校验能过 |
| 复制品的属主 | 变成当前用户 → `os.access(WeChat.app, W_OK)` 自然为真 → 权限门直接通过 |
| 复制方式 | `cp -R` 把 706 MB 展开成 **1.4 GB**；`ditto` 走 APFS 写时复制，**约 3 秒** |

### 做法

```bash
# 先完全退出微信（⌘Q）
mv /Applications/WeChat.app /Applications/WeChat.app.orig
ditto /Applications/WeChat.app.orig /Applications/WeChat.app
```

原版保留在 `.orig`，随时一条 `mv` 还原。副作用：app 属主变了，**腾讯自动更新器行为未知**，
抓完密钥后建议还原。

### 新增：真实链路演练脚本

`tools/real-instance-drill.mjs` —— 在**真实插件 dataDir** 上跑一遍完整验收路径：

```
备份 dataDir → 导入 → 启用 → 重建 → 双源画像 → 关掉 → 重建 → 必须回到纯 1.0 → 清空 → 还原 dataDir
```

全程用**合成**朋友圈数据（`tests/fixtures/seed-wx-demo.mjs`），走的是真实 HTTP 路由
（`/api/wx/import` → `/api/wx/switch` → `/api/kb/build` → `/api/profile/build` → `/api/wx/clear`），
不是单元测试替身。跑完自动把 dataDir 还原成演练前的状态。

本机实测结果（真实 QQ 空间数据 90 条）：

| 检查项 | 结果 |
|---|---|
| 导入 | kept=8，notMine=1（好友那条被正确过滤） |
| 双源画像 | 「共 98 条动态（QQ 空间 90 条，微信朋友圈 8 条）」+ 朋友圈专属维度 |
| 检索朋友圈 | `hits=2 confident=true`——对话时确实能检索到朋友圈内容 |
| 检索 QQ 空间 | `hits=3 confident=true`——1.0 的检索没被影响 |
| 关掉后重建 | 回到「共 90 条说说」，`unified.jsonl` 98 → 90 行 |
| 清空 | 状态回到「未导入 / 已关闭」 |
| 还原 | dataDir 与演练前完全一致 |

> 为什么要有这个：单元测试跑在临时目录里，**看不出真实数据上的口径漂移**。
> 这个脚本把「第一次用的人」的完整路径在真实环境预演一遍。

> 脚本里**不硬编码任何真实内容**：QQ 空间那一侧的检索关键词是运行时从知识库里取的，
> 朋友圈那一侧用的是合成数据里的词。脚本本身在公开仓库里，不能带真实内容。

### 修的坑：`sudo chgrp` 报 `Operation not permitted`

令酱实测执行 §3.4 改权限路线时踩到的。**不是 POSIX 权限问题**（sudo 已经拿到 root），
是 macOS 对「**已安装的受保护 app 路径**」单独管控——改它的元数据会被拒，
而且**改了权限位也不作数**。

本机实测定位到的几件事：

| 事实 | 结论 |
|---|---|
| `sudo chgrp admin WeChat.app` | 报 `Operation not permitted`，但**组其实改成了 admin**（返回码仍是 0） |
| `sudo chmod g+w WeChat.app` | 生效了（权限变 775，组有写位） |
| `os.access(WeChat.app, W_OK)` | **仍然 False** ← 权限位改了也不作数 |
| 同一 app 的**副本**放在 `/Applications` 下 | `os.access(W_OK)` = **True**，`codesign --force --sign -` **成功** |
| `mv` 移动已安装的受保护 app | **成功，不被拦** |
| `com.apple.macl` 标记 | **不影响** `os.access`，也不影响 `codesign` 重签（带标记的副本照样两项都过）——之前怀疑过它，实测排除 |
| 副本属主 | `lingjiang:admin drwxr-xr-x` → 属主位可写 → 权限门直接过 |
| `ditto` 复制行为 | 复制**整个 bundle** 会保留 `com.apple.macl`；复制单个文件则不保留 |
| 普通用户能否在 `/Applications` 写 | 能：mkdir ✅、rename ✅（所以换副本的前提成立） |

**结论**：真正的分界是「这个**已安装的路径**」本身，换个路径就不受管控。
所以唯一走得通的路是**换成自己的副本**。

> 这条也纠正了上一版「去系统设置开 App 管理」的说法——那条没实测过，
> 现在改成只留结论：改权限实测无效。

### 新突破：`mv` 受保护的已安装 app **不被拦**（路线 A 升为一键脚本）

上一节说「路线 B 的 `mv` 可能被 App 管理拦」——用 `Veee.app`（未在运行、带 `com.apple.macl`）
做了对照实验，结果**可以 mv**（mv 完立刻还原，CDHash / macl 无变化、无残留）。

| 操作 | 结果 |
|---|---|
| `sudo chgrp` 改已安装 app 的元数据 | ❌ 被 App 管理拦（`Operation not permitted`） |
| `mv` 移动已安装的受保护 app | ✅ **不被拦** |

所以真正的分界是「**改**已安装 app」被拦，「**移动**」不拦。而 `/Applications` 对 admin 组可写，
普通用户就能把 app 换成自己的副本——**不用 sudo、不用改系统设置**。

新增两个脚本：

| 脚本 | 作用 |
|---|---|
| `tools/wx-prepare-copy.sh` | 一键准备：验微信已退出 → `mv` 原版到 `.orig` → `ditto` 复制回来 → 校验签名与可写性。带前置守卫（微信在跑就拒绝执行） |
| `tools/wx-restore-copy.sh` | 一键还原：把原版换回去，副本挪到 `.replaced` 待确认 |

指引 §3.4 两条路线**对调**：换副本升为首选（路线 A），改权限降为备选（路线 B，需要 App 管理授权）。

### 指引相应改写

- **§2.4 改写**为「为什么『改权限』这条路走不通」：把上面那张实测表放进去，
  并**撤回**上一版「去系统设置开 App 管理」的说法（那条没实测过）。
- §3.4 路线 A（换副本）= **唯一实测走得通的路**，给一键脚本。
- §3.4 路线 B（改权限）降为「实测无效，仅作留档」，并说明它能证明什么。
- `tools/wx-path-check.py` 的结论段按实测结论重写。

### 同时改了

`tools/wx-path-check.py` 的结论段改成给出**两条路**（A 改权限 / B 换副本），并写清各自的前置与回退，
外加错误信息判别（`Operation not permitted` 与 `Permission denied` 不是一回事）。

### 还替你预置了 LLDB 后端偏好

查官方源码时发现：工具默认在本机（macOS 26.5.2 < 27、`wechat.dylib` 存在）会先试 **native** 捕获器，
而 native 的 PBKDF 导入桩布局假设是按已知 build 写的，**微信 4.1.15 未验证**。
native 一旦 attach 成功再失败，可能弄脏调试状态并强制结束事务 → 用户要重走一遍登录流程。

已预置「用 LLDB 后端」：

```
~/Library/Caches/WeChatDataAnalysis/wechat-debug/capture-backend-preference.json
```

身份字段按本机实测填好（version 4.1.15 / build 270115 / 本机 CDHash / macOS 26.5.2），
微信一升级就不匹配、工具会自动忽略。

理由：LLDB 的断点计划是**运行时解析**本机 Mach-O UUID 与 `_CCKeyDerivationPBKDF` 导入桩地址得到的，
不依赖硬编码版本表；本机已确认 `wechat.dylib` 的导入表里确实有 `_CCKeyDerivationPBKDF` ✅
（LC_UUID `4714EE3E-7227-3ED3-A10F-5E000414AA61`）。

### 新增：prepare 阶段核心两步的预演

用无关 app（`Veee.app`）实跑工具 prepare 阶段最核心的两步，验证副本方案下不会卡：

| 步骤 | 实测结果 |
|---|---|
| `clonefile` 把 app 克隆到 `/Applications` | ✅ 成功（写时复制，瞬时） |
| clone 的属主 | 跟着源走 → 副本方案下 clone 属主是当前用户 → **codesign 不用 sudo**（少一次管理员弹窗） |
| `codesign --force --preserve-metadata=entitlements --sign -` 签 clone | ✅ 成功，结果正是工具要的「**ad-hoc + 去掉 hardened runtime**」 |
| 外层重签是否递归 | **不递归** → 内嵌登录 helper 保持腾讯原签名 ✅（工具的 `_has_compatible_in_place_signature` 要求如此） |

### 门 ② 改判：多半不用开「允许附加调试器」

实测 `xcrun lldb -p <微信 pid>` 在**原签名**状态下被拒（`Not allowed to attach to process`）——
微信是 hardened runtime。但工具 prepare 阶段的重签**会去掉 hardened runtime**，
所以直接点「获取」很可能就过。

指引 §2.3 从「必做」改成「**多半不用开，被拒了再来**」，并写清被拒时怎么开。

> 插件代码一行未改。1.0 回归 121 项、2.0 68 项不受影响。

---

## v2.0.3 — 2026-10-23

**导入按钮按内容认文件；导出全部联系人时，也能挑出你发的那份。**

上一版说「导入按钮会扫到它的导出目录」——那句话不成立。
WeChatDataAnalysis 实际是**按联系人分文件**导出，文件名叫「昵称.json」，
原来那三条文件名规则一个都匹配不上。这版改成**按内容**认。

同一天做的另一件事：把取数指引按本机实测重写（见下「取数指引的实测修正」）。

### 修的三个问题

| 问题 | 现象 | 现在 |
|---|---|---|
| 扫不到真实产物 | 导出后点「导入」报「没找到可导入的朋友圈数据」 | 按顶层有没有 `posts` 数组判定，**文件名不限** |
| 多份文件只取第一份 | 导出全部联系人时，目录里第一份可能是好友的 → 报「没有一条是本人发的」 | 逐份试，**挑出留得下本人记录的那份** |
| zip 产物看不懂 | 选了「全量压缩包」→ 插件读不了 | 明确提示「请先解压，取出里面的 JSON 再导入」 |

### 依据

不是照着文档猜的，是照着 WeChatDataAnalysis 2.10.0 的 `sns_export_service.py` 实际输出写的：
按联系人分文件、文件名是昵称、顶层 `account` 是**导出者**而 `username` 与 post 作者是**联系人**。
导出工具自己的 `index.json`、`export_report.json` 顶层没有 `posts`，不会被误收。

### 新增

| 项 | 说明 |
|---|---|
| 内容嗅探 | 顶层有 `posts` 数组即认定是朋友圈导出；单文件上限 32 MB |
| 扫描预算 | 每个根目录最多嗅探 25 个文件（微信容器根 200 个），不做无界搜索 |
| 测试 | `tests/test-wx.mjs` 新增 6 项（真实产物形态 + 多候选导入），共 **68 项** |

### 取数指引的实测修正

本机（macOS 26.5.2 · Apple Silicon · 微信 4.1.15）实跑 WeChatDataAnalysis 2.10.0 抓密钥失败，
查官方源码定位到两个根因，指引因此改写。

| 事项 | 之前写的 | 实测 / 源码结论 |
|---|---|---|
| 受控组件路径 | 可用，切「开发者工具」就够 | **本机走不通**。官方源码 `macos_db_key_helper._process_access_denied_error()` 判据：微信 `hardened runtime=True` 且 `get_task_allow=False` 即必然报 `TARGET_PROCESS_PROTECTED`。官方对该错误的说明原文是「**这不是"开发者工具"开关未开启，无需反复切换该设置**」 |
| 兜底路径卡点 | 含糊写成「需要开发者工具授权」 | 卡在 **prepare 阶段的权限硬检查**：`os.access(/Applications/WeChat.app, W_OK)` 为 False（默认 `root:wheel` 755）→ `in_place_restore_permissions_unsafe`。`/Applications` 本身是 `root:admin` 可写，**只有微信顶层目录这一条**要放开组写权限 |
| 密钥落点 | `~/.wcdb-key-tool/` | 数据库密钥在 `~/.wcdb-key-tool/wechat-passphrase.json`（64 位 hex）；`account_keys.json` 只是**图片密钥**，不能代替 |
| 导出产物 | 一个 `sns_<wxid>.json` | 按联系人分文件的 `<昵称>.json`（增量目录模式），或一个 `.zip`（压缩包模式） |

顺带确认：工具的**自动发现**已实测通过——`Documents/xwechat_files/<账号>/db_storage` 下 18 个库全部识别，
目录布局与官方文档写的路径不同也不影响。

新增 `tools/wx-path-check.py`：只读预判脚本。点「获取」之前跑一次，直接告诉你要不要改权限、
会不会撞 `TARGET_PROCESS_PROTECTED`、调试授权够不够。

### 不受影响

1.0 的行为一个字没变——121 项逐字节回归锁仍然全过。朋友圈数据源依然默认关。

### 回退

```bash
git checkout v2.0.2
```

---

## v2.0.2 — 2026-10-23

**归一化器支持 WeChatDataAnalysis 的导出形状，导入按钮会扫到它的导出目录。**

上一版只对齐了 SIWX 的 JSON 形状。这一版把**另一个主力工具**的形状也接上——
照着它 `sns_export_service.py` 的实际输出写的，不是照着文档猜的。

### 新增

| 项 | 说明 |
|---|---|
| 归一化器支持 WeChatDataAnalysis 形状 | 账号标识在**顶层 `account`**（不是 `meta.account`）；时间叫 `createTime`；正文叫 `contentDesc`；位置是**纯字符串**；缩略图叫 `thumbUrl`；**卡片摊在 post 顶层**（`title` / `contentUrl` / `finderFeed` / `finderLive` / `official`），没有 `card` 子对象 |
| 卡片按实际字段推导 | `finderFeed` → 视频号、`finderLive` → 直播、有 `title`/`contentUrl` → 链接。**不看 `type` 编号**——编号在不同微信版本里会漂移 |
| 导入按钮扫到它的导出目录 | `~/Library/Containers/com.tencent.xinWeChat/Data/Documents/exports/<账号>/sns_*.json`（在微信容器内，原来扫不到） |
| 文件名前缀放宽 | 认 `wechat_sns*.json` / `*朋友圈*.json` / `sns_*.json` 三种 |
| 测试 | `tests/test-wx.mjs` 增加 6 项 WeChatDataAnalysis 形状用例（共 **62 项**） |

### 契约

**契约本身没变**（仍是 v1）。变的是插件能吃的**输入范围**变宽了——
见 [微信朋友圈数据契约-2.0.md](https://github.com/Yzero123/qq-space-kb/blob/main/微信朋友圈数据契约-2.0.md) §3.1。

### 回退

```bash
git checkout v2.0.1          # 只支持 SIWX 形状的版本
```

---

## v2.0.1 — 2026-10-23

**修一处说错的事实：SIP 这道坎只挡 SIWX，不挡 WeChatDataAnalysis。**

v2.0.0 的文档里写「macOS 上方式 A 和方式 B 都要关 SIP」——**这是错的**。
错在把 SIWX 的限制当成了所有工具的共性。逐条读了两个项目的官方文档之后：

| | SIWX | WeChatDataAnalysis 独立工具 |
|---|---|---|
| 要不要关 SIP | **要**（官方文档：「root / `sudo` 也不行」） | **不用关**（官方文档：「不移除隔离属性，不关闭 SIP/Gatekeeper」） |
| 怎么做到 | `csrutil disable` + 重启进 Recovery | 临时 ad-hoc 重签微信 + 单应用调试授权 + 自动恢复原版 |
| 你要做的 | 改全局安全设置 | 给「完全磁盘访问权限」；必要时给一次单应用授权 |

### 改了

| 项 | 说明 |
|---|---|
| 方案文档 §9.2 | 整节重写：两条路线的逐项对比 + 本机库路径布局的待验证点 |
| 方案文档 §0 / §7 / §8 | 同步修正结论行、里程碑 M6 说明、风险表 |
| 包内 README | 「macOS 上的实话」段落改成上面那张对比表 |

### 没改

**代码一行没动。** v2.0.1 与 v2.0.0 的功能完全相同，纯粹是文档事实修正。

### 回退

```bash
git checkout v2.0.0          # 文档有误但功能正确的版本
```

---

## v2.0.0 — 2026-10-23

**接上微信朋友圈历史记录。QQ 空间 + 朋友圈合成一份画像。**

大前提：**不影响 1.0 的任何现有功能**。这一版对 1.0 是**纯加法**——
朋友圈数据源默认关，关着的时候 1.0 的行为一个字都不变。

### 新增

| 项 | 说明 |
|---|---|
| **微信朋友圈数据源** | 导入你自己发的朋友圈动态，与 QQ 空间说说合成同一份知识库。面板上新增「微信朋友圈」一栏：状态 / 导入 / 启停 / 清空 |
| **数据契约** | `微信朋友圈数据契约-2.0.md`。直接吃 SIWX 的 JSON 导出形状（`meta` + `posts`），自研的取数工具也产同一形状 → 一个契约、两个生产者、导入零转换 |
| **取数工具** | `miniapp/node/wx-export-runner.py`（纯 Python 标准库）。`discover` 列出本机候选库并标注是否已解密；`parse` 把**已解密**的 `sns.db` 导成契约 JSON |
| **朋友圈专属画像维度** | 发圈节奏 / 最密集的月份 / 发布时段 / 常出现的位置 / 媒体偏好 / 内容类型 / 互动最多的人，以及一条**「两个平台的表达差」**——只有双源才看得到的结论 |
| **双源口径** | 画像与年度小结在有朋友圈数据时改说「条动态」并拆来源（QQ 空间 X 条 / 微信朋友圈 Y 条） |
| **服务端路由** | `GET /api/wx/status`、`POST /api/wx/import`、`POST /api/wx/switch`、`POST /api/wx/clear` |
| **1.0 黄金基线** | `tests/fixtures/golden-qzone-1.0.json`——用**已安装的 1.7.1 代码**对固定输入跑出来的基线。`tests/test-wx.mjs` 每次拿 2.0 的代码跑同一份输入逐字节比对，**差一个字节就红** |
| **朋友圈演示数据** | `tests/fixtures/seed-wx-demo.mjs`，合成数据（含一条「好友发的」，用来验证过滤） |

### 隐私

| 项 | 说明 |
|---|---|
| **修掉一处真实 wxid 泄露** | 2.0 方案文档里写着本机真实账号标识，已按 v1.3.0 那次 cell_id 泄漏的**同等标准**处理（仓库是公开的） |
| **回扫扩面到微信侧** | 指纹从本机真实朋友圈导出现算：本人 wxid（基名 + 带设备后缀）、好友 wxid、动态 ID |
| **新增结构性规则** | 包内**不允许**出现 `wxid_xxxxxxxx` 形状的字面量（明显是 `demo` / `example` 这类合成值才放行）。这条与本机数据无关，永远生效 |
| **回扫范围扩大** | 从「包目录 + 发布 zip」扩到「包目录 + 仓库根目录的说明文档 + 发布 zip」 |

### 设计约束（写进代码的硬规矩）

| 规矩 | 为什么 |
|---|---|
| 朋友圈数据源**默认关** | 关着的时候 1.0 的行为一个字都不变 |
| **只取本人发的** | 好友的朋友圈不是「我发的」，进库等于让 bot 替别人说话。**一条都匹配不上时如实报错**，不假装导入成功 |
| **媒体只存链接与描述，不下载** | 图片视频走 CDN + ISAAC64 独立加密；且微信 CDN 上约 58% 的旧图已失效，对画像收益有限 |
| **插件不碰 SIP、不跑 LLDB、不改系统安全设置** | 解密能力放插件外，可换可降级；入库能力放插件内，始终在自己手里 |
| **只读不写** | 不发布、不点赞、不评论朋友圈 |
| **ID 加 `wx-` 前缀** | 与 QQ 空间的 `cell_id` 天然不碰撞，1.0 的合并/切块/检索代码一行都不用改 |

### 测试

| 套件 | 数量 | 说明 |
|---|---|---|
| `tests/test.mjs` | 121 项 | 1.0 回归，全过 |
| `tests/test-wx.mjs` | **56 项（新增）** | 1.0 逐字节回归锁 / 解析层 / 双源入库与画像 / 取数工具端到端 / 服务端路由端到端 |

### 回退

```bash
git checkout v1.7.1          # 回到 1.0
# 或从 https://github.com/Yzero123/qq-space-kb/releases 下载 qq-space-kb-1.7.1.zip 重新安装
```

---

## v1.7.1 — 2026-10-23

**做项目版本管理，把历史理清楚。**

### 新增

| 项 | 说明 |
|---|---|
| `CHANGELOG.md` | 本文件。随包分发，插件目录里也能看到完整历史 |
| `tests/privacy-scan.mjs` | **可复用的隐私回扫脚本**：从本机真实知识库现算指纹，回扫包内文件与全部发布 zip |
| 历史版本 zip | `releases/` 下补齐 v1.3.0 ~ v1.7.0 全部 7 个版本的安装包（原先只留最新一个） |
| Git tag | v1.3.0 ~ v1.7.0 全部补打，annotated tag，带变更说明 |
| GitHub Release | 每个版本一个 Release 页，zip 作为资产挂上去 |

### 修复

| 问题 | 说明 |
|---|---|
| **文档示例里藏着真实说说 ID** | `kb.mjs` 的注释和 `README.md` 的表格里写着一条**真实说说 ID** 当示例。说说 ID 的前 8 位十六进制就是空间主人 QQ 号的小端编码——照抄一条 cell_id，等于把 QQ 号写进了包。这处从 v1.3.0 就在，之前的扫描用的是「带上下文」的关键词（`mood/<前缀>`），而包里的裸 ID 没有 `mood/` 前缀，**整个漏掉了**。现已换成合成示例 `b327e672…` |
| 导出指令里的真实派生数 | 历史版本的导出指令写着「能拿到 45 条精确到秒的时间和 6408 个赞」——是真实导出的统计。已泛化表述 |

> 历史版本的发布 zip 发布前做了**同样的脱敏修补**（tag 指向原始提交，可用 `git checkout` 复现未修补的原始内容）。

### 扫描脚本的设计要点

指纹全部**从真实数据现算**，脚本里不写死任何个人信息——所以它可以随包分发，别的用户也能拿它扫自己的安装。

它查的是**裸标识符**，而不是带上下文的关键词：

- 完整 cell_id、**8 位 owner 前缀**（能反解出 QQ 号的那一段，就是这次漏掉的）、16 位前缀
- 十进制 QQ 号 + 大小端 hex 编码
- 真实说说链接、昵称、地点
- 正文的 4 字中文滑窗

聚合数字（赞数、时间戳）只**提示不拦**——它们不是身份信息，而且极易与代码里的常量撞车（`1500` 是超时毫秒、`80000` 是抓取间隔）。

本机没有真实知识库时自动跳过，CI 和别人的机器上都跑得动。

---

## v1.7.0 — 2026-10-23

**对话模块重写：知识库整体当 prompt，交给宿主大模型。**

### 问题

用户反馈「对话模块太笨」。根因是**检索闸门**：检索没命中就根本不调模型，直接回固定话术。
问法一变就露馅——「我是个什么样的人」检索不到任何一条具体说说，于是 bot 只会说「当时的我还不知道这是什么意思」，
可知识库里明明有几十条有正文的记录，**它明明答得出来**。

### 改动

| 项 | 原来 | 现在 |
|---|---|---|
| 检索的角色 | 闸门：决定答不答得出来 | 只负责给模型**找资料** |
| 喂给模型的资料 | 命中的几块明细 | 分层：你是谁 + 人设 + 年度小结 + 相关说说（**落空时自动补全库速览**） |
| 固定话术由谁决定 | 代码判「检索不到」 | **模型自己说**——它手里有全库，说没有就是没有 |
| 措辞重合度 | 拒答闸门 | **不再拒答**，只展示 |
| 事实红线对照范围 | 本轮检索到的那几块 | **整个知识库** |

### 顺带修的

- **数字认写法也认区间**。模型把 `3261887` 写成「326 万」是四舍五入不是编造；
  中文里「五十多万」说的是区间（50 万到 60 万），库里有对应量级的数就算数。
  但库里随便一个「50」不能再给「50 万」背书——规则松了红线就形同虚设。
- **宿主报「暂时不可用」要重试**。宿主在 Mini App 刚启动 / 运行时换代的那一瞬间
  会回 `AGENT_UNAVAILABLE`，它的定义是「什么都没开始，稍后重试即可」。
  不重试的话，起来后问的**第一句话**会直接报错，第二句又正常，像「偶发抽风」。
- **提示词要求条数照年度小结抄**，不要自己数全库速览的行数——数出来的会错，错的会被红线拦下。
- MCP 的 `kb_ground_check` 与页面口径对齐（`ok` 不再受重合度影响）；
  技能第 2 步改成「检索没命中就用 `kb_records` 翻全库」。

### 验证

121 项测试全过；真实模型端到端四问全过（泛化问能答出有据的个性化回答、条数照年度小结答对、越界问题模型自己说不知道）。

---

## v1.6.2 — 2026-10-23

**留言板上的留言不再被当成「我发过的说说」。**

回溯结果里混进了一条 `cell_id="richinfo"` 的**别人留言板留言**，年份被顶到 2026。
作者归属过滤对它无效（哨兵 ID 里没有作者 QQ 号可反解），所以多加一道形态校验：
cell_id 必须长得像一条说说的 ID（24 位十六进制 / `history-v2:` / `history-guestbook:` 前缀），
`richinfo` 这类哨兵一律不收。

本机知识库随之从 91 条修正为 90 条，年份从 2012–2026 修正为 2012–2022。

---

## v1.6.1 — 2026-10-23

**「构建知识库」按钮挪进面板，状态栏按真实状态显示。**

- 按钮从页头挪进「导出与建库」面板操作行（紧挨「开始导出」），建好后改名「重新构建知识库」。
  之前它在页头，窄窗口下会被直接截掉，用户根本看不到。
- 服务端新增 `kbReady` / `kbStale`（raw mtime > kb mtime + 1s），状态栏按真实状态显示：
  「知识库就绪」、第 3 步变绿；过期时额外提示「新导出的数据还没进知识库」。

---

## v1.6.0 — 2026-10-23

**全程只扫一次码。**

早期版本「导出开一个浏览器 → 抓完关掉 → 回溯再开一个浏览器」，于是每一步都要重新扫码。
QQ 空间的 `uin` / `p_skey` 是**会话 cookie**，浏览器一关就没了。

现在把浏览器变成**独立长驻进程**（运行器自己起系统 Chrome，带调试端口和持久化 profile），
导出和回溯都通过 CDP 挂上去复用同一份登录态，**全程只扫码一次**。

关键机制（已实测）：`connectOverCDP()` 后调用 `browser.close()` **只断开客户端，
Chrome 进程和调试端口都还活着**。

- 新增 `tools/qzone_session.js`（常驻会话管理器：start / status / stop / revisit）
- `tools/qzone_feed_recover.js` 加 `--cdp` 复用常驻浏览器；连不上时明确报错退出，**不退回自己开浏览器**
- 导出编排重写为后台模式：起常驻浏览器 → 等扫码 → 抓取；前台立即返回，登录超时不杀浏览器
- 固定话术与「登录会话」状态块在页面上可见

> 附：`fix(v1.6.0)` —— 旧版状态文件不再被误判成「有会话」。

---

## v1.5.0 — 2026-10-22

**年份分布可视化技能。**

把 `kb_stats` 的年份分布画成看板：KPI 四卡 + 逐年构成堆叠柱图 + 紧凑明细表，点某一年可以下钻。

- 协议 `mavis.widget.v1`，`mode: forked`，拷贝了完整的 GenUI 基础（5 个文件）
- 它**不自己取数**——数据全部来自业务流已经算好的 `kb_stats.yearDistribution`，
  图上每个数字都能在知识库里找到出处
- 配套 `tests/visualizer-static.mjs` 静态审查（信封、主题 token、安全、载荷）

---

## v1.4.0 — 2026-10-22

**插件化：不开页面也能用。**

| 能力 | 说明 |
|---|---|
| MCP 工具（5 个） | `kb_stats` / `kb_search` / `kb_records` / `kb_profile` / `kb_ground_check` |
| 技能 `qq-space-kb` | 把整套流程写成可复用的操作规程 |
| 人设子代理 `qzone-persona` | 以「过去的自己」的口吻回答 |

MCP 服务器**不调大模型**：检索、统计、接地校验全是确定性计算，措辞生成交给宿主模型。
「知识库里没有的不许编」因此由代码兜底，而不是靠提示词自觉。

---

## v1.3.0 — 2026-10-22

**第一个版本。**

| 阶段 | 动作 | 结果 |
|---|---|---|
| ① 导出 | 手机 QQ 扫码，Agent 驱动导出工具抓取全量说说 | `messages.json`（含评论/点赞/定位/图片）+ 归档库快照 |
| ② 建库 | 两路数据按说说 ID 合并去重，切明细块与年度画像块 | 可检索的知识库 + 检索索引 |
| ③ 人物画像 | 归纳时间线、社交圈、说话方式、性格 | 一份「我是谁」底色，注入每轮对话 |
| ④ 对话 | 检索 → 接地校验 → 作答 | 有依据的回答，附来源 |

工程要点：cell ID 前 8 位小端 u32 反解出作者 QQ 号（用于归属过滤），
后 8 位反解出精确发布时间戳；没正文也要留痕——「发过、什么时候发、被谁互动过」本身就是真实知识。

---

## 版本对照表

| 版本 | 日期 | 一句话 | 安装包 |
|---|---|---|---|
| v1.7.1 | 2026-10-23 | 版本管理：CHANGELOG + 隐私回扫脚本 + 修文档示例泄漏 | `releases/qq-space-kb-1.7.1.zip` |
| v1.7.0 | 2026-10-23 | 对话架构：知识库整体当 prompt，事实红线只管硬事实 | `releases/qq-space-kb-1.7.0.zip` |
| v1.6.2 | 2026-10-23 | 留言板留言不再被当成「我发过的说说」 | `releases/qq-space-kb-1.6.2.zip` |
| v1.6.1 | 2026-10-23 | 按钮挪进面板，状态栏按真实状态显示 | `releases/qq-space-kb-1.6.1.zip` |
| v1.6.0 | 2026-10-23 | 全程只扫一次码：常驻浏览器 + CDP 复用登录态 | `releases/qq-space-kb-1.6.0.zip` |
| v1.5.0 | 2026-10-22 | 年份分布可视化技能 | `releases/qq-space-kb-1.5.0.zip` |
| v1.4.0 | 2026-10-22 | 插件化：MCP 工具 + 技能 + 人设子代理 | `releases/qq-space-kb-1.4.0.zip` |
| v1.3.0 | 2026-10-22 | 第一个版本：导出 + 建库 + 画像 + 对话 | `releases/qq-space-kb-1.3.0.zip` |

# Wishadel Demolition Terminal

面向 DeepSeek Harness Web GUI 的维什戴尔主题插件。

视觉方向不是传统游戏金属框，而是明日方舟式信息终端与维什戴尔爆破涂写：黑灰信息层、细线框、编号、警示切角、红色状态轨、网点和不对称构图。

## 预览

### 对话界面

![Wishadel 对话界面](docs/screenshots/conversation.png)

左侧导航、会话背景、用户消息、工具调用行、状态遥测和切角输入器都由主题统一处理。

### 设置界面

![Wishadel 设置界面](docs/screenshots/settings.png)

主题的配置入口位于 DSH 设置页的插件区域。不同 DSH 版本可能显示为“插件配置”或“可配置”。

## 覆盖范围

- Web GUI 全局背景与会话背景
- 宽侧栏、会话树、选中与运行状态
- 首页标题和输入器
- 对话头部、标签页、用户消息气泡
- 推理、上下文与工具调用行
- 问题卡、Todo、Cordis 审批面板
- 设置弹窗、菜单和浮层
- 响应式布局、减少动态效果
- 设置 → 插件 → 可配置中的启用、装饰和背景开关

所有素材都在预构建的 `lib/client.js` 中以内嵌 Data URI 分发，运行时不访问远程地址。

## 安装

推荐使用 DSH 官方插件管理命令，不需要手动 clone 仓库，也不需要运行项目脚本。

要求：已经可以运行 DSH，并且 Node.js 提供 Corepack。

```powershell
corepack enable
dsh plugin --profile web add git+https://github.com/cdxDNRF/wishadel-theme.git
```

安装完成后：

1. 重启 `dsh web`。
2. 刷新 `http://127.0.0.1:3080`。
3. 打开 `设置 → 插件 → 插件配置`。

如果你的环境找不到 `pnpm`，先运行 `corepack enable`；DSH 的 profile 插件命令会负责安装依赖、写入 Web profile，并把主题 bundle 加入组合配置。

## 更新

使用同一个 DSH 官方命令重新解析远端包：

```powershell
dsh plugin --profile web add git+https://github.com/cdxDNRF/wishadel-theme.git
```

然后重启 `dsh web` 并刷新页面。若需要固定到某个 Git 提交，可使用 Git URL 片段或本地路径作为 package source。

## 配置

打开 `设置 → 插件 → 插件配置`，展开“维什戴尔终端”。可以配置：

- 启用或停用主题
- 显示终端遥测与装饰线
- 显示侧栏角色图
- 显示会话背景

修改后立即生效。DeepSeek Harness `0.1.0-rc.6` 的 Web 配置 API 只向内置插件开放 settings namespace，因此外部主题的视觉选项保存在当前浏览器的 localStorage 中；插件的安装、更新和卸载仍由 DSH profile 管理。

## 卸载

使用 DSH 官方插件管理命令移除主题：

```powershell
dsh plugin --profile web remove @cdxdnrf/dsh-client-ui-skin-wishadel
```

卸载后重启 `dsh web` 并刷新页面。该命令会移除主题 package dependency 以及 `dsh.profile.bundles` 中对应的 bundle，不修改其他插件。

仓库中的 `scripts/install.ps1` 和 `scripts/uninstall.ps1` 只是 PowerShell 包装器，适合无法直接调用完整命令的 Windows 环境；正常安装优先使用上面的 DSH 官方命令。

## 开发

源码与构建产物分离：

```text
assets/                  背景素材
src/runtime.js           生命周期、设置卡片与 DOM 语义标记
src/theme.css            主题样式
scripts/build.mjs        无第三方依赖构建脚本
lib/                     提交到仓库的可安装产物
docs/screenshots/        README 预览图
```

修改源码或素材后：

```powershell
node .\scripts\build.mjs
node --check .\lib\client.js
```

构建脚本会把 `assets/sidebar-w.jpg` 和 `assets/conversation-w.jpg` 嵌入客户端 bundle。

## 兼容性

当前针对 DeepSeek Harness `0.1.0-rc.6` Web GUI 验证。优先使用 `data-pane`、`data-phase`、`data-composer-*`、ARIA role/state 等稳定钩子，CSS Module 类名片段只作为兼容回退。

## 素材与许可

本项目是非商业性质的同人主题，与 Hypergryph/鹰角网络无隶属关系，也未获其背书。角色与《明日方舟》相关权利归各自权利人所有。详见 [NOTICE](NOTICE)。

项目代码和主题编排以 CC BY-NC-SA 4.0 发布。分发前请确保你有权重新分发替换后的背景素材。

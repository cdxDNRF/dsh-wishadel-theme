# DSH-better-sidebar 评估与 Wishadel 集成报告

日期：2026-08-17

## 结论

`omdsh-dev/DSH-better-sidebar`（审计 revision `6ee1ba11d0ba35ac8ba4fa6d7fddbf612cb127ed`，manifest `0.12.3`）不是一个主题皮肤，而是一套完整的双工作台：右侧栏、底部面板、文件资源管理器/编辑器、Git、终端、浏览器、子代理与后台任务、Host 路由、WebSocket、设置和第三方扩展服务。

因此没有把它直接安装或复制进 `wishadel-theme`。当前 DSH rc.6 已经提供大部分侧栏基础能力，直接叠加会产生第二套面板、重复 Git/文件功能、额外 Host 路由与依赖冲突。Wishadel 采用“借鉴交互，自主实现”的薄集成策略。

## 上游能力摘要

- 侧栏基础：工作区/未分组/平铺模式、标题和内容搜索、手动/最近更新排序、拖动排序、归档、重命名、分叉、折叠 rail。
- 完整工作台：右侧栏 + 底部面板、分栏和 Tab 拖动、按会话持久化布局。
- 文件：懒加载目录树、路径搜索、软链接/UNC 支持、CodeMirror 编辑、Markdown/HTML/图片/PDF/代码/二进制查看器、下载和文件引用。
- Git：状态、暂存/取消暂存、提交、分支、历史、diff、还原、revert、cherry-pick；没有内置 push/pull/fetch。
- 终端：xterm.js + node-pty、断线回放、shell 配置、可选模型终端工具。
- 浏览器：多 Tab、前进后退、iframe 沙箱、CSP/XFO 探测、外链拦截。
- 后台能力：子代理拓扑、后台任务输出回放、终止和自动打开。
- 扩展服务：客户端 `ctx.betterSidebar`，支持 `registerTab`、`registerFileViewer`、生命周期 disposer、状态订阅、`openFile`、Tab 元数据和设置。

## 关键风险

1. 当前 `main` 比 `v0.12.3` tag 多 3 个提交，包含尚未完全对应 published tag 的统一 Editor/Explorer 改动；不能隐式追踪 `latest/main`，应固定 tag 或 SHA。
2. 依赖 CodeMirror、xterm、node-pty、WebSocket 和大量 DSH pre-release peer，安装和升级成本明显高于 Wishadel 当前实现。
3. 上游自身大量依赖 DSH DOM/slot 结构，历史上修过 `[data-slot]`、零尺寸 xterm、trustedHosts、UNC/软链接、node-pty、主题透明度等回归。
4. 上游明确要求主题只使用 `[data-dsh-better-sidebar]` 根和 DSH tokens，不要依赖 CSS Module hash。
5. MIT 允许使用、修改、分发，但复制大量代码/CSS 时必须保留 copyright 和 license notice。

## 与当前 Wishadel 的比较

DSH 原生已经有：搜索、工作区/平铺分组、排序、拖动排序、工作区管理、归档/重命名/分叉、状态与相对时间、折叠 rail。Wishadel 现有的主要侧栏增强是：主题视觉、任务看板、Git/文件面板、会话置顶、文件审查标签和滚动条。

Wishadel 的置顶目前只能通过 DOM 注入实现，因为 rc.6 没有会话行、行操作或菜单扩展槽，宿主行也没有稳定 session id。长期正确方案应由 DSH 增加：

- `data-session-id` / `data-workspace-id`；
- `sidebar.session.row.action`、`sidebar.workspace.row.action`；
- session/workspace menu contribution slots；
- 官方持久化 pin store；
- tree roving focus 键盘协议。

## 本轮实际集成

### 1. 侧栏键盘导航

新增 `src/client/sidebar-nav.js`：

- 为 `role=treeitem` 建立 roving `tabindex`；
- `ArrowUp/ArrowDown` 移动可见会话/工作区行；
- `Home/End` 跳首尾；
- `Enter/Space` 激活当前行；
- `ArrowLeft/ArrowRight` 折叠/展开工作区或回到上级工作区；
- 输入框、按钮、菜单、contenteditable 内不拦截快捷键；
- MutationObserver 自愈宿主列表重渲染；卸载时清理 tabindex 和监听器。

### 2. 任务看板窄栏适配

`TaskBoardTrigger` 现在消费官方 `sidebar.footer.action` 的 `wide` props：

- 宽侧栏显示完整“任务看板”入口；
- 窄栏只显示 `▦` 图标，保留 aria-label/title；
- 新增窄栏尺寸和图标样式，避免 56px rail 被完整文字卡片挤坏。

## 验证

- `node scripts/smoke-client.mjs`：通过。
- `node scripts/smoke-host.mjs`：通过。
- Playwright：侧栏初始产生一个 roving tabindex；ArrowDown、Home、End 均能移动焦点；页面零错误。
- 主题构建产物已经由 `scripts/build.mjs` 重建。

## 后续建议

- 不直接引入 `dsh-better-sidebar`，避免第二套工作台和依赖/挂载冲突。
- 如果未来要替换 rc.6 的 WorkspaceBrowser，应只替换 `sidebar.workspaces`，同时保留 `wide`、`useSessions`、`useWorkspaces`、`directoryFlow`、搜索边界、归档/空会话/子代理可见性和官方持久化排序。
- 最值得推动到 DSH 上游的是官方 pin model、稳定行 id、行/菜单 extension slots 和完整键盘树导航。
- 上游代码如需复制，保留 MIT 许可；当前 Wishadel 集成没有复制上游源代码。

## 来源

- [上游 README](https://github.com/omdsh-dev/DSH-better-sidebar/blob/main/README.md)
- [上游 English README](https://github.com/omdsh-dev/DSH-better-sidebar/blob/main/README_EN.md)
- [上游 AGENTS.md 接入契约](https://github.com/omdsh-dev/DSH-better-sidebar/blob/main/AGENTS.md)
- [上游 package.json](https://github.com/omdsh-dev/DSH-better-sidebar/blob/main/package.json)
- [上游客户端服务](https://github.com/omdsh-dev/DSH-better-sidebar/blob/main/src/client/service.ts)
- [上游客户端状态](https://github.com/omdsh-dev/DSH-better-sidebar/blob/main/src/client/state.ts)
- [上游客户端入口](https://github.com/omdsh-dev/DSH-better-sidebar/blob/main/src/client/index.tsx)
- [上游 Sidebar](https://github.com/omdsh-dev/DSH-better-sidebar/blob/main/src/client/Sidebar.tsx)
- [上游文件树](https://github.com/omdsh-dev/DSH-better-sidebar/blob/main/src/client/FileTree.tsx)
- [上游 GitView](https://github.com/omdsh-dev/DSH-better-sidebar/blob/main/src/client/GitView.tsx)
- [上游 MIT License](https://github.com/omdsh-dev/DSH-better-sidebar/blob/main/LICENSE)
- [上游 Releases](https://github.com/omdsh-dev/DSH-better-sidebar/releases)
- [上游 Issue #42](https://github.com/omdsh-dev/DSH-better-sidebar/issues/42)
- [上游 Issue #55](https://github.com/omdsh-dev/DSH-better-sidebar/issues/55)
- [上游 Issue #60](https://github.com/omdsh-dev/DSH-better-sidebar/issues/60)
- [上游 PR #27](https://github.com/omdsh-dev/DSH-better-sidebar/pull/27/files)
- [上游 PR #110](https://github.com/omdsh-dev/DSH-better-sidebar/pull/110)
- [上游 PR #151](https://github.com/omdsh-dev/DSH-better-sidebar/pull/151)

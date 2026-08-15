const SKIN_OWNER = "wishadel-terminal";
const BODY_ATTR = "data-dsh-wishadel";
const THEME_TITLE = "WIS'ADEL // DeepSeek Harness";
const OWNED_STYLE = "dsh-theme-wishadel/theme.css";
const STORAGE_KEY = "dsh-theme-wishadel-config";
const DEFAULTS = { enabled: true, showChrome: true, showSidebarArt: true, showConversationArt: true };

function readConfig() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") }; }
  catch { return { ...DEFAULTS }; }
}
function writeConfig(config) { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); }
function createChrome(kind, text) {
  const node = document.createElement("div");
  node.dataset.wishadelChrome = kind;
  node.dataset.skinOwner = SKIN_OWNER;
  node.setAttribute("aria-hidden", "true");
  if (text) node.textContent = text;
  return node;
}
function markSurfaces(decorated) {
  const sidebar = document.querySelector("[data-pane='sidebar'], [class*='_sidebarCol']");
  const conversation = document.querySelector("[data-pane='conversation'], [class*='_centerCol']");
  const details = document.querySelector("[data-pane='details'], [class*='_detailsCol']");
  if (sidebar) { sidebar.dataset.wishadelPane = "sidebar"; decorated.add(sidebar); }
  if (conversation) { conversation.dataset.wishadelPane = "conversation"; decorated.add(conversation); }
  if (details) { details.dataset.wishadelPane = "details"; decorated.add(details); }
  document.querySelectorAll("[role='treeitem'][aria-selected='true']").forEach((row) => { row.dataset.wishadelActive = ""; decorated.add(row); });
  document.querySelectorAll("[data-state='running'], [data-cordis-awaiting]").forEach((node) => { node.dataset.wishadelLive = ""; decorated.add(node); });
}
function clearDecorations(decorated) {
  decorated.forEach((node) => { delete node.dataset.wishadelPane; delete node.dataset.wishadelActive; delete node.dataset.wishadelLive; });
  decorated.clear();
}
function ThemeSettingsCard({ useWishadelSettings, setField }) {
  const config = useWishadelSettings((snapshot) => snapshot);
  const rows = [
    ["enabled", "启用维什戴尔主题", "关闭后保留插件安装，仅恢复 DSH 默认界面。"],
    ["showChrome", "显示终端装饰", "显示右侧遥测文字、编号和斜向状态线。"],
    ["showSidebarArt", "显示侧栏角色图", "保留导航结构，同时控制左侧角色背景。"],
    ["showConversationArt", "显示会话背景", "控制会话区域的角色群像背景。"],
  ];
  return React.createElement("li", { className: "wishadel-settings-card" },
    React.createElement("div", { className: "wishadel-settings-head" },
      React.createElement("strong", null, "维什戴尔终端"),
      React.createElement("span", null, "WIS'ADEL DEMOLITION TERMINAL")),
    React.createElement("div", { className: "wishadel-settings-fields" }, rows.map(([key, label, hint]) =>
      React.createElement("label", { className: "wishadel-settings-field", key },
        React.createElement("span", { className: "wishadel-settings-copy" },
          React.createElement("strong", null, label), React.createElement("small", null, hint)),
        React.createElement("input", { type: "checkbox", checked: Boolean(config.value[key]), onChange: (event) => setField(key, event.target.checked) })))));
}
function apply(ctx) {
  const body = document.body;
  const originalTitle = document.title;
  const chrome = new Set();
  const decorated = new Set();
  const listeners = new Set();
  let observer;
  let config = readConfig();
  const style = document.createElement("style");
  style.dataset.plugin = "dsh-theme-wishadel";
  style.dataset.pluginCss = OWNED_STYLE;
  style.textContent = WISHADEL_CSS;
  document.head.append(style);
  function removeChrome() { chrome.forEach((node) => node.remove()); chrome.clear(); }
  function renderChrome() {
    removeChrome();
    if (!config.enabled || !config.showChrome) return;
    const nodes = [createChrome("telemetry", "W // 03   DEMOLITION LINK"), createChrome("index", "03"), createChrome("slash")];
    nodes.forEach((node) => chrome.add(node));
    body.append(...nodes);
  }
  function applyConfig() {
    body.toggleAttribute(BODY_ATTR, config.enabled);
    body.toggleAttribute("data-wishadel-chrome-enabled", config.enabled && config.showChrome);
    body.toggleAttribute("data-wishadel-sidebar-art", config.enabled && config.showSidebarArt);
    body.toggleAttribute("data-wishadel-conversation-art", config.enabled && config.showConversationArt);
    if (config.enabled) {
      document.title = THEME_TITLE;
      for (const [name, value] of Object.entries(WISHADEL_ASSETS)) body.style.setProperty(`--wishadel-art-${name}`, `url("${value}")`);
      clearDecorations(decorated); markSurfaces(decorated);
    } else {
      clearDecorations(decorated);
      for (const name of Object.keys(WISHADEL_ASSETS)) body.style.removeProperty(`--wishadel-art-${name}`);
      if (document.title === THEME_TITLE) document.title = originalTitle;
    }
    renderChrome();
  }
  const store = {
    getSnapshot: () => config,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    set(field, value) {
      config = { ...config, [field]: value };
      writeConfig(config);
      applyConfig();
      listeners.forEach((listener) => listener());
    },
  };
  const slots = ctx.get("slots");
  if (slots !== undefined) slots.inject("settings.plugin.item", () => slots.register({
    name: "settings.plugin.item", id: "wishadel-theme", order: 30, label: "维什戴尔终端", inject: () => ({
      hooks: { wishadelSettings: { getSnapshot: () => ({ status: "ready", writable: true, value: config }), subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } } },
      setField: (field, value) => store.set(field, value),
    }),
  }, ThemeSettingsCard));
  applyConfig();
  observer = new MutationObserver(() => { if (config.enabled) { clearDecorations(decorated); markSurfaces(decorated); } });
  observer.observe(body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-selected", "data-state", "data-cordis-awaiting"] });
  ctx.effect(() => () => {
    observer?.disconnect(); clearDecorations(decorated); removeChrome(); style.remove();
    body.removeAttribute(BODY_ATTR); body.removeAttribute("data-wishadel-chrome-enabled"); body.removeAttribute("data-wishadel-sidebar-art"); body.removeAttribute("data-wishadel-conversation-art");
    for (const name of Object.keys(WISHADEL_ASSETS)) body.style.removeProperty(`--wishadel-art-${name}`);
    if (document.title === THEME_TITLE) document.title = originalTitle;
  });
}
module.exports.apply = apply;
module.exports.inject = [];

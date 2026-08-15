const SKIN_OWNER = "wishadel-terminal";
const BODY_ATTR = "data-dsh-wishadel";
const STORAGE_KEY = "dsh-theme-wishadel-enabled";
const THEME_TITLE = "WIS'ADEL // DeepSeek Harness";
const OWNED_STYLE = "dsh-theme-wishadel/theme.css";

function createToggle(enabled) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.wishadelToggle = "";
  button.dataset.skinOwner = SKIN_OWNER;
  button.textContent = "W";
  button.title = enabled
    ? "维什戴尔主题：已启用（点击停用）"
    : "维什戴尔主题：已停用（点击启用）";
  button.setAttribute("aria-label", button.title);
  button.setAttribute("aria-pressed", String(enabled));
  return button;
}

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

  if (sidebar) {
    sidebar.dataset.wishadelPane = "sidebar";
    decorated.add(sidebar);
  }
  if (conversation) {
    conversation.dataset.wishadelPane = "conversation";
    decorated.add(conversation);
  }
  if (details) {
    details.dataset.wishadelPane = "details";
    decorated.add(details);
  }

  document.querySelectorAll("[role='treeitem'][aria-selected='true']").forEach((row) => {
    row.dataset.wishadelActive = "";
    decorated.add(row);
  });
  document.querySelectorAll("[data-state='running'], [data-cordis-awaiting]").forEach((node) => {
    node.dataset.wishadelLive = "";
    decorated.add(node);
  });
}

function clearDecorations(decorated) {
  decorated.forEach((node) => {
    delete node.dataset.wishadelPane;
    delete node.dataset.wishadelActive;
    delete node.dataset.wishadelLive;
  });
  decorated.clear();
}

function apply(ctx) {
  const body = document.body;
  const originalTitle = document.title;
  const enabled = localStorage.getItem(STORAGE_KEY) !== "false";
  const owned = new Set();
  const decorated = new Set();
  let observer;

  const toggle = createToggle(enabled);
  owned.add(toggle);
  body.append(toggle);
  toggle.addEventListener("click", () => {
    localStorage.setItem(STORAGE_KEY, String(!enabled));
    location.reload();
  });

  ctx.effect(() => () => {
    observer?.disconnect();
    clearDecorations(decorated);
    owned.forEach((node) => node.remove());
    body.removeAttribute(BODY_ATTR);
    for (const name of Object.keys(WISHADEL_ASSETS)) {
      body.style.removeProperty(`--wishadel-art-${name}`);
    }
    if (document.title === THEME_TITLE) document.title = originalTitle;
  });

  if (!enabled) return;

  body.setAttribute(BODY_ATTR, "");
  document.title = THEME_TITLE;
  for (const [name, value] of Object.entries(WISHADEL_ASSETS)) {
    body.style.setProperty(`--wishadel-art-${name}`, `url("${value}")`);
  }

  const style = document.createElement("style");
  style.dataset.plugin = "dsh-theme-wishadel";
  style.dataset.pluginCss = OWNED_STYLE;
  style.textContent = WISHADEL_CSS;
  owned.add(style);
  document.head.append(style);

  const telemetry = createChrome("telemetry", "W // 03   DEMOLITION LINK");
  const index = createChrome("index", "03");
  const slash = createChrome("slash");
  owned.add(telemetry);
  owned.add(index);
  owned.add(slash);
  body.append(telemetry, index, slash);

  markSurfaces(decorated);
  observer = new MutationObserver(() => {
    clearDecorations(decorated);
    markSurfaces(decorated);
  });
  observer.observe(body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-selected", "data-state", "data-cordis-awaiting"],
  });
}

module.exports.apply = apply;
module.exports.inject = [];

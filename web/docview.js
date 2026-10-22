// 站内「教程」弹层。
//
// 为什么用 iframe 而不是把教程内容塞进页面：
//   教程是一份完整的独立文档（自带排版、锚点、打印样式），塞进 SPA 会跟现有的
//   牌桌 CSS 打架。iframe 是隔离成本最低的做法，而且文档改版不用动前端。
//
// 用法：页面里放一个 #btn-tutorial 和 #doc-overlay（见 online.html / index.html）。
// 首次点击才把 src 指到 tutorial.html —— 不点就不加载。
(function () {
  const btn = document.getElementById("btn-tutorial");
  const overlay = document.getElementById("doc-overlay");
  const frame = document.getElementById("doc-frame");
  const close = document.getElementById("doc-close");
  if (!btn || !overlay || !frame) return;

  let loaded = false;

  function open() {
    if (!loaded) {
      frame.src = "./tutorial.html";
      loaded = true;
    }
    overlay.classList.add("on");
    overlay.setAttribute("aria-hidden", "false");
    if (close) close.focus();
  }

  function shut() {
    overlay.classList.remove("on");
    overlay.setAttribute("aria-hidden", "true");
    btn.focus();
  }

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    open();
  });
  if (close) close.addEventListener("click", shut);
  // 点遮罩空白处关闭（点在 shell 内部不关）
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) shut();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.classList.contains("on")) shut();
  });

  // 教程里如果有锚点跳转，iframe 内部自己处理，不影响外面
  window.__XD_TUTORIAL__ = { open, close: shut };
})();

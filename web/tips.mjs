// 牌面详情：桌面鼠标悬浮、手机长按，都能看到牌写了什么。
//
// 用法：任何元素只要带 data-tip="<牌 id | set:xxx | base:xxx>" 就自动获得提示；
//      带 data-modal="<牌 id>" 的元素，点击会打开大卡弹窗。
// 这两件事都走事件委托，渲染层只管加属性，不用自己绑事件。
import { cardInfo } from "./render.mjs";

const HOVER_DELAY = 160;
const LONG_PRESS = 420;

let tipEl = null;
let showTimer = null;
let pressTimer = null;
let pressMoved = false;
let suppressClick = false;

function ensureEl() {
  if (tipEl) return tipEl;
  tipEl = document.createElement("div");
  tipEl.className = "tip";
  document.body.appendChild(tipEl);
  return tipEl;
}

function html(info) {
  const tags = (info.tags || []).filter(Boolean)
    .map((t) => `<span class="tip-tag">${t}</span>`).join("");
  const rows = (info.rows || [])
    .map(([k, v]) => `<div class="tip-row"><span>${k}</span><b>${v}</b></div>`).join("");
  const stat = info.stat
    ? `<div class="tip-stat"><b>${info.stat.value}</b><span>${info.stat.label}</span></div>`
    : "";
  return `
    <div class="tip-hd tone-${info.tone || "shu"}">
      <div class="tip-t">${info.title}</div>
      <div class="tip-s">${info.sub || ""}</div>
    </div>
    ${stat}
    ${tags ? `<div class="tip-tags">${tags}</div>` : ""}
    ${rows ? `<div class="tip-rows">${rows}</div>` : ""}`;
}

function place(el, x, y) {
  const pad = 12;
  const r = el.getBoundingClientRect();
  let left = x + 14;
  let top = y + 14;
  if (left + r.width > innerWidth - pad) left = Math.max(pad, x - r.width - 14);
  if (top + r.height > innerHeight - pad) top = Math.max(pad, y - r.height - 14);
  el.style.left = left + "px";
  el.style.top = top + "px";
}

export function showTip(raw, x, y) {
  const info = cardInfo(raw);
  const el = ensureEl();
  el.innerHTML = html(info);
  el.classList.add("on");
  place(el, x ?? innerWidth / 2, y ?? innerHeight / 2);
  return el;
}

export function hideTip() {
  clearTimeout(showTimer);
  if (tipEl) tipEl.classList.remove("on");
}

// 大卡弹窗（点击"查看详情"用）
export function openCard(raw) {
  const info = cardInfo(raw);
  const modal = document.getElementById("modal");
  const overlay = document.getElementById("overlay");
  if (!modal || !overlay) return;
  const tags = (info.tags || []).filter(Boolean)
    .map((t) => `<span class="tip-tag">${t}</span>`).join("");
  const rows = (info.rows || [])
    .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("");
  modal.innerHTML = `
    <div class="card-detail tone-${info.tone || "shu"}">
      <h3>${info.title}</h3>
      <div class="cd-sub">${info.sub || ""}</div>
      ${info.stat ? `<div class="cd-stat"><b>${info.stat.value}</b><span>${info.stat.label}</span></div>` : ""}
      ${tags ? `<div class="tip-tags">${tags}</div>` : ""}
      <table class="cd-table">${rows}</table>
    </div>
    <div class="acts"><button class="btn primary" data-close>知道了</button></div>`;
  overlay.classList.add("on");
  overlay.dataset.closable = "1";
  modal.querySelector("[data-close]").onclick = () => overlay.classList.remove("on");
}

// ---------- 事件委托 ----------

export function initTips() {
  // 桌面：悬浮
  document.addEventListener("mouseover", (e) => {
    const t = e.target.closest?.("[data-tip]");
    if (!t) return;
    clearTimeout(showTimer);
    showTimer = setTimeout(() => {
      const raw = t.dataset.tip;
      if (raw) showTip(raw, e.clientX, e.clientY);
    }, HOVER_DELAY);
  });
  document.addEventListener("mousemove", (e) => {
    if (!tipEl || !tipEl.classList.contains("on")) return;
    place(tipEl, e.clientX, e.clientY);
  });
  document.addEventListener("mouseout", (e) => {
    if (e.target.closest?.("[data-tip]")) hideTip();
  });

  // 手机：长按
  document.addEventListener("touchstart", (e) => {
    const t = e.target.closest?.("[data-tip]");
    if (!t) return;
    pressMoved = false;
    const touch = e.touches[0];
    pressTimer = setTimeout(() => {
      pressTimer = null;
      suppressClick = true;                 // 长按查看详情，不要顺手把牌选了
      showTip(t.dataset.tip, touch.clientX, touch.clientY);
      if (navigator.vibrate) navigator.vibrate(12);
    }, LONG_PRESS);
  }, { passive: true });

  document.addEventListener("touchmove", () => {
    pressMoved = true;
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
  }, { passive: true });

  const endPress = () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    if (!pressMoved && tipEl?.classList.contains("on")) {
      setTimeout(hideTip, 1600);
    }
    setTimeout(() => { suppressClick = false; }, 60);
  };
  document.addEventListener("touchend", endPress, { passive: true });
  document.addEventListener("touchcancel", endPress, { passive: true });

  // 点击其他地方收起提示
  document.addEventListener("click", (e) => {
    const modal = e.target.closest?.("[data-modal]");
    if (modal) { e.preventDefault(); openCard(modal.dataset.modal); return; }
    // 长按已经把这张牌的详情弹出来了，这次抬手不该顺手把它选中
    if (suppressClick) { suppressClick = false; e.preventDefault(); e.stopPropagation(); return; }
    if (e.target.closest?.("[data-tip]")) return;
    hideTip();
  }, true);

  window.addEventListener("scroll", hideTip, true);
}

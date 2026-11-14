// Effects: the registry behind the Effects tab and the overlay that shows one effect's menu.
// The tab lists the effects; choosing one opens its menu over the right column (Activity + tabs),
// closed with the ✕ in its top-right corner. New effects register here with a lazy module whose
// `mount(container, ctx)` returns `{ destroy() }`.

/** @type {Array<{id: string, label: string, hint: string, load: () => Promise<any>}>} */
export const EFFECTS = [
  { id: "color", label: "Color", hint: "Grade, scopes, before/after", load: () => import("./color_panel.js") },
];

let open = null;

/** Opens an effect's menu over the right column (replacing any open one). */
export async function openEffect(id, ctx) {
  const fx = EFFECTS.find((e) => e.id === id);
  const host = document.getElementById("rightcol");
  if (!fx || !host) return;
  closeEffect();
  const el = document.createElement("section");
  el.className = "panel fx-overlay";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", `${fx.label} effect`);
  el.innerHTML = `
    <header class="fx-head">
      <span class="fx-title">${fx.label}</span>
      <span class="fx-item dim mono"></span>
      <button class="fx-close" type="button" title="Close (Esc)" aria-label="Close">✕</button>
    </header>
    <div class="fx-body"></div>`;
  host.appendChild(el);
  const body = el.querySelector(".fx-body");
  const itemLabel = el.querySelector(".fx-item");
  const mod = await fx.load();
  const inst = mod.mount(body, ctx, (id) => { itemLabel.textContent = id ?? ""; });
  open = { id, el, inst };
  el.querySelector(".fx-close").addEventListener("click", closeEffect);
}

export function closeEffect() {
  if (!open) return;
  try { open.inst?.destroy?.(); } catch (e) { console.error("[effects] close", e); }
  open.el.remove();
  open = null;
}

export function openEffectId() {
  return open?.id ?? null;
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && open && !(e.target instanceof HTMLInputElement)) closeEffect();
});

/** Effects tab body: the effects as a plain list; clicking one opens its menu over the right column. */
export function mountEffectsTab(pane, ctx) {
  pane.innerHTML = `
    <ul class="fx-list" role="list">
      ${EFFECTS.map((e) => `<li><button type="button" class="fx-item-btn" data-fx="${e.id}"><span class="fx-name">${e.label}</span><span class="fx-hint dim">${e.hint}</span></button></li>`).join("")}
    </ul>`;
  for (const b of pane.querySelectorAll("[data-fx]")) b.addEventListener("click", () => openEffect(b.dataset.fx, ctx));
}

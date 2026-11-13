// Tabbed panel: Clip Info | Notes. Mounts the existing inspector and notes
// modules into the panes; owns only the tab bar and the active tab.
/** @param {HTMLElement|null} root  @param {import('./app.js').LiveContext} ctx */
export async function mount(root, ctx) {
  if (!root) return;
  root.innerHTML = `
    <div class="kt-tabs" role="tablist" aria-label="Details">
      <button class="kt-tab" role="tab" data-tab="clip" aria-selected="true" type="button">Clip Info</button>
      <button class="kt-tab" role="tab" data-tab="notes" aria-selected="false" type="button">Notes</button>
    </div>
    <div class="kt-panes">
      <div class="kt-pane" data-pane="clip" role="tabpanel"></div>
      <div class="kt-pane" data-pane="notes" role="tabpanel" hidden></div>
    </div>`;
  const panes = {
    clip: root.querySelector('[data-pane="clip"]'),
    notes: root.querySelector('[data-pane="notes"]'),
  };
  const tabs = [...root.querySelectorAll(".kt-tab")];
  const select = (name) => {
    for (const t of tabs) t.setAttribute("aria-selected", String(t.dataset.tab === name));
    for (const [k, pane] of Object.entries(panes)) pane.hidden = k !== name;
  };
  for (const t of tabs) t.addEventListener("click", () => select(t.dataset.tab));
  const [inspector, notes] = await Promise.all([import("./inspector.js"), import("./notes.js")]);
  inspector.mount(panes.clip, ctx);
  notes.mount(panes.notes, ctx);
  // Opening the Notes tab opens the note box (same as N).
  root.querySelector('[data-tab="notes"]').addEventListener("click", () => {
    if (!ctx.store.state.annotate) ctx.store.set({ annotate: true });
  });
}

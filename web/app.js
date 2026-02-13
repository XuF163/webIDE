(function () {
  const app = document.getElementById("app");
  const tabs = Array.from(document.querySelectorAll(".tab"));
  const divider = document.getElementById("divider");
  const desktop = document.getElementById("desktop");

  const STORAGE_MODE = "hfide.mode";
  const STORAGE_SPLIT = "hfide.split";

  function setMode(mode) {
    app.dataset.mode = mode;
    for (const tab of tabs) {
      const selected = tab.dataset.mode === mode;
      tab.setAttribute("aria-selected", selected ? "true" : "false");
    }
    localStorage.setItem(STORAGE_MODE, mode);
  }

  function setSplitRatio(ratio) {
    const clamped = Math.max(0.15, Math.min(0.85, ratio));
    const pct = `${Math.round(clamped * 1000) / 10}%`;
    document.documentElement.style.setProperty("--split", pct);
    localStorage.setItem(STORAGE_SPLIT, String(clamped));
  }

  // Default: single (vscode). Allow last-used restore.
  const savedMode = localStorage.getItem(STORAGE_MODE);
  setMode(savedMode || "vscode");

  const savedSplit = parseFloat(localStorage.getItem(STORAGE_SPLIT) || "0.6");
  if (!Number.isNaN(savedSplit)) setSplitRatio(savedSplit);

  tabs.forEach((btn) => {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  });

  window.addEventListener("keydown", (e) => {
    if (!e.ctrlKey) return;
    if (e.key === "1") setMode("vscode");
    if (e.key === "2") setMode("terminal");
    if (e.key === "3") setMode("split");
  });

  // Divider drag (split mode)
  let dragging = false;
  divider.addEventListener("pointerdown", (e) => {
    dragging = true;
    divider.setPointerCapture(e.pointerId);
  });

  divider.addEventListener("pointerup", () => {
    dragging = false;
  });
  divider.addEventListener("pointercancel", () => {
    dragging = false;
  });

  divider.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const rect = desktop.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    setSplitRatio(ratio);
  });
})();

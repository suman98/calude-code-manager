import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// Apply the saved palette before the first paint, or a light-mode user gets a
// dark flash on every launch.
try {
  const saved = localStorage.getItem("theme");
  document.documentElement.dataset.theme = saved ? JSON.parse(saved) : "dark";
} catch {
  document.documentElement.dataset.theme = "dark";
}

// Native-app chrome: the WKWebView context menu ("Reload", "Services") is not
// something a desktop app shows. Text fields keep theirs for cut/copy/paste.
window.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement | null;
  if (t?.closest("input, textarea, [contenteditable='true'], .selectable")) return;
  e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

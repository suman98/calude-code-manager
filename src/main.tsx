import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

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

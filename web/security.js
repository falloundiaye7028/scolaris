(function exposeSecurity(global) {
  "use strict";
  const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => entities[character]);
  }
  global.ScolarisSecurity = Object.freeze({ escapeHtml });
})(window);

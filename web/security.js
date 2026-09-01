(function exposeSecurity(global) {
  "use strict";
  const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => entities[character]);
  }
  function createModalFocusController({ modal, getActiveElement, getFallback }) {
    let returnFocus = null;
    const activeElement = getActiveElement || (() => global.document?.activeElement);
    const isFocusable = (node) => {
      if (!node || typeof node.focus !== "function" || node.isConnected === false || node.disabled || node.hidden) return false;
      if (node.getAttribute?.("aria-hidden") === "true" || node.closest?.(".hidden")) return false;
      return typeof node.getClientRects !== "function" || node.getClientRects().length > 0;
    };
    function capture(trigger = activeElement()) {
      returnFocus = isFocusable(trigger) ? trigger : null;
    }
    function open(trigger = activeElement()) {
      capture(trigger);
      modal.classList.remove("hidden");
    }
    function close() {
      modal.classList.add("hidden");
      const target = isFocusable(returnFocus) ? returnFocus : getFallback?.();
      returnFocus = null;
      if (isFocusable(target)) target.focus({ preventScroll: false });
    }
    return Object.freeze({ capture, open, close });
  }
  global.ScolarisSecurity = Object.freeze({ escapeHtml, createModalFocusController });
})(window);

(function exposeSecurity(global) {
  "use strict";
  const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => entities[character]);
  }
  function createModalFocusController({ modal, getActiveElement, getFallback }) {
    let returnFocus = null;
    const activeElement = getActiveElement || (() => global.document?.activeElement);
    const focusableSelector = "button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex='-1'])";
    const isFocusable = (node) => {
      if (!node || typeof node.focus !== "function" || node.isConnected === false || node.disabled || node.hidden) return false;
      if (node.getAttribute?.("aria-hidden") === "true" || node.closest?.(".hidden")) return false;
      return typeof node.getClientRects !== "function" || node.getClientRects().length > 0;
    };
    function capture(trigger = activeElement()) {
      returnFocus = isFocusable(trigger) ? trigger : null;
    }
    function focusableNodes() {
      return Array.from(modal.querySelectorAll?.(focusableSelector) || []).filter(isFocusable);
    }
    function contain(event) {
      if (event.key !== "Tab" || modal.classList.contains("hidden")) return;
      const nodes = focusableNodes();
      if (!nodes.length) { event.preventDefault(); if (isFocusable(modal)) modal.focus(); return; }
      const current = activeElement(), index = nodes.indexOf(current);
      if (event.shiftKey && index <= 0) { event.preventDefault(); nodes.at(-1).focus(); }
      else if (!event.shiftKey && (index < 0 || index === nodes.length - 1)) { event.preventDefault(); nodes[0].focus(); }
    }
    function open(trigger = activeElement()) {
      capture(trigger);
      modal.classList.remove("hidden");
      const target = focusableNodes()[0] || modal;
      if (isFocusable(target)) target.focus();
    }
    function close() {
      modal.classList.add("hidden");
      const target = isFocusable(returnFocus) ? returnFocus : getFallback?.();
      returnFocus = null;
      if (isFocusable(target)) target.focus({ preventScroll: false });
    }
    modal.addEventListener?.("keydown", contain);
    return Object.freeze({ capture, open, close });
  }
  global.ScolarisSecurity = Object.freeze({ escapeHtml, createModalFocusController });
})(window);

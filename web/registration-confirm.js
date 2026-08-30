"use strict";
const confirmationStatus = document.getElementById("confirmationStatus");
const token = new URLSearchParams(window.location.hash.slice(1)).get("token") || "";
history.replaceState(null, "", window.location.pathname);

(async () => {
  try {
    if (!token) throw new Error("Lien de confirmation invalide ou expiré.");
    const response = await fetch("/api/public/school-registration/confirm", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ token }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Lien de confirmation invalide ou expiré.");
    confirmationStatus.className = "form-status success";
    confirmationStatus.textContent = data.message;
  } catch (error) {
    confirmationStatus.className = "form-status error";
    confirmationStatus.textContent = error instanceof Error ? error.message : "Confirmation impossible.";
  }
})();

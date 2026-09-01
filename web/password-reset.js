"use strict";
const requestSection = document.getElementById("requestSection");
const confirmSection = document.getElementById("confirmSection");
const requestForm = document.getElementById("requestForm");
const confirmForm = document.getElementById("confirmForm");
const resetStatus = document.getElementById("resetStatus");
const token = new URLSearchParams(window.location.hash.slice(1)).get("token") || "";
history.replaceState(null, "", window.location.pathname);

if (token) {
  requestSection.hidden = true;
  confirmSection.hidden = false;
}

function setStatus(message, kind = "") {
  resetStatus.className = `form-status${kind ? ` ${kind}` : ""}`;
  resetStatus.textContent = message;
}

requestForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = document.getElementById("requestButton");
  button.disabled = true;
  setStatus("Envoi en cours…");
  try {
    const response = await fetch("/api/auth/password-reset/request", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ email: document.getElementById("resetEmail").value }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Demande impossible. Réessayez plus tard.");
    requestForm.reset();
    setStatus(data.message || "Si ce compte peut être récupéré, les instructions seront envoyées.", "success");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Demande impossible. Réessayez plus tard.", "error");
  } finally {
    button.disabled = false;
  }
});

confirmForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = document.getElementById("newPassword").value;
  const confirmation = document.getElementById("passwordConfirmation").value;
  if (password !== confirmation) return setStatus("Les mots de passe ne correspondent pas.", "error");
  const button = document.getElementById("confirmButton");
  button.disabled = true;
  setStatus("Mise à jour en cours…");
  try {
    const response = await fetch("/api/auth/password-reset/confirm", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ token, password }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Lien invalide ou expiré.");
    confirmForm.hidden = true;
    setStatus(data.message || "Mot de passe mis à jour. Reconnectez-vous.", "success");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Lien invalide ou expiré.", "error");
  } finally {
    button.disabled = false;
  }
});

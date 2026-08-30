"use strict";
const form = document.getElementById("loginForm");
const status = document.getElementById("loginStatus");
const button = document.getElementById("loginButton");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  status.className = "form-status";
  status.textContent = "Connexion en cours…";
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    const payload = Object.fromEntries(new FormData(form));
    const response = await fetch(form.action, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "accept": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Connexion impossible. Réessayez plus tard.");
    status.className = "form-status success";
    status.textContent = "Connexion réussie. Ouverture de votre espace…";
    window.location.replace("/app");
  } catch (error) {
    status.className = "form-status error";
    status.textContent = error instanceof Error ? error.message : "Connexion impossible. Réessayez plus tard.";
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
});

"use strict";
const registrationForm = document.getElementById("registrationForm");
const registrationStatus = document.getElementById("registrationStatus");
const registrationButton = document.getElementById("registrationButton");
const challengeField = document.getElementById("registrationChallenge");

async function refreshChallenge() {
  const response = await fetch("/api/public/registration-challenge", { credentials: "same-origin", headers: { accept: "application/json" } });
  const data = await response.json();
  if (!response.ok || !data.challenge) throw new Error("Le contrôle de sécurité est indisponible. Réessayez plus tard.");
  challengeField.value = data.challenge;
}

refreshChallenge().catch((error) => {
  registrationStatus.className = "form-status error";
  registrationStatus.textContent = error.message;
});

registrationForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  registrationStatus.className = "form-status";
  registrationStatus.textContent = "Enregistrement sécurisé de votre demande…";
  registrationButton.disabled = true;
  registrationButton.setAttribute("aria-busy", "true");
  try {
    const values = Object.fromEntries(new FormData(registrationForm));
    const payload = {
      ...values,
      approximateStudentCount: Number(values.approximateStudentCount),
      acceptTerms: registrationForm.elements.acceptTerms.checked,
      acknowledgePrivacy: registrationForm.elements.acknowledgePrivacy.checked,
      confirmRepresentation: registrationForm.elements.confirmRepresentation.checked,
    };
    const response = await fetch(registrationForm.action, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(payload) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.message || "Inscription impossible. Réessayez plus tard.");
    registrationStatus.className = "form-status success";
    registrationStatus.textContent = data.message || "Votre demande a été enregistrée. Consultez votre messagerie.";
    registrationForm.reset();
    await refreshChallenge();
  } catch (error) {
    registrationStatus.className = "form-status error";
    registrationStatus.textContent = error instanceof Error ? error.message : "Inscription impossible. Réessayez plus tard.";
    await refreshChallenge().catch(() => {});
  } finally {
    registrationButton.disabled = false;
    registrationButton.removeAttribute("aria-busy");
  }
});

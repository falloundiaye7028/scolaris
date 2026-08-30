"use strict";
const form = document.getElementById("parentForm");
const status = document.getElementById("parentStatus");
const result = document.getElementById("parentResult");
const addText = (parent, tag, text) => { const element = document.createElement(tag); element.textContent = text; parent.append(element); return element; };

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  result.replaceChildren();
  status.className = "form-status";
  status.textContent = "Vérification en cours…";
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    const response = await fetch(form.action, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Accès impossible");
    status.textContent = "Accès autorisé.";
    status.className = "form-status success";
    addText(result, "h2", data.guardian?.full_name || "Situation des paiements");
    for (const student of data.students || []) {
      const article = document.createElement("article");
      article.className = "hero-card";
      addText(article, "h3", `${student.first_name} ${student.last_name}`);
      addText(article, "p", `Matricule : ${student.matricule} · Classe : ${student.class_name || "—"}`);
      for (const invoice of student.invoices || []) addText(article, "p", `${invoice.label} — ${invoice.paidMinor}/${invoice.amountMinor} ${invoice.currency}`);
      result.append(article);
    }
    form.reset();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Accès impossible";
    status.className = "form-status error";
  } finally {
    button.disabled = false;
  }
});

# Déploiement et retour arrière

## Avant déploiement

- [ ] Revue de code et diff Git limités au périmètre attendu.
- [ ] Sauvegarde chiffrée récente identifiée et test de restauration réussi dans une base isolée.
- [ ] `npm ci --prefix api`, lint, contrôle syntaxique, tests unitaires/intégration/sécurité, build et audit des dépendances réussis.
- [ ] Aucun secret détecté dans les fichiers suivis ni dans l'historique ; secrets Vercel séparés par environnement.
- [ ] `DATABASE_URL` Preview cible une base isolée sans donnée réelle et distincte de Production.
- [ ] Migration additive exécutée en préproduction, puis vérifiée.
- [ ] `MFA_ENFORCEMENT=off` tant que l'enrôlement et la récupération ne sont pas validés.
- [ ] Pages légales et obligations CDP validées avant toute donnée réelle.

## Vérifications préproduction

- [ ] Connexion, MFA de test, réauthentification, changement et récupération de mot de passe.
- [ ] Deux établissements et quatre rôles : aucun accès croisé, y compris par modification d'UUID.
- [ ] Imports CSV/XLSX valides et malveillants ; exports autorisés/non autorisés.
- [ ] Cookies, en-têtes, CSP, cache privé, `robots.txt`, `sitemap.xml` et `security.txt`.
- [ ] Parcours mobile et clavier, absence d'erreur console et réponses API sans traces internes.

## Mise en production

- [ ] Le blocage juridique/CDP de `config/legal-requirements.json` a été levé par les responsables compétents.
- [ ] Déployer l'artefact immuable testé, sans modifier les secrets existants dans la même opération.
- [ ] Vérifier `/`, `/connexion`, `/app` non authentifié, `/api/health`, une connexion de recette et une déconnexion.
- [ ] Surveiller erreurs 5xx, latence, échecs de connexion, refus et événements critiques pendant au moins 30 minutes.

## Retour arrière

- [ ] Redéployer l'artefact précédent ; ne supprimer aucune table ou colonne additive.
- [ ] Si nécessaire et approuvé, révoquer uniquement les sessions actives afin de forcer une reconnexion.
- [ ] Ne restaurer la base qu'après qualification d'une corruption ou migration défectueuse et validation du responsable d'incident.
- [ ] Vérifier santé, intégrité et parcours critiques, puis documenter la décision.

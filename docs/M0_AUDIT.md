# SCOLARIS PAY — Rapport M0

Date de l'audit : 2026-09-01  
Révision auditée : `5eb14d7`  
Branche source : `codex/security-hardening`, alignée avec `origin/main` au début de M0  
Décision : **M0 COMPLETE — M1 autorisé, M2 interdit**

## 1. Périmètre et méthode

M0 a porté exclusivement sur le dépôt local SCOLARIS PAY. Aucun secret, paramètre Vercel, domaine, déploiement ou donnée de production n'a été modifié. L'audit a couvert :

- structure du dépôt et historique Git ;
- architecture web, API et PostgreSQL ;
- authentification, sessions, MFA, RBAC et isolation multi-établissements ;
- schémas académique, financier et abonnement plateforme ;
- migrations, tests, reproductibilité et dépendances ;
- configuration Vercel, en-têtes HTTP, indexation et cache ;
- scans de secrets dans les fichiers suivis et dans l'historique Git.

## 2. Architecture constatée

- Monorepo npm léger, sans framework frontend : site public statique dans `web/` et API Node.js dans `api/`.
- API HTTP native Node.js, déployée comme fonction Vercel via `api/index.js`.
- PostgreSQL 16 en développement, accès par `pg` 8.23.0.
- Schéma principal dans `api/src/schema.sql` et domaine des frais dans `api/src/fee-schema.sql`.
- Authentification par cookie de session opaque `HttpOnly`, sessions persistées et hachées, Argon2id, migration bcrypt, limitation persistante et MFA TOTP.
- Autorisations par rôles `owner`, `director`, `accountant`, `teacher`, avec super-administration explicite.
- Séparation physique entre paiements scolaires et règlements d'abonnement SCOLARIS PAY.
- Interface privée servie uniquement après authentification, sans indexation ni cache public.

## 3. État fonctionnel

Le dépôt contient déjà une première version de la structure académique :

- `students` ;
- `academic_years` ;
- `classes` ;
- `guardians` et `student_guardians` ;
- `enrollments` ;
- création et consultation des années, classes, responsables et inscriptions ;
- filtrage applicatif systématique par `school_id` sur les routes auditées ;
- rattachement des frais, factures et rapports à l'année scolaire et à la classe.

Cette base est fonctionnelle mais ne constitue pas encore une fondation académique suffisamment contrainte au niveau PostgreSQL.

## 4. Contrôles exécutés

| Contrôle | Résultat |
|---|---|
| `npm run build` | Réussi |
| Lint / contrôle syntaxique | Réussi |
| Tests sans PostgreSQL | 54 réussis, 1 test d'intégration volontairement ignoré |
| Tests avec `TEST_DATABASE_URL` isolée | 55 réussis, 0 échec, 0 ignoré |
| Isolation multi-établissements / RBAC / sessions | Réussie |
| `npm audit --prefix api --audit-level=high` | 0 vulnérabilité |
| Scan des fichiers suivis | Aucun secret à haute confiance |
| Scan de l'historique Git | Aucun secret à haute confiance |
| `git fsck --no-dangling` et `git diff --check` | Réussis |

La base de test utilisée s'appelle `scolaris_m0_test`. Le test détruit et recrée uniquement son schéma `public` ; aucune base de production ou de prévisualisation n'a été utilisée.

## 5. Points solides

- Isolation applicative multi-écoles testée de bout en bout.
- Requêtes paramétrées, validation des UUID, dates, montants et corps JSON.
- Sessions opaques révocables, limites d'inactivité et absolues, cookie sécurisé.
- Politique de mot de passe et MFA correctement séparées de la récupération.
- Imports bornés et contrôlés ; exports bornés, réauthentifiés, journalisés et protégés contre les formules CSV.
- Paiements scolaires et abonnements plateforme séparés dans le modèle, les routes et les permissions.
- Migrations actuelles additives et idempotentes dans les scénarios testés.
- En-têtes Vercel complets : CSP, HSTS, anti-framing, no-sniff, cache privé et noindex sur les routes privées.

## 6. Écarts identifiés

### A1 — Intégrité multi-établissements académique au niveau PostgreSQL

Les routes vérifient correctement `school_id`, mais plusieurs relations académiques utilisent uniquement l'identifiant UUID comme clé étrangère. Une écriture directe en base pourrait donc relier une classe, une année, un élève ou un responsable appartenant à des établissements différents.

Décision : à corriger dans M1 par des contraintes composées incluant `school_id`, après contrôle préalable des données existantes.

### A2 — Une seule année scolaire courante non garantie

`academic_years.is_current` existe, mais aucune contrainte ne garantit une seule année courante par établissement. La route de création ne désactive pas atomiquement l'année courante précédente.

Décision : à corriger dans M1 avec un index unique partiel et une transaction de bascule.

### A3 — États académiques insuffisamment contraints

Les statuts des élèves et inscriptions ne disposent pas tous de contraintes SQL. Les écritures API sont validées, mais une valeur incohérente reste possible par accès SQL direct ou future évolution.

Décision : ajouter des contraintes de domaine compatibles avec les données existantes dans M1.

### A4 — Classe courante dénormalisée sur l'élève

`students.class_name` duplique le nom issu de l'inscription annuelle. Cette valeur facilite la compatibilité historique mais peut diverger de `enrollments`.

Décision : conserver temporairement la colonne pour compatibilité, considérer `enrollments` comme source de vérité et synchroniser explicitement la projection dans M1. La suppression éventuelle est hors M1.

### A5 — Cycle de vie académique incomplet

L'API sait créer et lister les années/classes et créer une inscription, mais ne fournit pas encore de lecture détaillée des inscriptions ni de bascule dédiée de l'année courante. Les mutations destructives ne sont pas nécessaires à la fondation.

Décision : compléter uniquement les opérations sûres de M1 ; aucune suppression physique.

### A6 — Maintenabilité

Le routeur principal concentre de nombreux domaines dans un fichier dense et le typage est limité au contrôle syntaxique Node.js. Ce point augmente le coût de revue mais ne bloque pas M1.

Décision : isoler la logique académique dans un service dédié pendant M1, sans refonte générale de l'API.

## 7. Risques non bloquants hors M1

- Les objectifs de restauration, la conservation et les procédures opérationnelles restent à éprouver périodiquement selon `docs/OPERATIONS_SECURITY.md`.
- La MFA est prévue pour une activation progressive ; son activation globale ne fait pas partie de M1.
- La dette de formatage du frontend privé et du routeur principal reste hors périmètre.
- Aucun travail de notes, présences, emplois du temps, examens ou pédagogie avancée ne doit commencer : ces domaines relèvent de M2 ou d'un jalon ultérieur.

## 8. Conclusion et porte de passage

M0 ne révèle aucun blocage empêchant une évolution locale et additive. La branche est reproductible, les dépendances ne présentent pas de vulnérabilité connue au niveau audité, les secrets sont propres et l'isolation applicative est couverte par un test PostgreSQL réel.

**Recommandation : démarrer uniquement M1 — fondation académique**, avec les garde-fous suivants :

1. aucune modification de production ;
2. migration additive et idempotente ;
3. conservation des données et colonnes historiques ;
4. contraintes multi-établissements au niveau base ;
5. année courante unique et bascule transactionnelle ;
6. tests PostgreSQL réels obligatoires ;
7. aucun démarrage de M2.

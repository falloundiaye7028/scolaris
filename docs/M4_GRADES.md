# M4 — Notes, évaluations, coefficients et moyennes

## Note d'audit préalable

- La base de référence est `main` au commit `1e1a4365beed07ba422193f3767f05e65674a03a`.
- M1 fournit `academic_years`, `classes` et `enrollments`; l'inscription annuelle est la source de vérité de la classe d'un élève.
- M2 fournit `subjects` et `teaching_assignments`. Une affectation relie déjà, dans une même école et une même année, un enseignant, une classe et une matière. Aucun coefficient contextuel n'existe encore.
- M3 fournit `academic_periods`, les transactions de saisie groupée, les événements d'historique et la concurrence optimiste par `version` avec réponse HTTP 409.
- Les rôles existants sont `owner`, `director`, `accountant` et `teacher`. M4 étend la matrice existante; il ne crée aucun second système RBAC.
- Les audits existants utilisent `audit_logs` et l'école provient exclusivement de la session authentifiée.

## Décisions M4

- Le barème par défaut est configuré par école (`20`) mais chaque évaluation possède son propre maximum strictement positif.
- Le coefficient d'une évaluation est stocké en `NUMERIC(8,4)` sur l'évaluation.
- Le coefficient de matière est contextuel à la classe et à l'année : il est ajouté à `teaching_assignments` en `NUMERIC(8,4)`, avec valeur initiale `1`.
- Les statuts de résultat sont `scored`, `absent`, `excused`, `exempt` et `pending`. Seul `scored` porte une note.
- Une absence est exclue par défaut. La politique explicite `zero` l'intègre comme zéro. Les statuts `excused`, `exempt` et `pending` restent exclus.
- Les calculs principaux sont effectués en PostgreSQL `NUMERIC`. La note normalisée est conservée avec six décimales; aucun `FLOAT` ou `REAL` n'est utilisé.
- L'arrondi final utilise `round(value, rounding_precision)` selon le réglage de l'école. Les moyennes intermédiaires non arrondies alimentent la moyenne générale.
- Une évaluation `draft` est modifiable par son enseignant affecté. Une évaluation `published` exige une permission de correction et un motif. Une évaluation `locked` exige une réouverture privilégiée auditée.
- Les modifications utilisent une version optimiste. Une version obsolète retourne HTTP 409 sans écrasement.
- Les évaluations annulées et les matières sans résultat pris en compte sont exclues des moyennes.

## Argon2

`argon2@0.45.1` est épinglé dans le lockfile et ses tests Argon2id sont verts. Les versions récentes de npm demandent une politique de scripts d'installation explicite. M4 autorise uniquement `argon2` dans le champ `allowScripts` du `package.json` de l'API; aucune autorisation globale n'est activée.

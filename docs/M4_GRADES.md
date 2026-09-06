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
- Les calculs principaux sont effectués en PostgreSQL `NUMERIC`; aucun `FLOAT` ou `REAL` n'est utilisé. Chaque résultat est d'abord converti en ratio canonique `score / maximum_score`, ou en zéro si le snapshot publié applique cette politique à une absence.
- La moyenne matière est `Σ(ratio × coefficient d'évaluation) / Σ(coefficients inclus)`. La moyenne générale est `Σ(ratio matière × coefficient de matière) / Σ(coefficients de matière inclus)`. La moyenne de classe agrège ensuite une seule moyenne générale par élève.
- L'affichage multiplie le ratio final par le barème du snapshot publié le plus récent dans le périmètre du rapport, puis applique uniquement à cette frontière son `rounding_precision`. Des publications `/20` et `/100` ne sont donc jamais additionnées directement.
- Une évaluation `draft` est modifiable par son enseignant affecté. Une évaluation `published` exige une permission de correction et un motif. Une évaluation `locked` exige une réouverture privilégiée auditée.
- Les modifications utilisent une version optimiste. Une version obsolète retourne HTTP 409 sans écrasement.
- Les évaluations annulées et les matières sans résultat pris en compte sont exclues des moyennes.
- `assessment_types.manage` est réservé à `owner` et `director`. Un enseignant conserve la création d'évaluations pour ses propres affectations, mais ne peut pas modifier le catalogue global des types.
- Une réponse enseignant ne contient pas de `general_average`; elle expose seulement `authorized_average`, clairement présentée comme la moyenne des matières autorisées, sans révéler les matières d'un autre enseignant.

## Seed Preview

Le seed exige simultanément le contexte Vercel Preview explicite et une identité lue depuis `deployment_environment_identity` sur la connexion PostgreSQL réellement utilisée. Cette ligne unique doit porter `environment='preview'` et une empreinte stable correspondant à `SCOLARIS_PREVIEW_DATABASE_FINGERPRINT`. Une identité absente, inconnue, Production ou différente échoue avant `BEGIN` et avant toute écriture. Le hostname n'est pas une preuve d'identité; le provisionnement de cette ligne est une opération distante séparée nécessitant une autorisation humaine.

## Argon2

`argon2@0.45.1` est épinglé dans le lockfile et ses tests Argon2id sont verts. Les versions récentes de npm demandent une politique de scripts d'installation explicite. M4 autorise uniquement `argon2` dans le champ `allowScripts` du `package.json` de l'API; aucune autorisation globale n'est activée.

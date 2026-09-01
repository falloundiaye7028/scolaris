# SCOLARIS PAY — Rapport M2

Date : 2026-09-01  
Branche locale : `codex/m2-timetable`  
Base : commit M1 `6947692`  
Périmètre : emplois du temps et séances pédagogiques uniquement

## Audit préalable

M1 contenait les établissements, utilisateurs avec rôle `teacher`, années scolaires, classes, élèves et inscriptions. Il ne contenait ni matière, ni salle, ni affectation pédagogique, ni emploi du temps, ni séance réelle.

M2 ajoute donc uniquement les entités manquantes nécessaires :

- `subjects` ;
- `rooms` ;
- `teaching_assignments` ;
- `timetable_entries` ;
- `lesson_sessions`.

Les conventions M1 sont conservées : UUID, `school_id` issu de la session, clés étrangères composées pour l'isolation, migrations additives, validation serveur, journal d'audit et désactivation logique.

## Stratégie des séances

Les séances sont matérialisées à la demande sur une plage comprise entre 1 et 62 jours.

Cette stratégie a été retenue parce qu'elle :

- évite de créer des années entières de séances inutilisées ;
- fournit de vrais identifiants stables pour les futures présences M3 ;
- permet de conserver une séance annulée ou déplacée indépendamment du créneau régulier ;
- rend la génération rejouable grâce à l'unicité créneau/date ;
- borne chaque lecture et chaque génération.

Le risque principal est qu'une période non matérialisée ne possède pas encore ses lignes de séance. L'API de génération explicite résout ce point et pourra plus tard être appelée lors de l'ouverture d'une période de présence. Les séances déjà déplacées sont prises en compte par la détection de conflits avant toute nouvelle matérialisation.

## Conflits et intégrité

Deux périodes se chevauchent uniquement lorsque `new_start < existing_end` et `new_end > existing_start`. Les créneaux adjacents sont donc acceptés.

Le serveur sérialise les mutations du calendrier par établissement avec un verrou transactionnel, puis refuse les conflits :

- enseignant ;
- classe ;
- salle ;
- heure de début supérieure ou égale à l'heure de fin ;
- date hors année scolaire ;
- salle inactive ;
- affectation inactive.

PostgreSQL renforce également les relations école/année/enseignant/classe/matière/salle au moyen de clés étrangères composées et de déclencheurs de cohérence académique.

## Permissions

M2 étend le RBAC existant sans créer de second système :

- direction et propriétaire : lecture et gestion complètes ;
- enseignant : lecture de son propre emploi du temps et de ses propres séances ;
- comptable : aucun accès pédagogique M2.

Permissions ajoutées : `timetable.read`, `timetable.manage`, `rooms.read`, `rooms.manage`, `lesson_sessions.read`, `lesson_sessions.manage`.

## Interface

La navigation privée contient désormais « Emploi du temps » dans le domaine Pédagogie.

- Vue classe et vue enseignant.
- Création guidée d'une matière, salle, affectation et créneau.
- Messages de conflits métier affichés directement.
- Grille hebdomadaire sur desktop.
- Trois colonnes sur tablette.
- Agenda journalier d'une colonne sur mobile.

## Validation

- migration M1 → M2 exécutée deux fois avec succès ;
- build, lint et contrôle syntaxique réussis ;
- tests PostgreSQL complets réussis, y compris non-régression M0/M1 ;
- conflits enseignant, classe et salle testés ;
- créneaux adjacents testés ;
- isolation multi-écoles et permissions testées ;
- salles et affectations inactives testées ;
- desktop 1280 px, tablette 820 px et mobile 390 px vérifiés dans le navigateur local ;
- aucun débordement horizontal et aucune erreur navigateur ;
- scans de secrets et d'historique réussis.

Aucune production, variable Vercel ou donnée distante n'a été modifiée. Aucun push ni déploiement n'a été effectué. M3 n'a pas été commencé.

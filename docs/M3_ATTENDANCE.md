# SCOLARIS PAY — Rapport technique M3

Date : 2026-09-01  
Branche : `codex/m3-attendance`  
Base M2 : `139dc3b0fc80db67a9e3c7a9095ec430f123cbd6`  
Périmètre : présences, absences, retards et justificatifs uniquement

## Audit préalable

M1 fournit déjà les établissements, utilisateurs, années scolaires, classes, élèves et inscriptions. M2 fournit les matières, affectations pédagogiques, emplois du temps et vraies `lesson_sessions`. Aucun modèle de présence, aucune période académique et aucun stockage documentaire générique sécurisé n'existaient.

M3 réutilise donc les séances M2 et ajoute seulement :

- `academic_periods` ;
- `attendance_records` ;
- `attendance_record_events` pour l'historique immuable des corrections ;
- `attendance_domain_events` comme boîte d'événements indépendante d'un fournisseur de notification ;
- `attendance_justification_documents`, stockage privé contrôlé car le stockage de justificatifs d'abonnement existant est propre au domaine financier et ne peut pas être réutilisé sans mélanger deux responsabilités.

Le rôle `surveillant` n'existe pas dans le modèle d'utilisateurs validé par M0-M2. M3 n'introduit donc pas un rôle impossible à créer : le propriétaire et la direction gèrent l'ensemble, l'enseignant agit uniquement sur ses séances, et le comptable reste exclu. Les permissions `attendance.*` sont prêtes à être attribuées à un futur rôle de vie scolaire lorsqu'une gestion générique des rôles sera décidée.

## Intégrité et isolation

Une présence référence obligatoirement la séance, l'élève et l'inscription du même établissement. Un déclencheur PostgreSQL vérifie que l'inscription correspond à la classe et à l'année de la séance, qu'elle est déjà effective à la date du cours et que la séance n'est pas annulée. L'unicité `(school_id, lesson_session_id, student_id)` empêche les doublons.

Le serveur dérive toujours `school_id` de la session. Il contrôle également l'affectation de l'enseignant, les identifiants d'élève et de justificatif, et n'expose jamais le contenu d'un document sans authentification et vérification du tenant.

## Sauvegarde et concurrence

L'appel est enregistré en lot dans une transaction. Une seule lecture valide toute la liste de classe, une seconde valide les justificatifs, puis un `UPSERT` enregistre l'ensemble. Un verrou consultatif par établissement/séance sérialise les appels concurrents.

Chaque ligne possède une `version`. Une correction doit transmettre la version lue ; une sauvegarde ancienne reçoit un conflit HTTP 409 au lieu d'écraser une modification récente. Chaque changement est copié dans `attendance_record_events` et synthétisé dans `audit_logs`.

## Justificatifs

Les justificatifs acceptent uniquement PDF, JPEG ou PNG, dans la limite de 2 Mo. Le serveur contrôle l'extension logique, le type annoncé, la signature binaire, la taille, l'élève, le tenant et calcule un SHA-256. Les octets sont stockés dans PostgreSQL et servis par une route privée avec les en-têtes de sécurité de l'application.

## Calculs et rapports

La formule officielle est :

`présence effective = PRESENT + LATE`

Le dénominateur contient uniquement les appels renseignés. `EXCUSED` reste séparé et n'est jamais assimilé à une présence. Les rapports exposent donc le taux de présence, d'absence non justifiée, d'absence justifiée et de retard.

Les portées établissement, classe et élève sont disponibles sur une plage personnalisée, une période académique ou l'année. Le résultat comprend les séances prévues/réalisées, l'effectif, l'évolution mensuelle, l'évolution par période et, lorsque des données existent, la comparaison avec la période précédente. La liste des élèves les plus absents n'est renvoyée que pour une classe à un rôle administratif. L'export CSV réutilise l'infrastructure existante.

## Interface

La rubrique « Présences » propose l'appel du jour, l'historique et les rapports. L'appel filtre par date, classe, matière, enseignant autorisé et séance. L'action « Marquer tous présents » accélère le traitement des exceptions.

Sur smartphone, chaque élève est affiché dans une carte avec quatre boutons tactiles comportant texte, couleur et icône. Sur tablette et ordinateur, la grille s'élargit sans transformer l'écran mobile en tableau horizontal. La fiche élève ouvre une synthèse et son historique récent.

## Validation attendue

- migration additive M1 → M2 → M3 et relance idempotente ;
- appel normal et batch atomique ;
- unicité, statuts et séance annulée ;
- élève hors classe, séance et élève d'un autre établissement ;
- enseignant affecté/non affecté et comptable ;
- correction `ABSENT → EXCUSED`, justificatif et conflit de version ;
- fixture exacte de 20 séances : 14 présents, 2 retards, 3 absences, 1 justifiée ;
- rapports mensuel, par période, annuel et CSV ;
- non-régression M0, M1 et M2 ;
- build et scans de secrets.

M3 ne déclenche aucun SMS, e-mail ou WhatsApp. Il publie uniquement les événements `student.absent`, `student.late` et `absence.justified` dans une boîte interne destinée à un futur module. M4 n'est pas commencé.

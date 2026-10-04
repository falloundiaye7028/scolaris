# Améliorations et incident de restauration — 4 octobre 2026

## Travaux demandés

Le propriétaire a autorisé les sept améliorations proposées : accès à AMY, sauvegardes et surveillance, filtres et documents AMY, relances validées et suivies, navigation mobile et pagination, pilotage des établissements, paiement Wave conditionné aux accès marchands.

Branche de travail : `codex/ameliorations-completes-2026-10-04`, base `de084578d400a1edb24c4a95d9a4e1a0d487a8c7`.
Les fichiers étaient initialement une ébauche non intégrée. Voir le bilan de reprise ci-dessous.

## Point de restauration et comportement observé

Projet Neon : `jolly-surf-69975108`.
Branche de production d'origine : `br-patient-scene-b2nat2h9`.
Point de connexion Vercel existant depuis le 24 août : `ep-summer-waterfall-b2yabfjr`.

- La programmation quotidienne native a été refusée : « backup schedule creation is not enabled for this project ».
- Snapshot créé : `snap-super-paper-b2n5w9xd`, à 01:28:09 UTC, expiration le 3 novembre 2026 à 03:00 UTC.
- Un appel `restore_snapshot` sans branche cible et sans `finalize:false`, prévu comme restauration isolée, a créé `br-holy-mode-b27mdyli` puis finalisé la restauration automatiquement à 01:29:08 UTC. Le point de connexion de production a été déplacé vers cette copie ; les noms et la branche par défaut ont été échangés.
- La branche d'origine est conservée. Un endpoint temporaire `ep-wispy-bread-b2dx1i0t` a été créé sur cette branche par l'opération.
- À 01:34:23 UTC, la branche d'origine a été remise comme branche par défaut. Cela ne rétablit pas à lui seul le rattachement de l'endpoint utilisé par Vercel.
- Une copie supplémentaire de la branche d'origine, `br-patient-mountain-b24iv4pz`, a été créée sans compute pour permettre une remise en place préservant tous les endpoints et toutes les données.

## Contrôles réalisés

- Le domaine de production répond HTTP 200 à `/api/health`, avec `status:ok`.
- La variable Vercel de production `DATABASE_POSTGRES_HOST` désigne bien `ep-summer-waterfall-b2yabfjr-pooler.c-6.eu-central-1.aws.neon.tech`.
- Les 58 tables publiques ont été comparées entre la branche d'origine et la copie restaurée : nombre de lignes et empreinte MD5 des représentations JSON complètes, triées, de toutes les lignes. Les 58 comparaisons concordent. Aucune donnée personnelle ni secret n'a été affiché pour cette comparaison.
- Ce contrôle est daté de l'intervention ; refaire la comparaison avant tout rattachement pour prendre en compte de possibles nouvelles écritures.

## Blocage automatique et remise en place proposée

La suppression du compute temporaire a été rejetée par le contrôle automatique, qui demande une preuve d'isolation et de non-utilisation. Après vérification, le contrôle a maintenu son refus. L'alternative conservatrice consistant à déplacer cet endpoint sur la copie supplémentaire a également été rejetée, au motif d'un risque de coupure de connexions et d'une autorisation insuffisamment explicite. Aucune de ces actions rejetées n'a été exécutée.

Demander l'autorisation explicite du propriétaire avant toute nouvelle tentative de déplacement. La remise en place proposée est :

1. Refaire la comparaison des données ; traiter toute divergence avant bascule.
2. Conserver `ep-wispy-bread-b2dx1i0t` en le rattachant à `br-patient-mountain-b24iv4pz`, clone conservé de la branche d'origine.
3. Rattacher `ep-summer-waterfall-b2yabfjr` à `br-patient-scene-b2nat2h9`.
4. Vérifier les rattachements, le statut par défaut, les noms et la santé du site.
5. Poursuivre les améliorations et leurs tests. Pour les futurs exercices de restauration, toujours utiliser explicitement `finalize:false` et vérifier les rattachements avant toute autre action.

Aucune nouvelle migration ni amélioration de code n'a été déployée en production pendant cette intervention. Aucune automatisation quotidienne de sauvegarde n'a encore été créée.

## Résolution autorisée

Le propriétaire a donné son accord explicite à 01:39:49 UTC. Nouvelle comparaison à 01:40:31 UTC : 58 tables, aucune différence. À 01:40:48 UTC, le compute temporaire a été rattaché à la copie conservée `br-patient-mountain-b24iv4pz`. À 01:41:02 UTC, le compute Vercel `ep-summer-waterfall-b2yabfjr` a été rattaché à la branche d'origine `br-patient-scene-b2nat2h9`. Celle-ci est de nouveau nommée `main`, `default:true`, état `ready`. La copie restaurée est conservée sous `restored-copy-preserved-2026-10-04`. Aucun endpoint ni donnée n'a été supprimé. Contrôles finaux : `/api/health`, `/connexion`, `/amy-assistant.js` HTTP 200. L'incident de rattachement est résolu ; les travaux reprennent.


## Reprise et préparation de publication

- Le rattachement de production a été revérifié : endpoint `ep-summer-waterfall-b2yabfjr` sur la branche d’origine `br-patient-scene-b2nat2h9`.
- AMY devient visible dans l’administration plateforme avec un choix d’école. Les filtres portent sur les dates d’échéance, l’année et la classe ; tous les règlements des échéances sélectionnées sont comptés.
- Base documentaire par école : 50 textes au maximum, 50 000 caractères chacun, 1 million de caractères par école. Import TXT/Markdown ou texte collé ; la recherche française transmet au plus 5 extraits et affiche leurs références. Retrait réservé à la direction.
- Navigation mobile, recherche et pagination serveur des élèves et échéances impayées, tendances des abonnements sur 12 mois et accès aux renouvellements.
- Relances : brouillon, validation des coordonnées affichées, envoi, statut prestataire et livraison distincts. Si le destinataire change après validation, annulation. Aucun ancien brouillon n’est approuvé automatiquement. Traitement quotidien par lots, jusqu’à 90 relances ou la limite de durée, puis reprise au prochain passage ; traitement individuel possible après validation.
- Wave : configuration explicite par établissement, signatures vérifiées, rapprochement via l’API Wave, création atomique du reçu et protection contre les doublons. Un paiement dont le solde a changé passe en vérification manuelle. Une confirmation tardive reste traitable.
- Trois contrôles d’acteurs supplémentaires protègent les nouvelles tables et validations de relances.
- Les deux intégrations restent désactivées par défaut ; aucun message réel ni paiement réel n’a été déclenché pendant la recette.
- L’automatisation de surveillance est horaire. Au contrôle de reprise, la sauvegarde intitulée « quotidienne » est configurée dans Automations pour le dimanche à 03 h (Dakar), après une modification à 12 h 01 ; cette programmation existante n’a pas été remplacée. Les snapshots restent hébergés chez Neon. La copie indépendante hors fournisseur reste à réaliser.

Les journaux locaux précédents sont complétés par une nouvelle recette sur base embarquée, les tests d’interface et la CI PostgreSQL native avant fusion. Le statut exact de déploiement est enregistré dans la demande de fusion.


## Validation de la reprise et blocage de publication

- Build local : 138 tests réussis ; un test PostgreSQL natif ignoré localement.
- Scénario métier complet sur PGlite : réussi, incluant filtrage financier, recherche documentaire, isolation des écoles, approbation des coordonnées, annulation après changement de destinataire, doublons Wave et solde modifié. PGlite sérialise les connexions et ne prouve pas la concurrence PostgreSQL native.
- UI Chromium : ordinateur et mobile, AMY accessible depuis l’administration, contexte scolaire conservé, affichage texte sans HTML exécutable, recherche conservée, écrans de relance et Wave non configurés.
- Migration appliquée deux fois dans une transaction sur la branche isolée `codex-audit-scolaris-2026-10-03` / `br-wispy-surf-b2u7ima9`, PostgreSQL 18.6 : succès ; 3 tables nouvelles et 3 contrôles d’acteurs vérifiés. Aucune migration de ce lot en production.
- Analyse locale des secrets : arbre suivi et historique Git réussis.
- AMY : TypeScript et 10 tests ciblés réussis ; PR https://github.com/falloundiaye7028/amy-ia-solutions/pull/26 ; arbre publié à partir du main distant et les trois versions de base vérifiées identiques avant publication.
- Le push SCOLARIS a été rejeté par le contrôle automatique. Après preuve du compte connecté, de la propriété et des droits admin/push, un second essai a été refusé : publication de code vers un dépôt public nécessitant une autorisation explicite de l’utilisateur pour ce lot. Aucune tentative par un autre mécanisme après ce second refus.
- Pour débloquer : autorisation explicite de publier le lot de 27 fichiers de la branche `codex/ameliorations-completes-2026-10-04` sur le dépôt public `falloundiaye7028/scolaris`. Il faudra ensuite ouvrir la PR, exiger la CI PostgreSQL native, vérifier la préproduction, puis déployer AMY avant SCOLARIS.


## Dernier contrôle

CI AMY de la PR 26, commit `63ba3de425e03082d9a32b7b99dc97b2a4937ca2` : succès de l’exécution `37201168255` ; 671 tests et 127 parcours Playwright réussis, TypeScript, lint et build réussis. Préproduction Vercel `dpl_Hkxfn4nip6v7WLGAfUSrbXodBT9V` prête. PR laissée ouverte pour coordonner le déploiement avec SCOLARIS.

Production SCOLARIS vérifiée après l’intervention : `/api/health`, `/connexion` et `/amy-assistant.js` HTTP 200. Aucun changement de ce nouveau lot n’a été déployé en production.

# Diagnostic et corrections SCOLARIS — 3 octobre 2026

Dépôt : https://github.com/falloundiaye7028/scolaris

Référence examinée : `main`, commit `8c49e53f975afe1cec3f8459e8bbae99952910f3`.
Branche locale : `codex/diagnostic-corrections-2026-10-03`.

## Résultat et état de livraison

Le code accessible, les schémas SQL, les contrôles d’accès, les parcours métier et les journaux GitHub Actions ont été examinés. Des corrections ont été réalisées et testées sur la copie locale. Elles sont fournies dans un patch applicable au commit de référence et dans une archive du code corrigé.

**État lors de la préparation du rapport :** les corrections sont validées localement et destinées à une branche de revue. Le refus initial `403 Resource not accessible by integration` a été expliqué par l’absence du dépôt dans la sélection de l’application GitHub. Le propriétaire a ajouté `scolaris` et cet accès a été confirmé le 3 octobre à 23 h 47 UTC. La validation GitHub Actions et la mise en production doivent être suivies sur la demande de fusion correspondante.

Ce diagnostic porte sur les éléments accessibles pendant cette intervention. Il ne constitue pas une garantie d’absence de tout défaut, ni un audit des données, secrets de configuration ou services de production auxquels aucun accès n’était fourni.

## Anomalies corrigées

| Domaine | Anomalie et conséquence | Correction |
|---|---|---|
| CI / CodeQL | Initialisation et analyse utilisaient des versions différentes, entraînant l’échec de l’analyse. Le journal indiquait une configuration 4.38.2 chargée par 4.37.9. | Même révision épinglée pour les deux actions ; regroupement de leurs mises à jour Dependabot. |
| Authentification MFA | Relancer la configuration pouvait remplacer une configuration déjà active. | Refus explicite de reconfiguration d’un MFA actif ; confirmation transactionnelle avec verrouillage. |
| MFA et concurrence | Le compteur de tentatives pouvait être dépassé par des requêtes simultanées. | Incrément conditionnel atomique limité à cinq tentatives ; vérification de validité à la consommation du défi. |
| Mots de passe | Des défis MFA ou liens de réinitialisation pouvaient survivre au changement de mot de passe. | Invalidation des éléments encore utilisables lors du changement ; invalidation des défis à la désactivation MFA. |
| Sessions | Création et limitation du nombre de sessions n’étaient pas atomiques. | Transaction et verrou sur le compte actif ; nettoyage limité à l’utilisateur concerné. |
| Contacts des parents | La liste des liens élèves/parents était accessible au rôle enseignant. | Permission spécifique `guardians.read`. |
| Relances | Un parent d’une école pouvait être associé à la facture d’un autre enfant de cette même école. | Vérification du lien effectif entre parent, élève et facture. |
| Présences | L’historique individuel pouvait dépasser le périmètre d’un enseignant. | Filtrage de l’historique selon les affectations autorisées. |
| Superadministration | Les contraintes d’acteur des présences et notes refusaient le véritable identifiant d’un administrateur de plateforme intervenant dans une école. | Références d’acteurs adaptées, avec contrôle SQL : même école ou administrateur de plateforme. Identité réelle conservée dans les historiques. |
| Migrations | Démarrages simultanés, migrations partielles ou échec initial pouvaient rendre le service instable. | Un seul initialiseur partagé, transaction globale, verrou consultatif PostgreSQL et possibilité de réessayer après échec. Réexécution vérifiée après des actions du superadministrateur. |
| Isolation financière | Plusieurs relations financières n’imposaient pas l’établissement dans la clé étrangère. | Quatorze contraintes composées supplémentaires sur les factures, affectations, versements, reçus et équipements. |
| Paiements | Un événement de sécurité enregistré après validation du paiement pouvait produire une erreur HTTP alors que le paiement était déjà enregistré. | Événement enregistré dans la transaction du paiement. |
| Paiements et annulations | L’annulation d’une facture encaissée pouvait laisser une situation financière incohérente. | Annulation refusée tant que les versements correspondants ne sont pas annulés ; ordre de verrouillage déterministe des factures. |
| Validation financière | Devise non XOF ou date de paiement invalide insuffisamment contrôlées. | Validation explicite avant enregistrement. |
| Remises | Une facture entièrement remise pouvait rester considérée comme impayée. | Solde nul traité comme payé, tout en conservant les statuts explicites d’annulation ou d’exonération. |
| Totaux importants | Certaines sommes étaient converties en entier 32 bits. | Agrégats élargis en SQL ; scénario de paiement de trois milliards XOF ajouté. |
| Portail parent | Mauvaise conversion des unités monétaires, et présentation des montants avant remise. | Affichage en FCFA cohérent avec les unités mineures ; montant net de remise ; exclusion des factures annulées. |
| Tableau de bord | Des totaux et effectifs dépendaient de listes tronquées dans le navigateur. | Agrégats complets renvoyés par l’API et utilisés par l’interface. |
| Relevé individuel | Les totaux ne portaient que sur les 500 premières factures. | Agrégation sur tout le compte de l’élève, indépendante du détail limité. Test avec 501 factures. |
| Listes et reçus | Des listes principales, factures, reçus et impayés s’arrêtaient à une première page. | Chargement des pages côté interface ; pagination des factures, reçus et impayés avec ordre stable. |
| Impayés | La conversion d’une date PostgreSQL pouvait produire un nombre de jours invalide. | Conversion explicite ; sélection SQL des échéances effectivement impayées et échues. |
| Affectation des frais | Prévisualisation insuffisamment cohérente avec les références et la classe de la définition. | Validation des références et correspondance des classes. |
| Notes et moyennes | Filtrer un élève avant le calcul collectif transformait la moyenne de classe en moyenne individuelle. | Calcul collectif avant filtrage du résultat individuel. |
| Évaluations individuelles | La fiche d’un élève pouvait afficher les évaluations d’autres classes. | Filtrage par inscription, classe, année et date. |
| Connexions SQL | Un refus d’autorisation dans le workflow des évaluations pouvait laisser une connexion acquise. | Vérification de permission avant acquisition de la connexion. |
| Requêtes JSON | Un caractère UTF-8 séparé entre paquets pouvait être altéré ; des racines JSON inadéquates étaient acceptées. | Décodage UTF-8 strict après assemblage, limite en octets, objet JSON obligatoire et type MIME exact. |
| Imports et justificatifs | La limite générique de longueur des chaînes refusait des fichiers pourtant inférieurs à la taille autorisée. | Limites adaptées aux champs base64 des imports et justificatifs de paiement plateforme. |
| Fichiers XLSX | Le contrôle de taille décompressée intervenait après allocation ; des erreurs de lecture remontaient en erreur interne. | Contrôle des entrées et tailles avant décompression ; rejet des composants actifs ; réponse 400 pour un classeur invalide. |
| Exports CSV | Des espaces avant une formule pouvaient contourner la neutralisation. | Protection également appliquée après espaces et tabulations initiales. |
| Abonnements | L’expiration dépendait du prochain passage du cron ; une suspension manuelle pouvait être effacée. | Évaluation des dates à l’accès ; le cron conserve les suspensions explicites. |
| Serveur local | Les routes de l’application privée et de l’API n’étaient pas relayées sur l’origine du site local. | Proxy local avec transmission des cookies ; routes statiques et méthodes HTTP corrigées. |
| Emploi du temps | Annulation ou déplacement d’une séance pouvait effacer ses notes ou son titre sans modification explicite. | Chargement et conservation de ces champs lorsqu’ils sont omis. |
| Politique de scripts | Toute modification du script privé nécessite de mettre à jour son empreinte CSP. | Empreintes recalculées dans le serveur et la configuration Vercel ; contrôles existants conservés. |

## Vérifications effectuées

Environnement de référence : Node.js 24.20.0, npm 11.19.1, mode de vérification strict. Les dépendances applicatives n’ont pas été mises à jour arbitrairement ; l’installation utilise le verrou existant et conserve l’autorisation ciblée du script Argon2.

| Vérification | Résultat |
|---|---|
| Installation figée `npm ci --prefix api` | Réussie. |
| Construction `SCOLARIS_TOOLCHAIN_MODE=strict npm run build` | Réussie : versions des outils, politique de scripts, contrôles de syntaxe et tests. |
| Suite locale | 128 tests recensés : 127 réussis, aucun échec, un test PostgreSQL natif ignoré faute de serveur natif disponible. |
| Scénario d’intégration complet sur PostgreSQL embarqué PGlite | Réussi séparément, avec adaptateur temporaire des connexions. Inclut les nouvelles assertions métier et la réexécution des migrations. |
| Audit npm des dépendances API | Aucune vulnérabilité signalée au moment de l’exécution. |
| Recherche de secrets dans les fichiers suivis et l’historique Git | Aucun secret à haute confiance signalé par les scripts du projet. |
| Cohérence des modifications `git diff --check` | Réussie. |
| Application du patch sur la référence auditée | Vérifiée séparément lors de la préparation de la livraison. |

Les deux messages `request_failed` de code `XX000` du journal d’intégration correspondent aux échecs d’audit volontairement provoqués par les tests de rollback. Ils ne correspondent pas à un scénario de test en échec.

Le scénario intégré vérifie notamment la connexion, les cookies, les permissions, l’isolation de deux établissements, les affectations et présences, la publication des notes, les moyennes, les paiements et remises, le portail parent, les abonnements, les imports, le renouvellement des sessions et le MFA.

## Limites précises et points à valider avant production

- **PostgreSQL natif et concurrence :** les sept schémas de migration ont également été appliqués avec succès, puis réappliqués, sur une branche isolée de la production dans Neon PostgreSQL 18.6. Les 14 nouvelles contraintes financières sont validées et les 17 contrôles d’acteurs présents. Les tests HTTP complets ne pouvaient pas joindre Neon depuis l’environnement local (résolution réseau indisponible). PGlite sérialise les connexions et ne prouve pas la concurrence native : le workflow PostgreSQL 16 reste le contrôle de référence pour ce scénario.
- **CI distante :** CodeQL, Gitleaks, OSV et les étapes Docker n’ont pas été relancés sur les corrections faute de publication possible. Les contrôles locaux ne sont pas équivalents à ces analyses.
- **Données existantes :** les nouvelles contraintes sont validées. Une base contenant déjà des références financières entre établissements entraînera un échec de migration avec rollback, sans correction arbitraire des données. Tester d’abord sur une copie représentative et disposer d’une sauvegarde avant migration réelle.
- **Interface en production :** les scripts, routes et contrats ont été examinés et testés ; aucune recette visuelle authentifiée de chaque écran, mobile ou navigateur n’a été réalisée.
- **Services extérieurs :** livraison réelle des courriels, SMS/WhatsApp, configuration DNS, secrets de déploiement et exploitation des sauvegardes n’ont pas été vérifiés. Les courriels du scénario intégré sont simulés.
- **Contrôle de types :** le script existant nommé `typecheck` exécute les contrôles de syntaxe JavaScript. Il ne constitue pas une analyse TypeScript complète.
- **Volumes :** les listes principales corrigées se chargent par pages ; le détail d’un relevé reste limité à 500 factures/paiements tandis que ses totaux sont complets. D’autres limites métier existantes (exports à 5 000 lignes, historiques ou calendriers bornés) restent en place. Un audit de performance sur les volumes réels et des interfaces à pagination visible reste utile.
- **Reçus historiques :** les reçus de l’ancien modèle peuvent reprendre des éléments de la facture actuelle, contrairement aux instantanés financiers du nouveau modèle. Reconstruire un instantané historique exact nécessite les données d’archive ; aucun historique manquant n’a été inventé.

## Appliquer les corrections

Le dossier de livraison comprend `corrections.patch`, `source-corrigee.zip`, ce rapport et les journaux de vérification. Le patch est la différence complète par rapport au commit de référence, y compris les nouveaux fichiers SQL et les tests. L’archive source exclut les dépendances installées et les fichiers temporaires de travail.

Sur un clone propre du dépôt, depuis sa racine :

```bash
git switch -c diagnostic-corrections 8c49e53f975afe1cec3f8459e8bbae99952910f3
git apply --check /chemin/vers/corrections.patch
git apply /chemin/vers/corrections.patch
```

Si `main` a évolué, examiner et résoudre les différences sur une branche séparée ; ne pas écraser ces évolutions.

Avec Node.js 24.20.0 et npm 11.19.1 :

```bash
export SCOLARIS_TOOLCHAIN_MODE=strict
npm ci --prefix api
npm run build
npm run security:secrets
npm run security:history
npm run security:audit
```

Pour le test intégré natif, définir `TEST_DATABASE_URL` vers une **base jetable dédiée dont le nom contient `test`**, puis lancer `npm test`. Le scénario recrée le schéma `public` de cette base : ne jamais le pointer vers une base réelle d’école.

La migration applicative utilise `DATABASE_URL` et `npm --prefix api run migrate`. Elle doit d’abord être validée sur une copie de préproduction. Publier ensuite la branche, examiner les résultats du workflow et préparer la mise en production selon le processus habituel du projet.

La branche Neon de validation `codex-audit-scolaris-2026-10-03` est isolée de la production et expire le 5 octobre 2026 à 23 h 10 UTC. Son compute a été suspendu après les vérifications. Le projet Vercel confirmé est `scolaris-pay` dans l’équipe `touba-visuel`. Aucune donnée de production n’a été modifiée par ces tests de migration. Les réglages Neon indiquent une fenêtre de restauration de six heures et aucune planification de snapshots au moment du contrôle ; la stratégie de sauvegarde reste un chantier d’exploitation distinct.

# AMY IA dans SCOLARIS

L’onglet **AMY IA** est destiné aux propriétaires, directeurs et comptables des établissements actifs. Un administrateur de plateforme doit sélectionner un établissement. Les enseignants et les sessions parents n’y ont pas accès.

## Première version

- Questions sur l’utilisation de SCOLARIS, explication des indicateurs et préparation de brouillons.
- Contexte actualisé côté serveur à chaque question : élèves actifs, échéances, sommes attendues, payées, restantes et échues, toutes années scolaires confondues.
- Les montants sont transmis en FCFA entiers, sans conversion flottante ni noms d’élèves. Le calcul suit la même source de paiements que le tableau de bord et exclut les échéances annulées.
- Consultation uniquement : aucun outil de modification, de paiement ou d’envoi de message.
- Pas de base documentaire connectée dans cette version.

## Connexion

Le navigateur appelle `/api/amy/chat` avec sa session SCOLARIS. Le serveur applique les droits, la MFA et l’état de l’abonnement, calcule le contexte de l’établissement courant et appelle AMY par HTTPS. Le navigateur ne reçoit aucune clé.

Variables réservées au serveur, à configurer séparément pour chaque environnement :

- SCOLARIS : `AMY_SCOLARIS_SECRET` et éventuellement `AMY_SCOLARIS_URL` (par défaut `https://amyia.tech/api/integrations/scolaris/assist`).
- AMY : `SCOLARIS_INTEGRATION_SECRET`, identique au secret de cet environnement SCOLARIS.

Utiliser au moins 32 caractères aléatoires. Ne pas réutiliser une clé de fournisseur IA ou le secret d’une autre application. En l’absence de configuration, l’assistante indique son indisponibilité ; aucune réponse fictive n’est affichée.

AMY réutilise son fournisseur et son modèle configurés. Limites durables : 20 requêtes par utilisateur sur une fenêtre d’une heure, 50 par établissement sur 24 heures et 500 pour l’intégration sur 24 heures. Une indisponibilité du compteur bloque l’appel IA. Réponse limitée à 1 600 tokens et appel modèle limité à 25 secondes.

## Données et exploitation

Les identifiants établissement et utilisateur envoyés à AMY sont pseudonymisés par HMAC. La conversation est limitée aux quatre derniers messages, en mémoire dans la page ; elle n’est pas persistée dans SCOLARIS. Les requêtes contiennent néanmoins le texte saisi par l’utilisateur : ne pas y copier de données personnelles inutiles.

Le journal SCOLARIS conserve une action `amy.consulted` sans question ni réponse. Les réponses et les erreurs HTTP ne sont pas mises en cache. Le rendu utilise du texte, sans HTML généré exécuté. Aucun secret n’est inscrit dans le dépôt ou dans le navigateur.

Pour désactiver AMY, retirer la variable `AMY_SCOLARIS_SECRET` de l’environnement concerné et redéployer. Les autres modules restent utilisables.

## Validation

Tests unitaires : droits, contexte plateforme, usurpation de contexte refusée, corps bornés, identifiants pseudonymisés, échecs/quota et absence de fuite de secret. Le scénario PostgreSQL vérifie les totaux par rapport au tableau de bord et la séparation entre deux établissements. L’API AMY teste également l’authentification dédiée, les trois quotas et le refus des réponses de démonstration.

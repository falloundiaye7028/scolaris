# Migration de sécurité des sessions

La migration est additive et idempotente. Elle est contenue dans `api/src/schema.sql` et ajoute notamment :

- `users.is_platform_admin`, marqueur explicite de super-administration ;
- `sessions`, registre des sessions opaques, expirables, limitées et révocables ;
- `login_attempts`, limitation persistante des tentatives de connexion ;
- les marqueurs d'activation des comptes et de changement de mot de passe ;
- les jetons de récupération, la MFA, les codes de secours et les événements de sécurité ;
- les compteurs de fréquence d'import.

## Déploiement

1. Sauvegarder la base PostgreSQL.
2. Configurer `DATABASE_URL`, `JWT_SECRET` (32 caractères minimum) et `CRON_SECRET`. L'ancien nom `JWT_SECRET` est conservé pour compatibilité ; il sert désormais aussi de clé HMAC des jetons opaques.
3. Exécuter `npm --prefix api run migrate` une seule fois avant de basculer le trafic.
4. Déployer simultanément l'API et le frontend. Les anciennes sessions JWT en cookie sont acceptées une seule fois puis remplacées par un identifiant opaque. Les anciens jetons `localStorage` ne sont jamais acceptés.
5. Vérifier une connexion puis une déconnexion. Supprimer manuellement les anciennes clés `scolaris_token`, `scolaris_user` et `scolaris_school` du stockage local lors de la recette si un navigateur les possède encore ; le nouveau code ne les lit jamais.

Au premier passage, le plus ancien utilisateur existant reçoit `is_platform_admin=true` uniquement si aucun compte ne porte encore ce marqueur. Vérifier cette attribution directement en base avant l'ouverture au public. Conserver `MFA_ENFORCEMENT=off` jusqu'à la validation complète de l'enrôlement, des codes de secours et de la récupération.

## Retour arrière

Un retour arrière du code ne nécessite et ne doit effectuer aucune suppression de données. Redéployer l'artefact applicatif précédent et conserver les colonnes/tables additives. Les sessions opaques créées par la nouvelle version ne seront pas comprises par l'ancienne version : planifier une reconnexion contrôlée ou révoquer uniquement les sessions après validation humaine.

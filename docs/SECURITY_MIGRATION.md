# Migration de sécurité des sessions

La migration est additive et idempotente. Elle est contenue dans `api/src/schema.sql` et ajoute :

- `users.is_platform_admin`, marqueur explicite de super-administration ;
- `sessions`, registre des sessions expirables et révocables ;
- `login_attempts`, limitation persistante des tentatives de connexion.

## Déploiement

1. Sauvegarder la base PostgreSQL.
2. Configurer `DATABASE_URL`, `JWT_SECRET` (32 caractères minimum) et `CRON_SECRET`.
3. Exécuter `npm --prefix api run migrate` une seule fois avant de basculer le trafic.
4. Déployer simultanément l'API et le frontend : les anciens jetons `localStorage` ne sont volontairement plus acceptés.
5. Vérifier une connexion puis une déconnexion. Supprimer manuellement les anciennes clés `scolaris_token`, `scolaris_user` et `scolaris_school` du stockage local lors de la recette si un navigateur les possède encore ; le nouveau code ne les lit jamais.

Au premier passage, le plus ancien utilisateur existant reçoit `is_platform_admin=true` uniquement si aucun compte ne porte encore ce marqueur. Vérifier cette attribution directement en base avant l'ouverture au public.

## Retour arrière

Un retour arrière du code ne nécessite aucune suppression de données. Pour retirer également les ajouts de schéma après restauration de l'ancienne version :

```sql
BEGIN;
DROP TABLE IF EXISTS login_attempts;
DROP TABLE IF EXISTS sessions;
ALTER TABLE users DROP COLUMN IF EXISTS is_platform_admin;
COMMIT;
```

Cette opération révoque toutes les nouvelles sessions. Elle ne modifie ni les élèves, ni les échéances, ni les paiements.

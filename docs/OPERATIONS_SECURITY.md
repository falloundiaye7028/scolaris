# Exploitation, sauvegardes et surveillance

## Blocages avant données réelles

La mise en production commerciale avec des données réelles n'est autorisée qu'après validation des informations de `config/legal-requirements.json`, des contrats de sous-traitance et des obligations applicables auprès de la CDP sénégalaise par les responsables compétents. L'état et la base de la validation courante sont consignés dans ce fichier de configuration ; les justificatifs restent conservés hors du dépôt.

Les environnements Vercel Preview et Production doivent utiliser des bases PostgreSQL différentes. Une préversion ne doit jamais exécuter de migration, de test de connexion ou de parcours métier sur la base de production.

## Sauvegardes et reprise

- Activer chez le fournisseur PostgreSQL des sauvegardes automatiques chiffrées et une copie séparée du projet principal.
- Restreindre la lecture/restauration à deux responsables nommément habilités et protéger leurs comptes par MFA.
- Proposition à valider juridiquement : sauvegardes quotidiennes conservées 30 jours et mensuelles conservées 12 mois.
- Objectifs proposés, non garantis tant qu'ils ne sont pas testés : RPO maximal de 24 heures et RTO maximal de 8 heures.
- Exécuter chaque trimestre une restauration dans une base isolée dont le nom contient `restore_test`. Vérifier le schéma, les contraintes, les volumes par table et un échantillon fonctionnel sans exporter de données personnelles.
- Conserver le résultat daté, l'identifiant de sauvegarde, la durée et les contrôles d'intégrité. Ne jamais enregistrer la chaîne de connexion.

Procédure : geler les écritures, identifier le point de restauration approuvé, restaurer dans un environnement isolé, vérifier l'intégrité, faire valider la bascule, modifier uniquement les références d'environnement approuvées, surveiller, puis lever le gel. En cas d'échec, revenir à l'instance intacte et conserver les journaux techniques expurgés.

## Événements et alertes

`security_events` enregistre des identifiants techniques et des métadonnées minimales : connexions, MFA, réauthentifications, révocations, refus d'autorisation, imports, exports, paiements et opérations plateforme. Les adresses et agents utilisateurs sont hachés par HMAC ; aucun mot de passe, cookie, jeton, secret MFA, chaîne de connexion ou dossier complet n'est journalisé.

Configurer un collecteur approuvé et des alertes sur :

- cinq échecs sur un compte, quinze sur un appareil ou trente sur une adresse dans l'heure ;
- tout événement `critical` ;
- exports proches de 5 000 lignes ou répétitifs ;
- refus d'autorisation répétés ;
- hausse des réponses 5xx ;
- échec du contrôle `/api/health`.

Un ordonnanceur approuvé peut appeler `/api/cron/security-alerts` toutes les 15 minutes avec `CRON_SECRET`. L'endpoint n'envoie au webhook HTTPS configuré que des agrégats par type, sévérité et résultat. La surveillance de disponibilité de `/api/health` doit être réalisée depuis un service externe afin de détecter aussi une panne complète de Vercel.

Proposition de conservation à faire valider : 180 jours pour les événements de sécurité et 30 jours pour les journaux techniques. Chiffrer, restreindre l'accès, rendre l'export traçable et supprimer selon la politique validée.

## Réponse à incident

1. Qualifier l'incident sans partager de données personnelles sur un canal non approuvé.
2. Préserver les preuves, l'horodatage UTC et les journaux expurgés.
3. Révoquer les sessions ou désactiver les comptes concernés ; ne pas modifier les secrets sans décision du responsable d'incident.
4. Isoler l'environnement si l'intégrité est incertaine et restaurer selon la procédure testée.
5. Évaluer les obligations de notification, notamment auprès de la CDP et des établissements concernés.
6. Documenter cause, portée, correction, décision de reprise et actions préventives.

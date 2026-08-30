# SCOLARIS PAY

Plateforme scolaire multi-établissements pour le suivi des élèves, échéances, paiements et impayés.

## Commandes

```bash
npm run lint
npm test
npm run build
npm --prefix api run migrate
```

Le frontend public se lance avec `npm --prefix web run dev`. L'API nécessite PostgreSQL et les variables décrites dans `.env.example`.

Les tests d'intégration PostgreSQL (connexion, limitation, expiration, révocation, RBAC et isolation) s'activent avec `TEST_DATABASE_URL`. Cette variable doit impérativement cibler une base dédiée dont le nom contient `test` ; son schéma public est recréé pendant le test.

## Sécurité

- sessions JWT de huit heures conservées dans un cookie `HttpOnly`, `Secure` en production et `SameSite=Lax` ;
- sessions enregistrées en base, renouvelables et révocables par déconnexion ;
- limitation persistante des connexions après cinq échecs ;
- rôles et permissions vérifiés côté serveur ;
- toutes les requêtes scolaires filtrées par `school_id` ;
- exports CSV protégés contre les formules et imports limités/validés ;
- vitrine, connexion et application privée servies sur des routes distinctes ;
- CSP, en-têtes de sécurité, `robots.txt` et `sitemap.xml` configurés.

Voir `docs/SECURITY_MIGRATION.md` avant tout déploiement. Ne jamais enregistrer de secret, mot de passe ou donnée scolaire dans les logs.

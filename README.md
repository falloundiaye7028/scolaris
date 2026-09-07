# SCOLARIS PAY

Plateforme scolaire multi-établissements pour le suivi des élèves, échéances, paiements et impayés.

## Commandes

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run security:secrets
npm run security:audit
npm --prefix api run migrate
```

## Politique de toolchain

Les champs `engines` décrivent uniquement la compatibilité du runtime managé : Node `>=24.19.0 <25` et npm `>=11.17.0 <12`. Ils interdisent notamment toute adoption automatique de Node 25.

Le contrôle de référence reste indépendant et fail-closed : `SCOLARIS_TOOLCHAIN_MODE=strict` exige exactement Node `24.20.0` et npm `11.19.1` en développement contrôlé, CI et tests de release. Vercel utilise explicitement `SCOLARIS_TOOLCHAIN_MODE=vercel` dans ses commandes versionnées d’installation et de build, accepte son runtime Node 24 managé dans la plage approuvée, puis installe obligatoirement npm `11.19.1` avant `npm ci`. Un mode absent ou inconnu est refusé.

Le frontend public se lance avec `npm --prefix web run dev`. L'API nécessite PostgreSQL et les variables décrites dans `.env.example`.

Les tests d'intégration PostgreSQL (connexion, limitation, expiration, révocation, RBAC et isolation) s'activent avec `TEST_DATABASE_URL`. Cette variable doit impérativement cibler une base dédiée dont le nom contient `test` ; son schéma public est recréé pendant le test.

## Sécurité

- identifiants de session opaques et aléatoires, stockés uniquement sous forme HMAC en base ;
- cookies `HttpOnly`, `Secure` en production, `SameSite=Lax`, inactivité de 30 minutes et plafond absolu de huit heures ;
- cinq sessions actives maximum, affichables et révocables ;
- migration progressive bcrypt vers Argon2id après une connexion valide ;
- limitation persistante et progressive par compte, adresse IP et appareil ;
- MFA TOTP chiffrée et codes de récupération à usage unique, derrière `MFA_ENFORCEMENT=off` par défaut ;
- rôles et permissions vérifiés côté serveur ;
- toutes les requêtes scolaires filtrées par `school_id` ;
- exports CSV protégés contre les formules et imports limités/validés ;
- vitrine, connexion et application privée servies sur des routes distinctes ;
- CSP, en-têtes de sécurité, `robots.txt` et `sitemap.xml` configurés.

Voir `docs/SECURITY_MIGRATION.md`, `docs/OPERATIONS_SECURITY.md` et `docs/DEPLOYMENT_CHECKLIST.md` avant tout déploiement. Ne jamais enregistrer de secret, mot de passe ou donnée scolaire dans les logs.

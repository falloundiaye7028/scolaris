# Réindexation publique

1. Déployer la page d'accueil avec le canonical public, le PNG Open Graph 1200×630 et les métadonnées Twitter.
2. Vérifier que `robots.txt` et `sitemap.xml` n'incluent que les pages publiques et excluent `/connexion`, `/app`, `/admin` et `/api/`.
3. Dans Google Search Console, inspecter `https://www.scolarispay.online/`, demander une indexation et soumettre `https://www.scolarispay.online/sitemap.xml`.
4. Demander la suppression temporaire de l'ancien résultat « SCOLARIS PAY — Administration » uniquement si l'ancienne URL reste affichée après recrawl.
5. Contrôler après quelques jours que le titre public remplace l'ancien résultat et qu'aucune route privée n'est indexée.

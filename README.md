# Octopus Intelligence — Directeur Qualité Virtuel

Outil d'analyse HACCP & Business Review pour groupes de restauration.

## Setup local

```bash
npm install
node server.js
```

Open http://localhost:3001

## Variables d'environnement

| Variable | Description |
|---|---|
| `GROUP_TOKEN` | Token groupe Octopus HACCP |
| `PORT` | Port serveur (défaut: 3001) |

## Déploiement Vercel

1. Push sur GitHub
2. Importer dans Vercel
3. Ajouter `GROUP_TOKEN` dans les variables d'environnement Vercel
4. Deploy

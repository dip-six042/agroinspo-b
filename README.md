# Agro Inspo backend

Node API for Agro Inspo. It uses Node’s built-in SQLite (`node:sqlite`) and has no packages to install.

The site lives in a separate repo: [agroinspo-f](https://github.com/dip-six042/agroinspo-f).

## Run locally

Node.js 22.13 or newer.

```bash
cp .env.example .env
npm run seed
npm start
```

The API listens on http://localhost:8787. `npm run dev` restarts it when files change.

`npm run seed` is safe to run again. Existing demo accounts are left in place, and specialist portrait paths are updated.

Demo password for every seeded account: `agroinspo-demo-2026`.

| Email | Role |
| --- | --- |
| `admin@agroinspo.test`, `finance@agroinspo.test` | Admins |
| `olayinka@agroinspo.test` | Farmer |
| `tunde@agroinspo.test` | Enthusiast |
| `folashade@agroinspo.test`, `danladi@agroinspo.test`, `lawal@agroinspo.test`, `chioma@agroinspo.test` | Specialists |
| `agriflow@agroinspo.test` | Verified business |
| `sahel@agroinspo.test` | Business waiting for verification |
| `kemi@agroinspo.test` | Sales staff |

## Scripts

| Command | What it does |
| --- | --- |
| `npm start` | Start the API |
| `npm run dev` | Start with file watching |
| `npm run seed` | Load demo accounts and sample data |
| `npm test` | API integration tests |

## What stays local

`.env`, `data/` (the SQLite database and private uploads), and `node_modules/` are git-ignored. Copy `.env.example` when setting up a new machine. Set `NODE_ENV=production` before deploying so development verification links and `/api/dev/outbox` stay off.

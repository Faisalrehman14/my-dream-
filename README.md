# PageChat Hub

**Professional Facebook Page Messenger manager** with separate **User Portal** and **Admin Portal**.

| Portal | URL | Purpose |
|---|---|---|
| Landing | `/` | Marketing site, features, legal links |
| User Portal | `/portal.html` | Inbox, engagement, notifications, settings |
| Admin Portal | `/admin.html` | Meta App Review, testing, submission readiness |

---

## User Portal Features

| Permission | Feature |
|---|---|
| `public_profile` | Sign-in & user identity |
| `pages_show_list` | Page picker — switch between managed Pages |
| `pages_messaging` | **Inbox** — read threads & reply to customers |
| `pages_read_engagement` | **Engagement** — posts, likes, comments, shares |
| `pages_utility_messaging` | **Notifications** — order/shipping/account alerts |
| `pages_manage_metadata` | **Settings** — webhook subscription |

---

## Admin Portal

Restricted area for app owners. Set `ADMIN_ACCESS_KEY` in Railway/server env.

- Submission readiness score & blockers
- Meta App Review checklist & permission answers
- API test runner for Meta Testing tab
- URLs, test instructions, webhook config

---

## Run locally

```bash
cd server && cp .env.example .env
npm install && npm start
# → http://localhost:3000
```

Or frontend only:

```bash
python3 -m http.server 8080
```

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `FACEBOOK_APP_ID` | Yes | Meta App ID |
| `VERIFY_TOKEN` | Webhook | Meta webhook verify token |
| `APP_SECRET` | Webhook | Meta app secret for signature verification |
| `ADMIN_ACCESS_KEY` | Admin | Password for admin portal access |

---

## Project structure

```
├── index.html          # Landing page
├── portal.html         # End-user dashboard
├── admin.html          # Admin control center
├── css/style.css
├── js/
│   ├── portal.js       # User portal logic
│   ├── admin-app.js    # Admin portal logic
│   ├── inbox.js
│   ├── engagement.js
│   └── ...
└── server/             # Express + webhook + env injection
```

---

## Deploy

Deploy `server/` to Railway/Render. Set all env variables. OAuth redirect should match your domain (e.g. `https://yourapp.com/portal.html`).

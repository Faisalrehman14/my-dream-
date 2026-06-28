# Meta App Review — Permissions Approval Guide (Urdu + English)

Yeh guide tumhein **5 permissions** approve karwane ke liye hai:

- `public_profile`
- `pages_show_list`
- `pages_messaging`
- `pages_read_engagement`
- `pages_utility_messaging`
- `pages_manage_metadata`

---

## Pehle yeh complete karo (warna reject ho jata hai)

### 1. Railway / HTTPS URL
- App live ho: `https://YOUR-APP.up.railway.app/`
- `/health` open ho
- `FACEBOOK_APP_ID` Railway Variables mein set ho

### 2. Meta App → Settings → Basic
| Field | Value |
|-------|--------|
| Privacy Policy URL | `https://YOUR-URL/privacy.html` |
| Terms of Service URL | `https://YOUR-URL/terms.html` |
| User data deletion | `https://YOUR-URL/data-deletion.html` |
| App Domains | `your-app.up.railway.app` |
| Site URL | `https://YOUR-URL/` |

### 3. Facebook Login → Settings
**Valid OAuth Redirect URIs** (Strict Mode ON — add all three):
```
https://YOUR-URL/
https://YOUR-URL/portal.html
https://YOUR-URL/admin.html
```

**Allowed Domains for the JavaScript SDK:**
```
your-app.up.railway.app
```
(without `https://`)

### 4. Messenger → Settings
- Apni **Facebook Page** connect karo
- **Webhooks** → Callback: `https://YOUR-URL/webhook`
- Verify token = Railway `VERIFY_TOKEN`
- Subscribe: `messages`, `messaging_postbacks`

### 5. Test user tayyar karo
1. Test user se apni **Page** par Messenger message karwao (inbox ke liye zaroori)
2. Meta → **App Roles** → test account **Administrator** ya **Tester**
3. Page par kam se kam **1 post** ho (engagement ke liye)

---

## App Review submit kaise karein

### Step A — Permissions add karo
**App Review → Permissions and Features** → wohi 5 permissions jo screenshot mein thi.

### Step B — Har permission ka answer (copy from app)

App login karo → **Settings** → har permission ke neeche **Copy answer** dabao.

Ya yahan se copy karo:

#### public_profile
> PageChat Hub uses public_profile only to display the signed-in user's name and profile picture in the dashboard sidebar after Facebook Login, so Page managers can confirm they are using the correct account.

#### pages_show_list
> PageChat Hub uses pages_show_list to display a dropdown of Facebook Pages the user manages. The user selects which Page inbox and engagement data to view.

#### pages_messaging
> PageChat Hub uses pages_messaging to provide a unified Messenger inbox for Facebook Page customer support. Users read conversations and send replies from our Inbox screen.

#### pages_read_engagement
> PageChat Hub uses pages_read_engagement to show Page posts with like counts, comment counts, and shares on the Engagement screen.

#### pages_utility_messaging
> PageChat Hub uses pages_utility_messaging to send transactional messages (order updates, shipping, appointments) to customers who already messaged the Page.

#### pages_manage_metadata
> PageChat Hub uses pages_manage_metadata so users can subscribe their Page to Messenger webhooks in Settings, enabling real-time customer message notifications.

### Step C — Screencast video (2–4 min)

**Recording mode URL (admin only — clean Engagement UI for Meta screencast):**

Open from **Admin → App Review → Open screencast mode**, or use:
```
https://YOUR-URL/portal.html?review=1&view=engagement&guide=1
```
Yeh URL sirf admin ke liye hai — normal users ko portal par nahi dikhta.

Record karo — **English** mein bolna better hai (Settings → Meta App Review → Copy script):

1. Website URL kholo
2. Connect with Facebook → login → **sari permissions Allow**
3. Sidebar — name/photo dikhao (`public_profile`)
4. Page dropdown dikhao (`pages_show_list`)
5. **Inbox** → conversation kholo → reply bhejo (`pages_messaging`)
6. **Engagement** → posts + likes/comments (`pages_read_engagement`)
7. **Utility** → customer select → message send (`pages_utility_messaging`)
8. **Settings** → Subscribe Page to webhooks (`pages_manage_metadata`)

### Step D — Test instructions

App → Settings → **Copy for Meta submission** — Meta form mein paste karo.

Test email/password apna likhna mat bhoolna.

### Step E — Business verification

Kuch permissions ke liye Meta **Business Verification** mangti hai:
- Business Manager mein business verify karo
- Legal business name, website, documents

### Step F — App Live karo

Jab permissions **Approved** hon:
**App Mode** switch: Development → **Live**

Tab **koi bhi user** Connect with Facebook kar sakta hai.

---

## Reject hone par common fixes

| Problem | Fix |
|---------|-----|
| App URL not working | Railway redeploy, HTTPS check |
| Cannot test messaging | Test user ne Page ko message kiya ho |
| Use case unclear | Screencast mein har permission clearly dikhao |
| Privacy missing | 3 URLs: privacy, terms, data-deletion |
| Utility messaging fail | Customer pehle Page ko message kare |

---

## Checklist before Submit

- [ ] Railway live URL
- [ ] FACEBOOK_APP_ID set
- [ ] OAuth redirect URL added
- [ ] Privacy + Terms + Data deletion URLs in Meta Basic settings
- [ ] Page connected to app
- [ ] Webhook verified (green check in Meta)
- [ ] Test user messaged the Page
- [ ] Screencast recorded
- [ ] Test instructions pasted with credentials
- [ ] Each permission answer pasted in review form

**Permissions Meta khud approve karti hai — yeh app sirf sahi tarah demonstrate karti hai. Follow this guide exactly.**

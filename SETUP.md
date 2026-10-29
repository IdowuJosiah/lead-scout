# Setting up the automatic agent

Once this is set up, nothing needs a terminal:

- **Every Monday morning**, GitHub runs the agent. It finds new brands, audits their sites, finds and verifies emails (within your free monthly credits), and drafts an email or WhatsApp message for each lead.
- **You open the dashboard** on your phone or laptop, read and edit the emails, and tap **Approve**.
- **GitHub sends the approved emails** from your Zoho mailbox, a few minutes apart, Mon–Fri 9:00–17:00 Lagos time, at most 25 a day.
- **WhatsApp is one tap per lead.** The dashboard opens WhatsApp with the message already typed, and you press send. WhatsApp bans numbers that send automated cold messages, so this part stays manual.
- **Replies, "stop" answers and bounces** are read from your mailbox on every run. Those brands are never contacted again.

Setup takes about 30 minutes, and you only do it once.

---

## 1. Zoho Mail: the mailbox that sends

1. Use a mailbox on **your own domain**, ideally a separate one just for outreach (e.g. `hello@yourstudio.ng`). Zoho's free plan supports custom domains.
2. While adding the domain, Zoho walks you through **SPF and DKIM** DNS records. Don't skip these: without them, your emails land in spam.
3. Turn on IMAP so the agent can read replies: Zoho Mail → **Settings → Mail Accounts → IMAP Access → enable**.
4. Create an **app password** for the agent: Zoho Accounts → **Security → App Passwords → Generate**. Use it instead of your normal password. It's required if you use two-factor login, and safer anyway.
5. Note which Zoho region you're on. Accounts at `zoho.com` use the defaults. If yours is `zoho.eu`, `zoho.in` and so on, you'll set the hosts in step 3.

**New domains:** set `daily_email_limit` to about 10 for the first two weeks (step 2), then raise it. A brand-new domain sending 25 cold emails on day one looks like spam.

## 2. Your details and message wording

On GitHub, open your `lead-scout` repo → `config/outreach.json` → the pencil icon (Edit):

- `sender.name`: your name. **This is required**: nothing is drafted until it's set.
- `sender.business`, `sender.website`, `sender.phone`: optional; they're added to the signature.
- `limits`: daily email limit, batch size, and your monthly Hunter/ZeroBounce credits.
- `email` / `whatsapp` / `issues`: every phrase the agent uses. Edit freely. `{brand}`, `{domain}` and the other placeholders are filled only with facts the audit measured. If you mistype one, the run stops and tells you.

Click **Commit changes**. Also check `config/region.json`, especially `allowed_to_email` and `legal_basis`.

## 3. GitHub secrets: your keys, stored privately

Repo → **Settings → Secrets and variables → Actions**.

**Secrets** tab → **New repository secret**, one for each:

| Name | Value |
|---|---|
| `GOOGLE_PLACES_API_KEY` | your Google key |
| `HUNTER_API_KEY` | your Hunter key |
| `ZEROBOUNCE_API_KEY` | your ZeroBounce key |
| `SMTP_USER` | your Zoho address, e.g. `hello@yourstudio.ng` |
| `SMTP_PASS` | the Zoho **app password** from step 1 |

**Variables** tab, only if you're not on `zoho.com`:

| Name | Value (example for zoho.eu) |
|---|---|
| `SMTP_HOST` | `smtp.zoho.eu` |
| `IMAP_HOST` | `imap.zoho.eu` |

## 4. First run

Repo → **Actions** tab → **Weekly lead run** → **Run workflow** → **Run workflow**.

The first run starts with an empty database, so it searches Google again (about 18 Places requests) and audits every site, which takes 30–90 minutes. When it's done, a branch called `agent-data` appears; that's where the agent keeps its state. Don't edit it by hand.

If GitHub asks you to enable workflows on the Actions tab, click enable.

## 5. A token for the dashboard

The dashboard reads the agent's state and records your clicks through a limited GitHub token.

1. Go to https://github.com/settings/personal-access-tokens/new (fine-grained token).
2. **Repository access**: Only select repositories → `lead-scout`.
3. **Permissions → Repository permissions**:
   - **Contents**: Read and write
   - **Actions**: Read and write
4. Set an expiry (e.g. 1 year), generate it, and copy the token.

## 6. Dashboard on Vercel

1. https://vercel.com/new → import the `lead-scout` repo.
2. **Root Directory**: `dashboard` (click Edit next to it). The framework is detected as Next.js.
3. **Environment Variables**:

   | Name | Value |
   |---|---|
   | `DASHBOARD_PASSWORD` | the password you'll sign in with; make it long |
   | `SESSION_SECRET` | a long random string (e.g. mash the keyboard for 40+ characters) |
   | `GITHUB_REPO` | `IdowuJosiah/lead-scout` |
   | `GITHUB_TOKEN` | the token from step 5 |

4. **Deploy**, then open the URL and sign in. Add it to your phone's home screen for one-tap access.

## Using it

- **Monday, after the weekly run:** open **Approve emails**, read each email, edit or untick any, and tap **Approve ticked emails**. Sending starts right away (inside the window), a few minutes apart, and continues hourly until the batch is done.
- **WhatsApp:** tap **Open in WhatsApp**, press send in WhatsApp, come back and tap **I sent it**.
- **Replies:** answer them from your own mail app. The dashboard shows who replied, who asked to stop, and what bounced.
- **Never contact:** removes a brand from all future outreach.

## What it costs

| | Cost |
|---|---|
| GitHub Actions | free (this uses roughly a third of the free monthly minutes) |
| Vercel | free (Hobby plan) |
| Google Places | about 18 requests a week; inside Google's free usage |
| Hunter / ZeroBounce | free plans; the agent never goes over the monthly limits in `config/outreach.json` |
| Zoho Mail | free plan, or a paid plan for more mailboxes |

## Good to know

- **The agent never invents facts.** Each message only mentions issues the audit measured, and you approve every email before it goes out.
- **The daily and monthly limits are hard caps.** A run that hits one stops and continues next time.
- **The schedules are in UTC, set for Lagos** (UTC+1): Monday 06:41, and sending hourly 09:07–16:07 on weekdays. If you change cities or timezones, adjust the `cron` lines in `.github/workflows/weekly.yml` and `send.yml`. The agent still checks `send_window` itself, so it never sends outside it.
- **GitHub pauses scheduled workflows** in repos with no activity for 60 days. If that happens, the Actions tab shows a button to re-enable them.

# MediaHub bot

A self-hosted Discord bot for a Plex + Seerr + Radarr/Sonarr + Tautulli + Lidarr/Aurral + Wizarr stack. Friends request movies, shows and albums from Discord, get @-mentioned when their request is ready, report broken files or replace them themselves, and pick which announcements ping them. They can also play your music library in a voice channel. Admins get a live status board, and admins and trusted "Inviters" hand out Wizarr invites.

Two rules shape the design:

1. **The bot is a thin shell.** Seerr, Radarr, Sonarr, Lidarr, Aurral and Wizarr do all the work. If the bot is stopped, nothing in the media pipeline notices. The bot only keeps a small SQLite file: the status-board message ID, who requested what, invite nicknames, which Plex account each member linked (never their Plex sign-in), and the redownload log.
2. **No approval gates for movies and TV.** Every Discord member is trusted. Requests go to Seerr with its admin API key, so Seerr auto-approves them. There's no approval queue, admin confirmation or quota. (Self-serve *redownloads* are different: they delete files, so they have limits and an optional approve-first switch.)

## Commands

| Command | Who | What it does |
|---|---|---|
| `/request movie <query>` | everyone | Search Seerr, pick a result, and it's requested and auto-approved (Radarr takes over) |
| `/request series <query>` | everyone | Same for TV (all seasons; Sonarr takes over) |
| `/request album <query>` | everyone | Search Lidarr, then add the artist if needed, monitor the album and start a search. Falls back to Aurral |
| `/requests` | everyone | Your requests: live download progress for what's on its way, and what landed recently |
| `/report <title> <problem> <details>` | everyone | Files a Seerr issue (video, audio, subtitles…) and DMs you when it's marked fixed |
| `/music play <song/album/artist/playlist>` | everyone | Plays the library in your voice channel (autocomplete; `next:` puts it at the front) |
| `/music radio` · `queue` · `skip` · `shuffle` · `stop` | everyone | Radio mode and queue control. The now-playing card also has buttons |
| `/aurral [username]` | everyone | Your own Aurral music account: creates it and DMs you the login (works in Subsonic apps too), or shows your login if you have one |
| `/redownload start <title> <problem> [details] [season] [episode]` | everyone | Replace a broken movie, episode, whole season or album with a fresh copy. Shows the replacement first; you can pick a different copy |
| `/missing [title] [season]` | everyone | Episodes that aired but aren't on Plex, or a movie that never downloaded: pick it, and the bot finds and downloads it with a live tracker. On its own, shows your searches |
| `/redownload status` | everyone | Your live redownload tracker(s), with Refresh/Cancel buttons, and how many you have left |
| `/suggest` | everyone | Share an idea in a short form. The bot posts it in the suggestions channel (after a family-friendly check) for others to 👍, and DMs you when an admin responds |
| `/plex` | everyone | Link your Plex account with one sign-in, or see/unlink the one you linked (your Plex sign-in isn't kept) |
| `/plezy` | everyone | Posts the Plezy guide **publicly** in the current channel (for "how do I watch?" questions) |
| `/pings` | everyone | Choose which announcements @-ping you (Movies, TV, Music, Server status) |
| `/status` · `/stats` · `/random movie` · `/help` | everyone | Service check, library numbers, a random movie, a short guide to the bot |
| `/invite create [user] [name] [expiry] [uses]` | 🎟️ inviter | Creates a Wizarr invite. With `user:@someone`, the bot DMs them the link |
| `/invite list` · `/invite revoke` | 🎟️ inviter | Active invites (inviters see their own, admins all) and revoking them |
| `/invite aurral user:@x` | 🎟️ inviter | Makes an Aurral account for someone and DMs them the login |
| `/setup welcome` · `plezy` · `stats` · `nowplaying` · `pings` · `statusboard` | 🔒 admin | Posts (or moves) the welcome post, Plezy guide, stats board, now-playing board, ping panel or status board (`statusboard fresh:True` posts a new one) |
| `/setup edit post:…` · `/setup reset post:…` | 🔒 admin | Edit the welcome post or Plezy guide in a form; or restore the built-in text |
| `/setup help channel:#x` · `remove:True` | 🔒 admin | Posts the commands guide (what every member can use) as a message that stays, like the welcome post, and updates itself when commands change |
| `/setup commands-only channel:#x mode:on/off` | 🔒 admin | Members can use / commands in that channel, but anything else they type is removed (with a DM saying why) |
| `/setup channels` · `/setup links` · `/setup show` | 🔒 admin | Set channels and public links from Discord; show the current setup |
| `/admin redownloads overview` · `history [user]` | 🔒 admin | Settings, safety checks (recycling bins), what's running; recent redownloads |
| `/admin redownloads pause` · `resume` · `ban` · `unban` · `approvals` · `plexcheck` | 🔒 admin | Stop everyone or one member, require an admin to approve each redownload, or require a linked Plex account (off by default) |
| `/admin plex linked` · `/admin plex unlink user:@x` | 🔒 admin | Who's linked to which Plex account; unlink someone |
| `/admin suggestions top` · `review on/off` | 🔒 admin | Most-liked open ideas; or have every suggestion wait for an admin before it's posted |
| `/admin aurral link user:@x username:…` | 🔒 admin | Connect a member to an Aurral account they already have |

🎟️ = admins and the Inviter role. 🔒 = admins. Everything else is open to every member.

**Members never see `/setup` or `/admin` in their slash menu**: Discord only shows them to people with the *Manage Server* permission. To show them to a role without it, go to Server Settings → Integrations → the bot, and allow that role on those commands. The bot still checks the admin role itself either way. `/help` only lists what the person asking can use, grouped in plain language.

Search results and replies are ephemeral, so only the person who asked sees them and channels don't flood. A command only appears when its service is configured.

---

## 1. Discord developer portal setup

1. Go to <https://discord.com/developers/applications> → **New Application**, and give it a name.
2. **Bot** tab → **Reset Token** → copy it into `DISCORD_TOKEN`.
   Leave all three **Privileged Gateway Intents** (Presence, Server Members, Message Content) **off**. The bot uses slash commands only. It connects with the `Guilds` and `GuildMessages` intents (the second only so commands-only channels can remove messages; without Message Content it can't read them), plus the non-privileged `GuildVoiceStates` intent when music streaming is configured.
3. **Installation** or **OAuth2 → URL Generator**: choose the scopes **`bot`** and **`applications.commands`**, and these bot permissions: *View Channels, Send Messages, Embed Links, Attach Files, Read Message History, Manage Roles* (for the ping roles), *Manage Messages* (for commands-only channels), *Connect* and *Speak* (for music). Or use this URL with your Application ID (from **General Information**):

   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot%20applications.commands&permissions=271707136
   ```

   If the bot is already in your server, opening the new URL updates its permissions.

   Open it and add the bot to your server.
4. In Discord, go to **User Settings → Advanced → Developer Mode** and turn it on. Then right-click to copy IDs:
   - the server icon → **Copy Server ID** → `GUILD_ID`
   - each channel → **Copy Channel ID** → `STATUS_CHANNEL_ID`, `NOTIFY_CHANNEL_ID`, `ADMIN_CHANNEL_ID`
   - your admin role (Server Settings → Roles) → **Copy Role ID** → `ADMIN_ROLE_ID`, and the role allowed to hand out invites → `INVITER_ROLE_ID`
5. If those channels are private, give the bot's role access to them. It needs to send messages, embed links and read message history. The status channel also needs read history, because the bot edits its own board message there.
6. In **Server Settings → Roles**, drag the bot's role **above** the Movies / TV / Music / Server status roles (the bot creates them on `/setup welcome`), or it can't hand them out.

Commands are registered to your server only (`GUILD_ID`), so they show up straight away, with no hour-long global propagation.

## 2. Configure

Copy `.env.example` to `.env` and fill it in. Every variable has a comment. Leave a service's block empty and its commands and status line disappear, while everything else keeps working.

Where to find each key:

| Service | Where |
|---|---|
| Seerr | Settings → General → **API Key** |
| Plex | [Finding an authentication token](https://support.plex.tv/articles/204059436) |
| Tautulli | Settings → Web Interface → **API key** (enable the API) |
| Lidarr / Radarr / Sonarr | Settings → General → Security → **API Key** |
| Aurral | Settings → General → **API access** (the *admin* key) |
| Wizarr | Settings → **API Keys** → Create (it's shown once; copy it then). Interactive API docs are at `http://<wizarr>/api/docs/` |
| Subsonic (music) | Create a user for the bot in Aurral (Settings → Users) or Navidrome, and use its username and password |

## 3. Docker networking (the usual pitfall)

The bot calls every service from inside its container, so:

- **Never use `localhost` or `127.0.0.1`.** Inside the container that's the bot itself. The bot logs a warning if you do.
- **Use container names on a shared user-defined network**, e.g. `http://lidarr:8686`. Unraid's default `bridge` network does *not* resolve container names, so create one network and attach your containers to it:
  ```bash
  docker network create media
  # Unraid UI: edit each container → Network Type: "Custom: media"
  ```
- **Plex in host network mode?** Use the Unraid host's IP: `PLEX_URL=http://192.168.1.10:32400`.

Senders follow the same rule when they post webhooks to the bot. A container on the `media` network uses `http://mediahub-bot:8787/...`. Anything in host mode, such as Tautulli or Plex, uses `http://<unraid-ip>:8787/...`, which is why the compose file publishes port 8787.

## 4. Install on Unraid

Every push to `main` builds an image and publishes it as **`ghcr.io/nogref/mediahub-bot:latest`** (see *Publishing* below). Unraid just pulls it, with no building on the server.

**One-time: let Unraid pull the image.** The repository is private, so its package starts private too. Pick one:
- **Make the package public** (easiest; the image holds no secrets, since tokens live in Unraid's settings): GitHub → your profile → **Packages → mediahub-bot → Package settings → Change visibility → Public**.
- Or keep it private and log Unraid in once (terminal): `docker login ghcr.io -u Nogref`, with a GitHub token that has the `read:packages` scope as the password.

**Option A: Unraid template (recommended)**

1. Copy `unraid/my-mediahub-bot.xml` to the flash drive at `/boot/config/plugins/dockerMan/templates-user/my-mediahub-bot.xml` (e.g. via the `flash` share). **Keep that exact name, and make sure no other copy is in that folder** (see the box below).
2. **Docker** tab → **Add Container** → **Template** dropdown → **mediahub-bot**.
3. Fill in `DISCORD_TOKEN`, `GUILD_ID`, the channel IDs and the services you use. Leave the rest empty. Click **Show more settings** for tuning options.
4. **Network Type**: pick the same custom network as your other containers so URLs like `http://lidarr:8686` work (see section 3). On plain *bridge*, use `http://<unraid-ip>:<port>` URLs instead.
5. **Apply**. Updates arrive through Unraid's usual **Check for Updates**.

`PUID`/`PGID` default to 99/100 (nobody:users). The container fixes ownership of the appdata folder itself, so there's no manual `chown`.

> **Settings keep showing blank (or vanish after an update)?** Unraid saves your values in `templates-user/my-mediahub-bot.xml`. But when you open **Edit**, or when it applies an update, it loads the *first* file in that folder (alphabetically) whose name inside says `mediahub-bot`. An extra copy such as `mediahub-bot.xml` sorts first, so Unraid keeps loading that blank copy and rebuilds the container from it. Fix it once in the Unraid terminal:
> ```bash
> cd /boot/config/plugins/dockerMan/templates-user
> grep -l "<Name>mediahub-bot</Name>" *.xml   # should list ONLY my-mediahub-bot.xml
> rm mediahub-bot.xml                          # delete any other file it lists
> ```
> Then **Edit** the container, fill your values in once more and **Apply**. They'll stick from then on.

**Belt and braces: `bot.env`.** The bot also reads settings from `/mnt/user/appdata/mediahub-bot/bot.env` (same `NAME=value` lines as `.env.example`). Anything set in the container wins, and anything blank there is taken from the file. Keeping your settings in that file means the bot stays configured even if the template loses them, and you can edit it over the network share.

**Option B: Docker Compose** (Compose Manager plugin or the CLI)

```bash
cp .env.example .env && nano .env
docker compose up -d        # pulls ghcr.io/nogref/mediahub-bot:latest
docker logs -f mediahub-bot
```

A healthy start logs the configured services, the enabled modules, `logged in as …` and `registered N command(s)`. `GET http://<host>:8787/healthz` returns `{"ok":true,"discord":"connected"}`, and the container's Docker health check uses it too.

**After the first start**, do the rest from Discord (it's stored by the bot, so the Unraid template can stay short):

1. `/setup channels announcements:#new-stuff status:#server-status admin:#admin`
2. `/setup welcome channel:#start-here` posts the welcome post, which has a ping-settings button. Then edit it with `/setup edit post:welcome`.
3. Optional: `/setup links aurral:https://music.example.com plezy_relay:https://relay.example.com`, `/setup stats channel:#…`, `/setup nowplaying channel:#…`, `/setup plezy channel:#…`
4. `/setup show` lists everything that's set.

---

## 5. Webhooks: pointing your apps at the bot

Every sender posts JSON to:

```
http://mediahub-bot:8787/webhook/<service>?secret=<WEBHOOK_SECRET>
```

`<service>` is one of `seerr`, `tautulli`, `radarr`, `sonarr`, `lidarr` or `aurral`. Instead of `?secret=`, a sender can present the secret as an `X-Webhook-Secret: …` or `Authorization: Bearer …` header. Every setup below has a **Test** button. A test shows up as a small "webhook connected" notice in the admin channel.

Events are batched: everything that arrives within `NOTIFY_BATCH_SECONDS` (60 s) becomes **one message per channel**. One item gets a full card with its poster. Several get a single summary ("🆕 7 new additions", grouped into Movies / TV / Music, with episode runs collapsed to `S02E01–E05`). The same title reported by several apps, say Radarr and then Seerr and then Tautulli, is announced once. **Playback events are never posted.**

### Seerr (recommended: the most reliable "it's on Plex" signal)

Settings → Notifications → **Webhook**

- **Enable Agent**: on
- **Webhook URL**: `http://mediahub-bot:8787/webhook/seerr?secret=…`
- **JSON Payload**: leave the default
- **Notification Types**: **Media Available**, **Issue Created** (posted to the admin channel) and **Issue Resolved** (DMs whoever reported it with `/report`). Optionally **Media Failed** (admin channel)

### Tautulli (recently added + Plex up/down)

Settings → Notification Agents → **Add a new notification agent → Webhook**

- **Configuration** tab: Webhook URL `http://<unraid-ip>:8787/webhook/tautulli?secret=…`, Webhook Method **POST**
- **Triggers** tab: **Recently Added**, and optionally *Plex Server Down / Back Up*, *Plex Remote Access Down / Back Up* and *Plex Update Available*. Leave the playback triggers off; the bot ignores them anyway.
- **Data** tab: for **each** trigger you enabled, paste this into its **JSON Data** box:

```json
{
  "action": "{action}",
  "media_type": "{media_type}",
  "title": "{title}",
  "show_name": "{show_name}",
  "episode_name": "{episode_name}",
  "season_num": "{season_num}",
  "episode_num": "{episode_num}",
  "artist_name": "{artist_name}",
  "album_name": "{album_name}",
  "year": "{year}",
  "summary": "{summary}",
  "poster_url": "{poster_url}",
  "tmdb_id": "{themoviedb_id}",
  "tvdb_id": "{thetvdb_id}"
}
```

Posters only come through if Tautulli has an image host set (Settings → 3rd Party APIs → **Image Hosting**). Otherwise announcements just have no picture. To test, send `{"action": "test"}` from the agent's **Test Notifications** tab.

### Radarr and Sonarr (optional)

Settings → Connect → **+ → Webhook**: URL `http://mediahub-bot:8787/webhook/radarr?secret=…` (or `/sonarr`), Method **POST**. Turn on:

- **On File Import** (older versions call it *On Import* / *On Download*). Upgrades are skipped.
- **On Health Issue**, **On Health Restored** and **On Manual Interaction Required** go to the admin channel.

Imports are announced, but they don't @-mention the requester, because a file on disk isn't necessarily on Plex yet. The ping comes from Seerr, Tautulli or the request tracker once Plex has the item. If you already use the Seerr or Tautulli webhooks you can skip these, unless you want the faster announcement or the health alerts.

### Lidarr

Settings → Connect → **+ → Webhook**: URL `http://mediahub-bot:8787/webhook/lidarr?secret=…`, Method **POST**. Turn on:

- **On Release Import**. This announces the album and pings whoever requested it, because Aurral and Navidrome index the same music folder.
- Optionally **On Health Issue**, **On Health Restored**, **On Download Failure** and **On Import Failure**, which go to the admin channel.

### Aurral

Settings → Notifications → Webhooks → **Add**

- **URL**: `http://mediahub-bot:8787/webhook/aurral?secret=…`
- **Body** (a body makes Aurral send a POST):
  ```json
  {"event":"$event","artist":"$artistName","album":"$albumName","title":"$title","message":"$message"}
  ```
- **Events**: **Request available**. The bot ignores the others (track added, flows, discovery, artist added), so leave them off.
- Use **Send test** to check it.

### Wizarr

Wizarr doesn't post to the bot. The bot calls Wizarr's REST API with `WIZARR_URL` and `WIZARR_API_KEY`, which you create under Wizarr → Settings → **API Keys**. Set `WIZARR_PUBLIC_URL` to the address your friends open, so invite links work outside your network.

---

## How the "@ you when it's ready" ping works

- When someone uses `/request`, the bot records it, including when the title was *already requested* by someone else; that person gets pinged too.
- A ping goes to `NOTIFY_CHANNEL_ID` when a **confirming** event arrives. These are: Seerr *Media Available*, Tautulli *Recently Added* for a movie, show, season or album, Lidarr *Release Import*, and Aurral *Request available*. Single episodes never count as a finished series request.
- **Safety net:** every `REQUEST_RECONCILE_MINUTES` (10), the bot asks Seerr, Lidarr or Aurral directly whether pending requests are now available. That catches webhooks you never set up and ones that fired while the bot was down. Webhooks are just the fast path.
- After `REQUEST_TRACK_DAYS` (30) the bot stops waiting.
- To make requests show under each person's own name in Seerr, they add their Discord user ID in Seerr → Profile → Settings → Notifications. Requests are auto-approved either way.

## Status board

- On startup, the bot finds its board message in `STATUS_CHANNEL_ID`, or posts one if it's gone, and checks every configured service every 60 s. Each service gets a line with ✅ or ❌ and its latency in ms. A service only appears if it's configured.
- The colour is **green** when everything is up, **yellow** when something is slow (over `STATUS_SLOW_MS`) or just failed one check, and **red** when something is down.
- A service counts as *down* after `STATUS_FAIL_THRESHOLD` (2) failed checks in a row, so one blip doesn't trigger alerts. Going down or recovering posts a one-time heads-up in the status channel, e.g. "🔴 Lidarr is down (timeout)" or "🟢 Lidarr is back up (was down for 14 min)". Up/down state is stored, so a restart neither repeats nor misses a transition.
- **Rate limits:** the message is only edited when a service's state changes. When nothing changed, latencies and the timestamp refresh at most every `STATUS_REFRESH_MINUTES` (5).
- The message ID survives restarts (`/data/bot.db`). `/setup statusboard fresh:True` posts a new board and marks the old one as moved.

## Invites (Wizarr)

The bot only creates, lists and revokes invite links. Your friend opens the link and finishes Wizarr's own onboarding wizard in the browser.

- **Who:** admins, plus anyone with `INVITER_ROLE_ID`.
- **Inviter guardrails:** inviters' links are always single use and expire after at most `INVITER_EXPIRY_DAYS` (7). Each inviter can have at most `INVITER_MAX_ACTIVE` (3) active at once, and they only see and revoke their own. Admins have no limits and see everything, including who created each invite and who it's for.
- **`/invite create user:@bob`** DMs Bob the link with a short "here's how to join" note, and names the invite "bob" unless you give a `name`. If Bob has DMs from server members turned off, you get the link to pass along instead.
- **Names are bot-side nicknames.** Wizarr identifies invites by code, so the bot stores nickname ↔ code. `/invite revoke` accepts either, with autocomplete.
- **Expiry** can be 1 day, 7 days, 30 days or never, and **uses** can be single or unlimited. Those are the only options Wizarr's API has.
- Invites go to `WIZARR_SERVER_IDS` if set, otherwise to every verified Plex server in Wizarr.
- Every create and revoke is logged in the admin channel. Links themselves are never posted there.

## Ping settings

Four roles decide who gets @-pinged. They don't lock anything: requests, music and Aurral are open to everyone regardless.

| Role | Pings you for |
|---|---|
| 🎬 Movies | New movies |
| 📺 TV | New episodes and shows |
| 🎵 Music | New albums |
| 📡 Server status | A service going down or coming back |

Members change theirs with the **🔔 Ping settings** button on the welcome post, or `/pings`. Either way they get private toggle buttons showing what's on. The bot creates the roles the first time they're needed, reusing roles with the same names or ones set via `ROLE_*_ID`. They're created mentionable so the bot can ping them without the "Mention Everyone" permission. `/setup pings channel:#…` posts a standalone panel if you want one outside the welcome post.

Opting out means *no pings*; the announcements stay visible. Requests you make yourself always ping you when they're ready. To keep album announcements out of the main channel, set a separate music channel with `/setup channels music_announcements:#…`.

## Posts and boards

All four are single messages that the bot keeps editing in place. It remembers where they are across restarts, and if one gets deleted it posts a fresh one on the next update. Place or move any of them with `/setup <name> channel:#…`.

- **Welcome post** (`/setup welcome`): what the server is and how to use it, with **🔔 Ping settings** and **📱 About Plezy** buttons. Pin it and make the channel read-only.
- **Plezy guide** (`/setup plezy`, optional): what Plezy is, why it beats the Plex app, how to start, and Download / Source buttons. **`/plezy`** posts the same guide publicly wherever it's typed, so anyone can answer "how do I watch?" in #general. A 1-minute cooldown per channel stops spam: a second `/plezy` within the minute gets a private copy instead.
- **Stats board** (`/setup stats`): the `/stats` numbers plus how much was requested from Discord this week. It's re-checked every `STATS_REFRESH_MINUTES` (30) and edited **only when a number changes**.
- **Now-playing board** (`/setup nowplaying`): see *Music streaming*.

**Editing the text.** `/setup edit post:welcome` (or `post:plezy`) opens a form pre-filled with the current text: a title and up to four sections. It's plain Discord markdown: `**bold**`, `*italics*`, bullets, links. Three tokens fill themselves in: `{server}` (server name), `{aurral}` (Aurral address from `/setup links`) and `{relay}` (your Plezy relay, or "the default" if none). Save, and the live post updates immediately. If the total goes over Discord's 6,000-character limit, your text is kept as a draft so the next `/setup edit` brings it back for trimming. `/setup reset` restores the built-in text. Posts also refresh themselves when you change links with `/setup links`.

## Aurral accounts

Aurral has no invite links, but its admin API can create users, so the bot does it:

- **`/aurral`**: makes the member's own account (username from their Discord name, or `username:` to choose) with a random password, and DMs them the address, username and password (in a spoiler). It also tells them how to change the password and how to listen in Subsonic apps, which use the same login. If their DMs are closed, the reply itself is private, so the login is shown there. One account per member; running it again just shows their username.
- **`/invite aurral user:@x`** (inviters): the same, on someone's behalf.
- **`/admin aurral link user:@x username:…`** (admin): connects someone who already had an Aurral account.
- **Forgotten passwords:** Aurral's API won't let an API key reset another user's password (it requires a recent sign-in by an admin), so an admin resets it in Aurral → Settings → Users.
- New accounts get Aurral's default permissions (Settings → Users → Default permissions).
- Set the address members see with `/setup links aurral:https://…`. Without it they get the internal address.

## `/requests` and `/report`

- **`/requests`** lists what you've asked for through the bot. For items still on the way it shows live progress: Seerr's Radarr/Sonarr download percentage and ETA, Lidarr's queue and track count, or Aurral's download state. After 3 days with nothing found it says so, instead of leaving you guessing. Below that are items that landed in the last two weeks.
- **`/report`** autocompletes titles that are in the library, takes a problem type (video, audio, subtitles, other), a description and an optional season/episode, and files a **Seerr issue** under your Seerr user if your Discord ID is linked there. Admins see it in the admin channel and handle it in Seerr as usual. When it's marked **resolved**, the reporter gets a DM, either straight away via Seerr's *Issue Resolved* webhook or within `REQUEST_RECONCILE_MINUTES` from the bot's own check. If their DMs are closed, they get a mention in the announcements channel instead.

## Self-serve redownloads

Members fix broken files themselves instead of waiting for an admin. It's built to be hard to misuse and to never leave a title worse off.

**Setup (once):**
1. Add `RADARR_API_KEY` and `SONARR_API_KEY` (Lidarr is already set up for albums).
2. In Radarr, Sonarr and Lidarr, set a **Recycling Bin**: Settings → Media Management → File Management (show advanced). Without one the apps delete files permanently, so the bot refuses to redownload anything from that app. `/admin redownloads overview` shows a ✅ per app.
3. Make a private admin channel and run `/setup channels redownload_log:#that-channel` (falls back to the admin channel).
4. Optional, for later: `/admin redownloads plexcheck on` limits redownloads to members who've run `/plex`.

**Who can use it:** every member of your Discord server (limits, bans and pause still apply). Admins always can, without limits. With `/admin redownloads plexcheck on`, only members whose linked Plex account is on your server's share list can (re-checked every 6 hours, so removing someone in Plex locks them out). `/plex` works either way; when someone has linked, the log shows their Plex username. A Plex account can only be linked to one Discord member.

**Limits:** 2 per member per rolling 24 hours (a whole season counts as 2), 48 hours before the same title can be redone, 3 running at once server-wide. Anything that ends without changing a file (no release found, all downloads failed, cancelled, denied) is refunded. All of these are in `.env.example` (`REDOWNLOAD_*`).

**What happens:**
1. The member picks the title (autocomplete across Radarr, Sonarr and Lidarr) and a problem type, plus an optional description. For TV, a season is required; leaving the episode empty means the whole season.
2. The bot runs an interactive search in the app and keeps only releases the app rejected *purely* because a file already exists. So it never picks something your quality profile doesn't want, a blocklisted release, the same release as the current file, a sample or fake (too small), or a dead torrent. Seasons only take season packs; single episodes never do. Best quality first, then custom-format score, then seeders.
3. The member sees what's on Plex now vs. the replacement, and can **Pick a different release** from the top 10.
4. The app downloads it. **The old file stays playable the whole time.**
5. When the download is finished and the app says the *only* thing stopping the import is the existing file, the bot moves just the files the new download replaces to the recycling bin (for a season, only episodes actually in the pack) and the app imports the new one.
6. The old release is blocklisted so it's never grabbed again. The member gets a DM (or a mention in the announcements channel if DMs are closed). The bot doesn't announce the fresh copy as "new on Plex".

If a download fails, imports with a different problem or takes over 24 hours, it's removed and blocklisted, and the next release is tried (3 in total). The original is untouched until step 5. If the import doesn't happen within 20 minutes after the swap, the job goes to 🆘 **needs admin**: the log pings the admin role with where the old file is (recycling bin) and how to finish it (the app's Activity → Queue → Manual Import). Jobs survive bot restarts.

**What members see:** a tracker card in their DMs that updates itself as it goes: request received → found a fresh copy (quality, size) → downloading (progress bar and time left) → swapping in → ready to watch. It says when a copy didn't work out and another is being tried, and warns that the title can vanish from Plex for a minute during the swap. It has **Refresh** and **Cancel** buttons (Cancel asks first), and when it's done they get a fresh "ready to watch" message so their phone buzzes. It never mentions Radarr, Sonarr, torrents and so on. If their DMs are closed, the reply where they started it updates for the first 15 minutes, `/redownload status` shows the same live card anytime, and the final ping goes to the announcements channel.

**The log:** one message per redownload in the log channel, edited as it goes: who (Discord + Plex username), what, the problem and description, old vs. new release and a timeline. Buttons: **Cancel** (before the swap), **Approve / Deny** (approve-first mode), **Mark resolved** (needs admin) and **Ban requester**. The apps' own "manual interaction required" / "download failed" alerts for these downloads are kept out of the admin channel, since the log already covers them.

**Admin controls:** `/admin redownloads pause [reason]` / `resume`, `ban user [reason]` / `unban`, `approvals on|off` (each redownload waits for Approve; auto-denied after 24 hours), `plexcheck on|off` (require `/plex`; off by default), `history [user]`, `overview`.

## Missing episodes and movies

`/missing` fills gaps without an admin: a season that skipped an episode, or a movie that's been "monitored" for ages but never downloaded. Nothing is ever deleted, so there's no daily limit; each request is one season or one movie.

**What members see:** they start typing a title (shows that have gaps are marked *some missing*; only movies that never downloaded are listed). For a show with gaps in several seasons, they pick the season from a menu. The card lists just the episodes that have aired but aren't on Plex (and mentions any that haven't aired yet), with **Get all** or **Choose episodes**. Then the same kind of live DM tracker as redownloads: looking → downloading (progress bar, time left) → on Plex, per episode, with Refresh and Cancel. Movies that aren't out yet, seasons with nothing missing and titles not in the library at all (use `/request`) get a friendly explanation instead.

**What it does:** it marks the chosen episodes (or the movie) monitored, then asks Sonarr/Radarr to search. A season with nothing downloaded is searched as a season pack first; whatever that doesn't cover is searched episode by episode. It follows each grab through the download queue until it's imported.

**When nothing's out there in your quality profile:** rather than leave someone with nothing, the bot runs an interactive search for those episodes (or the movie) and accepts releases rejected *only* for quality or custom-format score. Wrong language, blocklisted, wrong title, size limits and so on are never accepted, and dead torrents and samples are skipped. It prefers 1080p, then 720p, then 4K, then SD, then healthier and smaller. For a whole missing season it tries one season pack first. Anything grabbed this way:
- is posted in the log as its own message, naming each episode, the quality and the exact release;
- gets the series or movie tagged **off-profile** in Sonarr/Radarr, so you can filter for them later. The tag isn't linked to any indexer, client or profile, so it changes nothing on its own;
- shows members a quiet "(720p copy)" note, with no jargon, and their final DM says it's that quality for now.

If upgrades are allowed in that quality profile, Sonarr/Radarr will usually replace it with your normal quality when one turns up, since the episode stays monitored.

**When something can't be found:** even in other qualities, the member is told plainly, and a short message goes to the redownload log (falling back to the admin channel) listing what couldn't be got and why (no release found, download disappeared, or downloaded but won't import after 30 minutes), plus where to look in Sonarr/Radarr. Members can't search the same title again for 6 hours after that; admins can.

**Shared switches:** pause, bans, approve-first and the Plex check under `/admin redownloads` apply to `/missing` too, and `/admin redownloads overview` lists searches in progress. One search per season at a time; at most 10 at once server-wide.

## Suggestions, and a chat-free server

`/suggest` lets members share ideas without anyone typing in a channel, so you can make the whole server read-only (handy if family members use it and you don't want them seeing everyone's banter).

**How it works:** the member fills in a short form (the idea, plus optional details). The bot checks it with a family-friendly filter, then posts it in your suggestions channel with a **👍** button. Tapping 👍 again takes the vote back, and the bot tells them which one happened. Admins press **🔒 Admins** on a post to set *Looking into it*, *Done* or *Not planned* with an optional note (the member gets a DM and the post updates; voting closes once it's done or declined), or to remove it without notifying anyone. Members can share up to 3 ideas a day; admins are unlimited.

**The filter:** Discord's AutoMod doesn't check messages the bot posts, so the bot runs its own check (swearing, slurs and sexual terms, including l33t-speak like `sh1t`). Caught text is never posted: the member can **Reword it** (their text comes back filled in) or **Send to admins**, for false alarms like a title such as *Moby Dick*. Those land in the admin channel flagged ⚠️, with **Post it** / **Don't post** buttons. `/admin suggestions review on` sends *every* suggestion there first. Display names that fail the check show as "A member".

**Setup:** `/setup channels suggestions:#suggestions`.

**Making the server chat-free:**
1. Where members should use commands (e.g. #general), run `/setup commands-only channel:#general mode:on`. Members can still type, so / commands work, but anything that isn't a command is removed straight away, and they get a friendly DM saying why (at most every 6 hours; a self-deleting note in the channel if their DMs are closed). Bots, admins, the server owner, system messages and pinned messages are never removed, and nothing from before you switched it on is touched. After a restart the bot cleans up what was posted while it was offline. It needs **Manage Messages** in those channels (the reply tells you if anything's missing). Turn **Create Threads** off for @everyone there too.
   Discord briefly shows a removed message before it's gone (usually well under a second), so also do step 4: AutoMod blocks swear words before they're ever shown.
   Good combo: a #commands channel that's commands-only, with `/setup help channel:#commands` posting the commands guide there (pin it). The guide shows only what everyone can use, and updates itself when the bot gets new commands. `/setup help remove:True` takes it down.
2. Channels nobody needs to type in at all (#start-here, #announcements, #suggestions): turn **Send Messages** off for @everyone. Make sure the bot itself can **Send Messages** and **Embed Links** in the suggestions, announcements and status channels.
3. If some people do want to chat: make a "Chat" role, let only that role see a chat channel, and don't give it to the people who shouldn't see it. They won't even know the channel exists.
4. For any channel where people can still type, turn on **AutoMod** (Server Settings → AutoMod, desktop only) with the *Commonly Flagged Words* lists set to block the message. It misses mild swearing, so add your own words too.
5. Anyone who shouldn't get DMs from other members can turn off *Allow direct messages from server members* in that server's privacy settings.

## Music streaming

`/music` plays your library from a **Subsonic server** into the voice channel you're in. That can be Aurral's built-in one (the default: `SUBSONIC_URL` falls back to `AURRAL_URL`) or Navidrome.

- **Setup:** create a user for the bot in Aurral (Settings → Users) and put its credentials in `SUBSONIC_USER` / `SUBSONIC_PASSWORD`. The bot tries token auth first and switches to password auth automatically if the server needs it. A `Subsonic` line appears on the status board.
- **No transcoding in the bot:** it asks the server for Opus (`format=opus`, `MUSIC_BITRATE` kbps), which Aurral produces with its own ffmpeg. Audio goes straight into Discord, so the bot image needs no ffmpeg. Navidrome works if its Opus transcoding is enabled (it is by default).
- **Encryption:** Discord requires end-to-end encrypted voice (DAVE) for every bot since March 2026. The bundled `@discordjs/voice` handles it.
- **Using it:** join a voice channel, then `/music play` and start typing. Suggestions cover artists (plays their top songs), albums, playlists and songs.
- **Now playing for everyone:** `/setup nowplaying channel:#music` posts a public board that's edited with every song (cover art, artist, album, what's up next, which voice channel) and goes back to "Nothing playing" when the music stops. It has Pause / Skip / Radio / Queue / Stop buttons. Without a board, the same card appears in the voice channel's own text chat.
- **Who controls it:** anyone in the same voice channel, plus admins.
- **Leaving:** the bot leaves `MUSIC_IDLE_MINUTES` (5) after the queue ends or everyone leaves, and when `/music stop` is used.
- **Limits:** one voice channel at a time, and no volume command, since that would mean decoding audio in the bot. Listeners can right-click the bot to set their own volume.

---

## Adding a new handler

Each feature is one file in `src/modules/` that exports a **factory**. The factory gets the shared context (config, service clients, SQLite store, Discord client, notifier, ping roles, access checks, and an in-process event bus) and returns a `BotModule`, or `null` when what it needs isn't configured. Then the feature simply doesn't exist: no commands are registered and it never runs. `src/modules/index.ts` is the list of features. Delete a line, and its file, to remove one.

A module can contribute any of:

| Field | Purpose |
|---|---|
| `commands` | Top-level slash commands (`/stats`) |
| `subcommands` | Subcommands; several modules can share a parent (`/request movie` comes from one module, `/request album` from another) |
| `components` | Button/select handlers, keyed by the `custom_id` prefix before the first `:` |
| `routes(router)` | Express routes on the webhook server |
| `start()` / `stop()` | Timers and background work, called when Discord is ready and at shutdown |

`gate: "admin" | "inviter" | "music"` on a command restricts who can run it (checked once, centrally, before your handler runs). `/help` hides gated commands from people who can't use them. Every handler runs inside a try/catch, so a thrown error, including an `ApiError` from a timeout or a service that's down, becomes a friendly ephemeral reply instead of a crash.

### Example: `/upcoming` from Sonarr's calendar

**1. Give the service client the API call** (`src/services/simple.ts`, in `ArrClient`):

```ts
calendar(days = 7): Promise<Array<{ title: string; seasonNumber: number; episodeNumber: number; airDateUtc: string; series?: { title: string } }>> {
  const start = new Date().toISOString();
  const end = new Date(Date.now() + days * 86_400_000).toISOString();
  return request(this.name, `${this.cfg.url}/api/v3/calendar`, {
    query: { start, end, includeSeries: true },
    headers: { "X-Api-Key": this.cfg.apiKey ?? "" },
  });
}
```

**2. Write the module** (`src/modules/upcoming.ts`):

```ts
import { EmbedBuilder, MessageFlags } from "discord.js";
import { Colors, ts } from "../core/discord.js";
import type { ModuleFactory } from "../core/module.js";

export const upcoming: ModuleFactory = ({ services, cfg }) => {
  const sonarr = services.sonarr;
  if (!sonarr || !cfg.sonarr?.apiKey) return null; // feature off unless configured

  return {
    name: "upcoming",
    commands: [
      {
        name: "upcoming",
        description: "Episodes airing in the next 7 days",
        execute: async (i) => {
          await i.deferReply({ flags: MessageFlags.Ephemeral });
          const eps = await sonarr.calendar(7);
          const lines = eps.map((e) => `${ts(Date.parse(e.airDateUtc), "f")} · **${e.series?.title ?? e.title}** S${e.seasonNumber}E${e.episodeNumber}`);
          await i.editReply({ embeds: [new EmbedBuilder().setColor(Colors.info).setTitle("📅 Coming up").setDescription(lines.join("\n") || "Nothing this week.")] });
        },
      },
    ],
  };
};
```

**3. Register it** in `src/modules/index.ts`:

```ts
import { upcoming } from "./upcoming.js";
export const moduleFactories: ModuleFactory[] = [ /* … */, upcoming ];
```

Restart the bot. Commands are re-registered on every start, and `/help` lists it automatically.

### Adding a webhook source

Write a parser in `src/webhooks/<name>.ts` that turns the payload into `InboundEvent[]`, either `media` events (announcements, with `confirms: true` if the event proves the item is watchable) or `alert` events (admin notices). Then add it to `webhookParsers` in `src/webhooks/index.ts`. It's served at `/webhook/<name>` straight away, with batching, dedupe and requester mentions handled for you.

---

## Publishing (GitHub Actions)

`.github/workflows/docker.yml` runs on every push and pull request:

1. **test**: `npm ci`, the full test suite, and a check that `unraid/mediahub-bot.xml` still matches `.env.example`.
2. **image** (on `main` and `v*` tags only): builds the image, **smoke-tests it** (native modules load, the voice encryption library is present, the container drops to uid 99, and it refuses to start without config), then pushes to `ghcr.io/<owner>/mediahub-bot` with tags `latest`, the short commit SHA, and the version for `v1.2.3`-style tags.

Change `.env.example` → run `node scripts/gen-unraid-template.mjs` → commit both. The template is deliberately named `my-mediahub-bot.xml`, the same file Unraid saves your values into, so copying it in can never leave a second, blank copy behind. Unraid doesn't add new template variables to an existing container, which is one reason most new settings live in Discord (`/setup`) instead. Dependabot opens weekly PRs for npm updates, grouping discord.js packages so they stay in step.

## Development

```bash
npm install
npm test          # builds, then runs unit tests and end-to-end flows against a mock Seerr/Lidarr/Aurral/Wizarr/Plex/Subsonic
npm run build && node --env-file=.env dist/index.js
```

Set `LOG_LEVEL=debug` to see each webhook and API call. Logs mask `apikey`/`token` query parameters.

### Layout

```
src/
  index.ts              boot: config → store → clients → modules → Discord + webhook server
  config.ts             env parsing; unconfigured services become undefined
  core/                 http (timeouts, ApiError), db (SQLite), registry (commands/routing),
                        access gates, ping roles, Discord-side settings, live messages
  services/             one thin API client per service (incl. Subsonic)
  modules/              one file per feature (see table above)
  redownload/           /redownload: app adapters, release picking, limits, the job state machine
  music/                voice session (queue, playback, now-playing message)
  notify/               event types, batching notifier, embed rendering
  webhooks/             one payload parser per sender
  web/server.ts         Express: /webhook/:service, /healthz
test/                   node:test suites + mock upstream server
scripts/                Unraid template generator
unraid/                 Unraid template + icon
.github/                CI (test → build → smoke-test → push to GHCR), Dependabot
docker-entrypoint.sh    fixes /data ownership for PUID:PGID, then drops root
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| No slash commands | Open `http://<unraid-ip>:8787/healthz`: `commands.ok` says whether registration worked, and `commands.hint` says how to fix it. The container log also prints a ready-made re-invite link. Usual causes: the bot was invited without `applications.commands` (re-invite with that link), or `GUILD_ID` isn't your server's ID. On mobile, fully close and reopen Discord once after the first registration |
| "I couldn't reach Lidarr" | Container networking: use the container name on a shared network, or the host IP. Never use localhost |
| "rejected the bot's API key" | Wrong key, or for Wizarr the key was deleted. Create a new one |
| Status board not updating | The bot needs Send Messages, Embed Links and Read Message History in that channel |
| Webhook test returns 401 | `?secret=` doesn't match `WEBHOOK_SECRET` |
| `DATA_DIR … isn't writable` | Normally handled by the container on start. If you run it with `--user`, `chown -R 99:100 /mnt/user/appdata/mediahub-bot` |
| Requests show as pending in Seerr | Shouldn't happen, because the admin API key auto-approves. If it does, check that the Seerr API key belongs to an admin |
| Unraid settings show blank / reset after an update | A second template copy is shadowing yours. See the box in section 4 |
| Ping buttons say "not allowed to change that role" | Move the bot's role above the ping roles in Server Settings → Roles |
| `/music` says the server "didn't send Opus audio" | Enable Opus transcoding on the Subsonic server (Navidrome: Settings → Transcoding) |
| Bot joins voice but there's no sound | Check it has **Speak** in that channel, and that the Subsonic user can stream (try the same account in a Subsonic app) |
| `/redownload` says redownloads "aren't fully set up" | The app has no Recycling Bin. Set it (see Self-serve redownloads); `/admin redownloads overview` shows which app |
| `/plex` says the account isn't on the share list | They signed in with a different Plex account than the one you shared with, or the invite isn't accepted yet. Once fixed, they run `/plex` again. This only blocks redownloads when `/admin redownloads plexcheck` is on |
| A redownload says 🆘 needs admin | Follow the log entry: finish the import in the app's Activity → Queue → Manual Import (or restore the old file from the recycling bin), then press **Mark resolved** |
| Unraid can't pull the image | Make the GHCR package public, or `docker login ghcr.io` (see section 4) |

## Not used

`PROMOTE_SECRET` is in `.env.example` because it was in the original spec, along with "promotion buttons". No promotion feature was specified, so nothing reads it yet. Self-serve invites now use `INVITER_ROLE_ID` instead.

# MediaHub bot

A self-hosted Discord bot for a Plex + Seerr + Radarr/Sonarr + Tautulli + Lidarr/Aurral + Wizarr stack. Friends request movies, shows and albums from Discord, get @-mentioned when their request is ready, report broken files, and pick which announcements ping them. They can also play your music library in a voice channel. Admins get a live status board, and admins and trusted "Inviters" hand out Wizarr invites.

Two rules shape the design:

1. **The bot is a thin shell.** Seerr, Radarr, Sonarr, Lidarr, Aurral and Wizarr do all the work. If the bot is stopped, nothing in the media pipeline notices. The bot only keeps a small SQLite file: the status-board message ID, who requested what, and invite nicknames.
2. **No approval gates for movies and TV.** Every Discord member is trusted. Requests go to Seerr with its admin API key, so Seerr auto-approves them. There's no approval queue, admin confirmation or quota.

## Commands

| Command | Who | What it does |
|---|---|---|
| `/request movie <query>` | everyone | Search Seerr, pick a result, and it's requested and auto-approved (Radarr takes over) |
| `/request series <query>` | everyone | Same for TV (all seasons; Sonarr takes over) |
| `/request album <query>` | 🎵 Music | Search Lidarr, then add the artist if needed, monitor the album and start a search. Falls back to Aurral |
| `/requests` | everyone | Your requests: live download progress for what's on its way, and what landed recently |
| `/report <title> <problem> <details>` | everyone | Files a Seerr issue (video, audio, subtitles…) and DMs you when it's marked fixed |
| `/music play <song/album/artist/playlist>` | 🎵 Music | Plays your library in your voice channel (autocomplete; `next:` puts it at the front) |
| `/music radio` | 🎵 Music | Endless random songs from the library |
| `/music queue` · `skip` · `shuffle` · `stop` | 🎵 Music | Queue control. The now-playing message also has Pause, Skip, Radio, Queue and Stop buttons |
| `/optin me` | everyone | Your notification and music opt-ins as private toggle buttons |
| `/status` | everyone | Checks every service now and replies privately |
| `/random movie` | everyone | Random movie from Plex with poster, summary, reroll button and Plex link |
| `/stats` | everyone | Plex library size, Lidarr monitored artists, Seerr request count |
| `/help` | everyone | Lists the commands *you* can use |
| `/statusboard post` | everyone | Posts the live board, or links to it if it already exists |
| `/statusboard repost` | 🔒 admin | Abandons the old board and posts a fresh one |
| `/optin setup <channel>` | 🔒 admin | Creates the opt-in roles and posts the button panel (e.g. in #welcome) |
| `/invite create [user] [name] [expiry] [uses]` | 🎟️ inviter | Creates a Wizarr invite. With `user:@someone`, the bot DMs them the link |
| `/invite list` | 🎟️ inviter | Active invites (inviters see their own, admins see all) |
| `/invite revoke <name>` | 🎟️ inviter | Deletes the invite in Wizarr so its link stops working |

🎵 = opted in to Music (or admin). 🎟️ = admins and the Inviter role. 🔒 = admins.

Search results and replies are ephemeral, so only the person who asked sees them and channels don't flood. A command only appears when its service is configured.

---

## 1. Discord developer portal setup

1. Go to <https://discord.com/developers/applications> → **New Application**, and give it a name.
2. **Bot** tab → **Reset Token** → copy it into `DISCORD_TOKEN`.
   Leave all three **Privileged Gateway Intents** (Presence, Server Members, Message Content) **off**. The bot uses slash commands only. It connects with the `Guilds` intent, plus the non-privileged `GuildVoiceStates` intent when music streaming is configured.
3. **Installation** or **OAuth2 → URL Generator**: choose the scopes **`bot`** and **`applications.commands`**, and these bot permissions: *View Channels, Send Messages, Embed Links, Attach Files, Read Message History, Manage Roles* (for the opt-in roles), *Connect* and *Speak* (for music). Or use this URL with your Application ID (from **General Information**):

   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot%20applications.commands&permissions=271698944
   ```

   If the bot is already in your server, opening the new URL updates its permissions.

   Open it and add the bot to your server.
4. In Discord, go to **User Settings → Advanced → Developer Mode** and turn it on. Then right-click to copy IDs:
   - the server icon → **Copy Server ID** → `GUILD_ID`
   - each channel → **Copy Channel ID** → `STATUS_CHANNEL_ID`, `NOTIFY_CHANNEL_ID`, `ADMIN_CHANNEL_ID`
   - your admin role (Server Settings → Roles) → **Copy Role ID** → `ADMIN_ROLE_ID`, and the role allowed to hand out invites → `INVITER_ROLE_ID`
5. If those channels are private, give the bot's role access to them. It needs to send messages, embed links and read message history. The status channel also needs read history, because the bot edits its own board message there.
6. In **Server Settings → Roles**, drag the bot's role **above** the Movies / TV / Music / Server status roles (created by `/optin setup`), or it can't hand them out.

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

1. Copy `unraid/mediahub-bot.xml` to the flash drive as `/boot/config/plugins/dockerMan/templates-user/my-mediahub-bot.xml` (e.g. via the `flash` share).
2. **Docker** tab → **Add Container** → **Template** dropdown → **mediahub-bot**.
3. Fill in `DISCORD_TOKEN`, `GUILD_ID`, the channel IDs and the services you use. Leave the rest empty. Click **Show more settings** for tuning options.
4. **Network Type**: pick the same custom network as your other containers so URLs like `http://lidarr:8686` work (see section 3). On plain *bridge*, use `http://<unraid-ip>:<port>` URLs instead.
5. **Apply**. Updates arrive through Unraid's usual **Check for Updates**.

`PUID`/`PGID` default to 99/100 (nobody:users). The container fixes ownership of the appdata folder itself, so there's no manual `chown`.

**Option B: Docker Compose** (Compose Manager plugin or the CLI)

```bash
cp .env.example .env && nano .env
docker compose up -d        # pulls ghcr.io/nogref/mediahub-bot:latest
docker logs -f mediahub-bot
```

A healthy start logs the configured services, the enabled modules, `logged in as …` and `registered N command(s)`. `GET http://<host>:8787/healthz` returns `{"ok":true,"discord":"connected"}`, and the container's Docker health check uses it too.

**After the first start**, run `/optin setup channel:#welcome` once to create the opt-in roles and post the button panel.

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
- The message ID survives restarts (`/data/bot.db`). `/statusboard repost` posts a new board and marks the old one as moved.

## Invites (Wizarr)

The bot only creates, lists and revokes invite links. Your friend opens the link and finishes Wizarr's own onboarding wizard in the browser.

- **Who:** admins, plus anyone with `INVITER_ROLE_ID`.
- **Inviter guardrails:** inviters' links are always single use and expire after at most `INVITER_EXPIRY_DAYS` (7). Each inviter can have at most `INVITER_MAX_ACTIVE` (3) active at once, and they only see and revoke their own. Admins have no limits and see everything, including who created each invite and who it's for.
- **`/invite create user:@bob`** DMs Bob the link with a short "here's how to join" note, and names the invite "bob" unless you give a `name`. If Bob has DMs from server members turned off, you get the link to pass along instead.
- **Names are bot-side nicknames.** Wizarr identifies invites by code, so the bot stores nickname ↔ code. `/invite revoke` accepts either, with autocomplete.
- **Expiry** can be 1 day, 7 days, 30 days or never, and **uses** can be single or unlimited. Those are the only options Wizarr's API has.
- Invites go to `WIZARR_SERVER_IDS` if set, otherwise to every verified Plex server in Wizarr.
- Every create and revoke is logged in the admin channel. Links themselves are never posted there.

## Opt-ins: who gets pinged for what

`/optin setup channel:#welcome` (admin) creates four roles, or reuses ones with the same names or set via `ROLE_*_ID`, and posts a panel with a button for each. Tapping a button switches that role on or off and confirms privately. `/optin me` shows the same toggles with your current state.

| Role | What it does |
|---|---|
| 🎬 Movies | New-movie announcements @-ping you |
| 📺 TV | New-episode/show announcements @-ping you |
| 🎵 Music | Unlocks `/request album` and `/music`, and album announcements ping you |
| 📡 Server status | "Service down / back up" heads-ups ping you |

Opting out means *no pings*. The announcements channel stays visible to everyone. Two exceptions:
- **Music is opt-in once the Music role exists**: people without it don't get `/request album` or `/music`. To hide album announcements from them too, set `MUSIC_NOTIFY_CHANNEL_ID` to a channel only the Music role can see.
- **Your own requests always ping you** when they're ready, whatever you've opted out of.

The roles are created mentionable so the bot can ping them without the "Mention Everyone" permission.

## `/requests` and `/report`

- **`/requests`** lists what you've asked for through the bot. For items still on the way it shows live progress: Seerr's Radarr/Sonarr download percentage and ETA, Lidarr's queue and track count, or Aurral's download state. After 3 days with nothing found it says so, instead of leaving you guessing. Below that are items that landed in the last two weeks.
- **`/report`** autocompletes titles that are in the library, takes a problem type (video, audio, subtitles, other), a description and an optional season/episode, and files a **Seerr issue** under your Seerr user if your Discord ID is linked there. Admins see it in the admin channel and handle it in Seerr as usual. When it's marked **resolved**, the reporter gets a DM, either straight away via Seerr's *Issue Resolved* webhook or within `REQUEST_RECONCILE_MINUTES` from the bot's own check. If their DMs are closed, they get a mention in the announcements channel instead.

## Music streaming

`/music` plays your library from a **Subsonic server** into the voice channel you're in. That can be Aurral's built-in one (the default: `SUBSONIC_URL` falls back to `AURRAL_URL`) or Navidrome.

- **Setup:** create a user for the bot in Aurral (Settings → Users) and put its credentials in `SUBSONIC_USER` / `SUBSONIC_PASSWORD`. The bot tries token auth first and switches to password auth automatically if the server needs it. A `Subsonic` line appears on the status board.
- **No transcoding in the bot:** it asks the server for Opus (`format=opus`, `MUSIC_BITRATE` kbps), which Aurral produces with its own ffmpeg. Audio goes straight into Discord, so the bot image needs no ffmpeg. Navidrome works if its Opus transcoding is enabled (it is by default).
- **Encryption:** Discord requires end-to-end encrypted voice (DAVE) for every bot since March 2026. The bundled `@discordjs/voice` handles it.
- **Using it:** join a voice channel, then `/music play` and start typing. Suggestions cover artists (plays their top songs), albums, playlists and songs. A single **now-playing message** with cover art and Pause / Skip / Radio / Queue / Stop buttons lives in the voice channel's own text chat and updates as tracks change, so it doesn't clutter other channels.
- **Who controls it:** anyone with the Music opt-in who's in the same voice channel, plus admins.
- **Leaving:** the bot leaves `MUSIC_IDLE_MINUTES` (5) after the queue ends or everyone leaves, and when `/music stop` is used.
- **Limits:** one voice channel at a time, and no volume command, since that would mean decoding audio in the bot. Listeners can right-click the bot to set their own volume.

---

## Adding a new handler

Each feature is one file in `src/modules/` that exports a **factory**. The factory gets the shared context (config, service clients, SQLite store, Discord client, notifier, opt-in roles, access checks) and returns a `BotModule`, or `null` when what it needs isn't configured. Then the feature simply doesn't exist: no commands are registered and it never runs. `src/modules/index.ts` is the list of features. Delete a line, and its file, to remove one.

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

Change `.env.example` → run `node scripts/gen-unraid-template.mjs` → commit both. Dependabot opens weekly PRs for npm updates, grouping discord.js packages so they stay in step.

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
                        access gates, opt-in role directory, helpers
  services/             one thin API client per service (incl. Subsonic)
  modules/              one file per feature (see table above)
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
| Opt-in buttons say "not allowed to change that role" | Move the bot's role above the opt-in roles in Server Settings → Roles |
| `/music` says the server "didn't send Opus audio" | Enable Opus transcoding on the Subsonic server (Navidrome: Settings → Transcoding) |
| Bot joins voice but there's no sound | Check it has **Speak** in that channel, and that the Subsonic user can stream (try the same account in a Subsonic app) |
| Unraid can't pull the image | Make the GHCR package public, or `docker login ghcr.io` (see section 4) |

## Not used

`PROMOTE_SECRET` is in `.env.example` because it was in the original spec, along with "promotion buttons". No promotion feature was specified, so nothing reads it yet. Self-serve invites now use `INVITER_ROLE_ID` instead.

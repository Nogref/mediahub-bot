// Shared fakes for tests: config, Discord client/channel, and interaction objects.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mediabot-test-"));
}

export function fakeConfig(overrides = {}) {
  return {
    discordToken: "x",
    guildId: "g1",
    adminRoleId: "admin-role",
    channels: { status: "c-status", notify: "c-notify", admin: "c-admin" },
    links: {},
    stats: { refreshMinutes: 30 },
    roles: {},
    invites: { inviterRoleId: "inviter-role", maxActive: 3, expiryDays: 7 },
    dataDir: tmpDir(),
    http: { port: 0, webhookSecret: "s3cret", timeoutMs: 3000 },
    music: { primary: "lidarr" },
    notify: { batchSeconds: 60, dedupeHours: 6, reconcileMinutes: 10, trackDays: 30 },
    status: { intervalSeconds: 60, refreshMinutes: 5, failThreshold: 2, slowMs: 2000 },
    redownload: { dailyLimit: 2, titleCooldownHours: 48, maxActive: 3, maxAttempts: 3, attemptTimeoutHours: 24 },
    plexTvUrl: "http://127.0.0.1:9/plextv",
    ...overrides,
  };
}

/** A Discord client double whose channels record what was sent. */
export function fakeClient() {
  const sent = [];
  const messages = new Map();
  let nextId = 1;
  const makeMessage = (channelId, payload) => {
    const msg = {
      id: String(nextId++),
      channelId,
      payload,
      edits: [],
      async edit(p) {
        if (msg.deleted) {
          const e = new Error("Unknown Message");
          e.code = 10008;
          throw e;
        }
        msg.edits.push(p);
        return msg;
      },
    };
    messages.set(msg.id, msg);
    return msg;
  };
  const channel = (id) => ({
    id,
    isSendable: () => true,
    async send(payload) {
      sent.push({ channelId: id, payload });
      return makeMessage(id, payload);
    },
    messages: {
      async delete(mid) {
        const m = messages.get(mid);
        if (m) m.deleted = true;
      },
      async fetch(mid) {
        const m = messages.get(mid);
        if (!m || m.deleted) {
          const e = new Error("Unknown Message");
          e.code = 10008;
          throw e;
        }
        return m;
      },
    },
  });
  const dms = [];
  const closedDMs = new Set();
  return {
    sent,
    messages,
    dms,
    closedDMs,
    isReady: () => true,
    channels: { fetch: async (id) => channel(id) },
    guilds: { cache: new Map([["g1", { id: "g1", name: "Test Server" }]]) },
    users: {
      fetch: async (id) => ({
        id,
        async send(p) {
          if (closedDMs.has(id)) {
            const e = new Error("Cannot send messages to this user");
            e.code = 50007;
            throw e;
          }
          dms.push({ to: id, payload: p });
        },
      }),
    },
  };
}

/** A guild double with roles and members, for the opt-in panel. */
export function fakeGuild(client) {
  const roles = new Map();
  const memberRoles = new Map(); // userId -> Set(roleId)
  let nextRole = 100;
  const cacheOf = (set) => ({ has: (id) => set.has(id) });
  const member = (uid) => {
    const set = memberRoles.get(uid) ?? new Set();
    memberRoles.set(uid, set);
    return {
      id: uid,
      roles: {
        cache: cacheOf(set),
        add: async (r) => void set.add(r),
        remove: async (r) => void set.delete(r),
      },
    };
  };
  return {
    name: "Test Server",
    roles: {
      fetch: async (id) => roles.get(id) ?? null,
      cache: { find: (fn) => [...roles.values()].find(fn) },
      create: async ({ name, mentionable }) => {
        const r = { id: String(nextRole++), name, mentionable };
        roles.set(r.id, r);
        return r;
      },
    },
    members: { fetch: async (arg) => member(typeof arg === "string" ? arg : arg.user) },
    channels: client.channels,
    _roles: roles,
    _memberRoles: memberRoles,
  };
}

/** Minimal chat-input / component interaction double that records replies. */
export function fakeInteraction({ options = {}, customId, userId = "u1", roles = [] } = {}) {
  const log = [];
  const i = {
    user: { id: userId },
    member: { roles },
    memberPermissions: { has: () => false },
    customId,
    deferred: false,
    replied: false,
    log,
    options: {
      getString: (n) => options[n] ?? null,
      getUser: (n) => options[n] ?? null,
      getChannel: (n) => options[n] ?? null,
      getBoolean: (n) => options[n] ?? null,
      getInteger: (n) => options[n] ?? null,
      getFocused: () => options.__focused ?? "",
      getSubcommand: () => options.__sub ?? null,
      getFocused: () => options.__focused ?? "",
    },
    async deferReply() { i.deferred = true; log.push({ type: "defer" }); },
    async deferUpdate() { i.deferred = true; log.push({ type: "deferUpdate" }); },
    async reply(p) { i.replied = true; log.push({ type: "reply", p }); },
    async editReply(p) { log.push({ type: "edit", p: typeof p === "string" ? { content: p } : p }); },
    async update(p) { log.push({ type: "update", p }); },
    async showModal(m) { log.push({ type: "modal", m: m.toJSON() }); },
    async respond(c) { log.push({ type: "autocomplete", c }); },
    last() { return log.filter((l) => l.type === "edit" || l.type === "reply" || l.type === "update").at(-1)?.p; },
  };
  return i;
}

/** Converts embeds (builders or JSON) to plain JSON for assertions. */
export const json = (e) => (e && typeof e.toJSON === "function" ? e.toJSON() : e);

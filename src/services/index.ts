/** Builds one client per configured service. Unconfigured services are simply absent. */
import type { Config } from "../config.js";
import { AurralClient } from "./aurral.js";
import { LidarrClient } from "./lidarr.js";
import { PlexClient } from "./plex.js";
import { SeerrClient } from "./seerr.js";
import { ArrClient, NavidromeClient, TautulliClient, type HealthCheckable } from "./simple.js";
import { SubsonicClient } from "./subsonic.js";
import { WizarrClient } from "./wizarr.js";

export interface Services {
  plex?: PlexClient;
  seerr?: SeerrClient;
  tautulli?: TautulliClient;
  lidarr?: LidarrClient;
  aurral?: AurralClient;
  navidrome?: NavidromeClient;
  wizarr?: WizarrClient;
  radarr?: ArrClient;
  sonarr?: ArrClient;
  subsonic?: SubsonicClient;
}

export function buildServices(cfg: Config): Services {
  return {
    plex: cfg.plex && new PlexClient(cfg.plex),
    seerr: cfg.seerr && new SeerrClient(cfg.seerr),
    tautulli: cfg.tautulli && new TautulliClient(cfg.tautulli),
    lidarr: cfg.lidarr && new LidarrClient(cfg.lidarr),
    aurral: cfg.aurral && new AurralClient(cfg.aurral),
    navidrome: cfg.navidrome && new NavidromeClient(cfg.navidrome),
    wizarr: cfg.wizarr && new WizarrClient(cfg.wizarr),
    radarr: cfg.radarr && new ArrClient("Radarr", cfg.radarr),
    sonarr: cfg.sonarr && new ArrClient("Sonarr", cfg.sonarr),
    subsonic: cfg.subsonic && new SubsonicClient(cfg.subsonic),
  };
}

/** Status-board order. Only configured services appear. */
const ORDER: Array<keyof Services> = ["plex", "seerr", "tautulli", "lidarr", "aurral", "subsonic", "navidrome", "wizarr", "radarr", "sonarr"];

export function healthTargets(services: Services): Array<{ key: string; client: HealthCheckable }> {
  return ORDER.flatMap((key) => {
    const client = services[key];
    return client ? [{ key, client }] : [];
  });
}

export function anyConfigured(services: Services): boolean {
  return healthTargets(services).length > 0;
}

/** Shared shapes for the redownload feature across Radarr, Sonarr and Lidarr. */

export type TargetKind = "movie" | "episode" | "season" | "album";
export type AppKey = "radarr" | "sonarr" | "lidarr";

export interface Target {
  kind: TargetKind;
  app: AppKey;
  /** Hierarchical lock/cooldown key, e.g. "sonarr:12:s3:e5" or "radarr:44". */
  key: string;
  /** Human label: "Heat (1995)", "Severance · S02E03", "Severance · Season 2", "OK Computer · Radiohead". */
  label: string;
  posterUrl?: string;
  ids: {
    movieId?: number;
    seriesId?: number;
    seasonNumber?: number;
    episodeIds?: number[];
    albumId?: number;
    artistId?: number;
  };
  /** How many of the member's daily slots it uses (a whole season counts as 2). */
  weight: number;
  /** Notifier dedupe keys, so the swapped-in file isn't announced as "new". */
  dedupeKeys: string[];
}

export interface CurrentFile {
  id: number;
  quality: string;
  size: number;
  releaseTitle?: string;
  /** Episode or track ids this file holds (seasons/albums). */
  coveredIds?: number[];
}

export interface Release {
  guid: string;
  indexerId: number;
  title: string;
  quality: string;
  qualityWeight: number;
  customFormatScore: number;
  size: number;
  protocol: string;
  seeders?: number;
  ageMinutes?: number;
  indexer?: string;
  rejections: string[];
  fullSeason?: boolean;
}

export interface QueueItem {
  id: number;
  downloadId?: string;
  title: string;
  /** trackedDownloadState: downloading, importBlocked, importPending, importing, imported, failedPending, failed, ignored */
  state?: string;
  status?: string;
  trackedStatus?: string;
  messages: string[];
  size: number;
  sizeLeft: number;
  eta?: string;
}

export interface ImportPreviewItem {
  /** Episode/track ids this downloaded file would fill. */
  coveredIds: number[];
  rejections: string[];
}

/** Everything the engine needs from an *arr app. Implemented in arr.ts. */
export interface Adapter {
  readonly app: AppKey;
  readonly name: "Radarr" | "Sonarr" | "Lidarr";
  recycleBin(): Promise<string | undefined>;
  currentFiles(t: Target): Promise<CurrentFile[]>;
  search(t: Target): Promise<Release[]>;
  grab(r: Release): Promise<void>;
  queue(t: Target): Promise<QueueItem[]>;
  /** downloadId of the grab of `releaseTitle` made after `since`. */
  grabbedDownloadId(t: Target, releaseTitle: string, since: number): Promise<string | undefined>;
  /** Whether the app recorded a failed download for this downloadId. */
  downloadFailed(t: Target, downloadId: string): Promise<boolean>;
  importPreview(t: Target, downloadId: string): Promise<ImportPreviewItem[]>;
  deleteFiles(t: Target, ids: number[]): Promise<void>;
  refreshDownloads(): Promise<void>;
  removeFromQueue(id: number, blocklist: boolean): Promise<void>;
  /** Grab history behind the files on disk now (to skip them and blocklist them afterwards). */
  currentGrabs(t: Target, files: CurrentFile[]): Promise<Array<{ historyId: number; title: string; downloadId?: string; blocklist: boolean }>>;
  markFailed(historyId: number): Promise<void>;
}

// Authenticated /api routes for data management (P6). The server checks the bearer token
// before any of these run.
//
//   GET    /api/backups            → { dir, keep, database, backups (newest first), restore }
//   POST   /api/backups            → on-demand `VACUUM INTO` backup, then rotation
//   GET    /api/simbrief           → { settings, plan, endpoint, verified: false }
//   PUT    /api/simbrief           → update { enabled?, username?, userId? }
//   POST   /api/simbrief/import    → fetch the latest OFP from simbrief.com (rate limited)
//   DELETE /api/simbrief/plan      → forget the imported planned flight

import { SIMBRIEF_FETCH_URL, simbriefSettingsUpdateSchema } from "../protocol";
import type { SimbriefService } from "../core/simbrief";
import type { BackupManager } from "../storage/backups";
import type { ApiRequest, ApiResult } from "./server";

export interface DataApiOptions {
  backups: BackupManager;
  simbrief: SimbriefService;
  /** Database file being backed up (shown in the restore instructions). */
  databasePath: string;
}

const methodNotAllowed: ApiResult = { status: 405, body: { error: "method_not_allowed" } };

export function restoreInstructions(databasePath: string, backupsDir: string): string[] {
  return [
    "Stop the connector (Ctrl+C in its window). Restoring while it runs is not supported.",
    `Keep a copy of the current database: ${databasePath}`,
    `Copy the backup you want from ${backupsDir} over ${databasePath}.`,
    "Delete the -wal and -shm files next to the database if they exist.",
    "Start the connector again and reload the browser tab.",
  ];
}

export function dataApi(options: DataApiOptions) {
  const { backups, simbrief } = options;
  return async (req: ApiRequest): Promise<ApiResult | null> => {
    const { method, pathname } = req;
    switch (pathname) {
      case "/api/backups":
        if (method === "GET") {
          return {
            status: 200,
            body: {
              dir: backups.dir,
              keep: backups.keep,
              database: backups.kind,
              backups: backups.list(),
              restore: restoreInstructions(options.databasePath, backups.dir),
            },
          };
        }
        if (method === "POST") {
          const r = backups.create(true);
          if (!r.ok) {
            return {
              status: r.code === "backup_exists" ? 409 : 500,
              body: { error: r.code, message: r.message },
            };
          }
          return { status: 201, body: { backup: r.backup, removed: r.removed } };
        }
        return methodNotAllowed;
      case "/api/simbrief":
        if (method === "GET") {
          return {
            status: 200,
            body: {
              settings: simbrief.settings(),
              plan: simbrief.plan(),
              endpoint: SIMBRIEF_FETCH_URL,
              verified: false,
            },
          };
        }
        if (method === "PUT") {
          const parsed = simbriefSettingsUpdateSchema.safeParse(req.body ?? {});
          if (!parsed.success) {
            return {
              status: 400,
              body: {
                error: "bad_request",
                message: parsed.error.issues.map((i) => i.message).join("; "),
              },
            };
          }
          return { status: 200, body: { settings: simbrief.update(parsed.data) } };
        }
        return methodNotAllowed;
      case "/api/simbrief/import": {
        if (method !== "POST") return methodNotAllowed;
        const r = await simbrief.import();
        if (r.ok) return { status: 200, body: { plan: r.plan } };
        return {
          status: r.status,
          body: {
            error: r.code,
            message: r.message,
            ...(r.retryAfterSec !== undefined ? { retryAfterSec: r.retryAfterSec } : {}),
          },
        };
      }
      case "/api/simbrief/plan":
        if (method !== "DELETE") return methodNotAllowed;
        simbrief.clearPlan();
        return { status: 200, body: { plan: null } };
      default:
        return null;
    }
  };
}

import type { Update } from "@tauri-apps/plugin-updater";

export const isTauri = () =>
  typeof window !== "undefined" &&
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== undefined;

export function resolveDisplayedAppVersion(
  runtimeVersion: string | null | undefined,
  bundledVersion: string,
): string {
  const raw = runtimeVersion?.trim() || bundledVersion.trim();
  return raw.replace(/^v/i, "");
}

export async function checkForAppUpdate(): Promise<Update | null> {
  if (!isTauri()) {
    throw new Error("检查更新只在安装版桌面 App 里可用");
  }
  const { check } = await import("@tauri-apps/plugin-updater");
  return check();
}

export async function downloadAndInstallAppUpdate(
  update: Update,
  onProgress?: (progress: {
    event: "Started" | "Progress" | "Finished";
    chunkLength?: number;
    contentLength?: number;
  }) => void,
): Promise<void> {
  await update.downloadAndInstall((event) => {
    if (!onProgress) return;
    if (event.event === "Started") {
      onProgress({ event: "Started", contentLength: event.data.contentLength });
    } else if (event.event === "Progress") {
      onProgress({ event: "Progress", chunkLength: event.data.chunkLength });
    } else if (event.event === "Finished") {
      onProgress({ event: "Finished" });
    }
  });
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

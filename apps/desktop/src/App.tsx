import { useEffect, useState } from "react";
import pkg from "../package.json";
import { AboutModal } from "./AboutModal";
import { SettingsModal } from "./SettingsModal";
import { UpdateModal } from "./UpdateModal";
import { checkForAppUpdate, isTauri, resolveDisplayedAppVersion } from "./updater";
import type { Update } from "@tauri-apps/plugin-updater";

const PREVIEW_URL = "http://127.0.0.1:4319";

export function App() {
  const [workbenchUrl, setWorkbenchUrl] = useState<string | null>(isTauri() ? null : PREVIEW_URL);
  const [bootError, setBootError] = useState<string | null>(null);
  const [version, setVersion] = useState(pkg.version);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [update, setUpdate] = useState<Update | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const { getVersion } = await import("@tauri-apps/api/app");
        const url = await invoke<string>("workbench_url");
        const runtime = await getVersion();
        if (!cancelled) {
          setWorkbenchUrl(url);
          setVersion(resolveDisplayedAppVersion(runtime, pkg.version));
        }
      } catch (err) {
        if (!cancelled) setBootError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onCheckUpdate = async () => {
    setUpdateError(null);
    try {
      const found = await checkForAppUpdate();
      if (!found) {
        setUpdateError("当前已是最新版本");
        return;
      }
      setUpdate(found);
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg)] text-[var(--color-text)]">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--color-accent)] text-sm text-white">
          橦
        </span>
        <span className="text-sm">橦云数据库</span>
        <span className="text-xs text-[var(--color-text-muted)]">v{version}</span>
        <span className="flex-1" />
        <button type="button" className="shell-button" onClick={() => setSettingsOpen(true)}>
          设置
        </button>
        <button type="button" className="shell-button" onClick={() => void onCheckUpdate()}>
          检查更新
        </button>
        <button type="button" className="shell-button" onClick={() => setAboutOpen(true)}>
          关于
        </button>
      </header>
      {updateError && (
        <div className="border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
          {updateError}
        </div>
      )}
      <main className="min-h-0 flex-1">
        {workbenchUrl ? (
          <iframe
            title="数据工作台"
            src={workbenchUrl}
            className="h-full w-full border-0 bg-white"
          />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-sm text-[var(--color-text-muted)]">
            {bootError ?? "正在启动工作台…"}
          </div>
        )}
      </main>
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {aboutOpen && <AboutModal version={version} onClose={() => setAboutOpen(false)} />}
      {update && <UpdateModal update={update} onClose={() => setUpdate(null)} />}
    </div>
  );
}

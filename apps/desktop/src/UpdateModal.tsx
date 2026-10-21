import { useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { downloadAndInstallAppUpdate } from "./updater";

interface UpdateModalProps {
  update: Update;
  onClose: () => void;
}

export function UpdateModal({ update, onClose }: UpdateModalProps) {
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onInstall = async () => {
    setInstalling(true);
    setError(null);
    try {
      await downloadAndInstallAppUpdate(update);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setInstalling(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={installing ? undefined : onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-xl"
        role="dialog"
        aria-labelledby="update-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="update-title" className="text-sm">
          发现新版本 v{update.version}
        </h2>
        <p className="mt-2 text-xs leading-5 text-[var(--color-text-muted)]">
          {update.body || "可以安装这个更新。安装包由发布流程签名。"}
        </p>
        {error && <p className="mt-2 text-xs text-[var(--ty-peach-text)]">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          {!installing && (
            <button type="button" className="shell-button" onClick={onClose}>
              稍后
            </button>
          )}
          <button type="button" className="shell-button" disabled={installing} onClick={() => void onInstall()}>
            {installing ? "正在安装…" : "下载并安装"}
          </button>
        </div>
      </div>
    </div>
  );
}

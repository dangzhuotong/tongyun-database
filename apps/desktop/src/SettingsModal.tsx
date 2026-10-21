import { useEffect, useState } from "react";
import { settingsSavePayload, type ThemeName } from "./settings";
import { isTauri } from "./updater";

interface SettingsModalProps {
  onClose: () => void;
}

export function SettingsModal({ onClose }: SettingsModalProps) {
  const [theme, setTheme] = useState<ThemeName>("system");
  const [dataDir, setDataDir] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    void (async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const loaded = await invoke<{ theme: ThemeName; dataDir: string }>("load_app_settings");
      if (!cancelled) {
        setTheme(loaded.theme);
        setDataDir(loaded.dataDir);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onSave = async () => {
    const payload = settingsSavePayload(theme);
    setSaving(true);
    setStatus(null);
    try {
      if (!isTauri()) {
        setStatus("预览不会弹出系统密码框。安装版把主题写进本机 settings.json。");
        return;
      }
      const { invoke } = await import("@tauri-apps/api/core");
      const saved = await invoke<{ theme: ThemeName; dataDir: string }>("save_app_settings", payload);
      setDataDir(saved.dataDir);
      setStatus("已保存。主题写在 settings.json，数据库密码写在加密文件，不会询问钥匙串密码。");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <form
        className="w-full max-w-lg rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-xl"
        role="dialog"
        aria-labelledby="settings-title"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void onSave();
        }}
      >
        <h2 id="settings-title" className="text-sm">
          设置
        </h2>
        <p className="mt-2 text-xs leading-5 text-[var(--color-text-muted)]">
          数据库密码保存在数据目录的 secrets.vault（目录 0700，文件 0600）。保存设置或连接不会调用 macOS 钥匙串。
        </p>
        <label className="mt-4 block text-xs">
          外观
          <select
            className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1"
            value={theme}
            aria-label="外观"
            onChange={(event) => setTheme(event.target.value as ThemeName)}
          >
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </label>
        <label className="mt-3 block text-xs">
          数据目录
          <input
            className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1"
            value={dataDir || "安装版使用系统配置目录；开发预览仍可用仓库 .local"}
            readOnly
            aria-label="数据目录"
          />
        </label>
        {status && <p className="mt-3 text-xs text-[var(--color-text-muted)]">{status}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="shell-button" onClick={onClose}>
            关闭
          </button>
          <button type="submit" className="shell-button" disabled={saving}>
            保存
          </button>
        </div>
      </form>
    </div>
  );
}

export const THEMES = ["system", "light", "dark"] as const;

export type ThemeName = (typeof THEMES)[number];

/** Payload written by 设置 → 保存. Passwords are not part of this object. */
export function settingsSavePayload(theme: string): { theme: ThemeName } {
  if (!THEMES.includes(theme as ThemeName)) {
    throw new Error("主题无效");
  }
  return { theme: theme as ThemeName };
}

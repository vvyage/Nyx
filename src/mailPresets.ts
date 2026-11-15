// IMAP settings for common mail providers. Keep in step with MAIL_PRESETS in
// electron/signupUtils.cjs, which the main process uses for the spam folder.
export interface MailPreset {
  id: string;
  label: string;
  host: string;
  port: number;
  domains: string[];
}

export const MAIL_PRESETS: MailPreset[] = [
  { id: "gmail", label: "Gmail", host: "imap.gmail.com", port: 993, domains: ["gmail.com", "googlemail.com"] },
  { id: "outlook", label: "Outlook / Hotmail", host: "outlook.office365.com", port: 993, domains: ["outlook.com", "hotmail.com", "live.com", "msn.com"] },
  { id: "yahoo", label: "Yahoo", host: "imap.mail.yahoo.com", port: 993, domains: ["yahoo.com"] },
  { id: "icloud", label: "iCloud", host: "imap.mail.me.com", port: 993, domains: ["icloud.com", "me.com"] },
];

export function presetForEmail(email: string): MailPreset | null {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  return MAIL_PRESETS.find((preset) => preset.domains.includes(domain)) ?? null;
}

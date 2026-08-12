/**
 * src/utils/alertEmailTemplate.ts — the default alert email, as a TEMPLATE.
 *
 * The old default was two lines: the message, and a "View:" link to
 * /automations.html — a page that lists automations rather than the device
 * that is hurting. This is the replacement, and it is deliberately expressed
 * in the same `{token}` vocabulary an operator types into a Notify action's
 * "Customize the email" fields rather than as server-side string building.
 *
 * That matters for one reason: what Polaris sends and what the operator can
 * edit are the same text. The automation wizard prefills a new Notify action
 * with exactly these strings (schema.defaultEmailTemplate), so the email in
 * the inbox is always the template on the screen — edit it, reorder it, drop
 * the charts, and the result is what ships. A stored automation that carries
 * no composition still renders through here, so existing rules get the new
 * body without a migration.
 *
 * HTML rules, learned the hard way by everyone who has done this:
 *   - tables, not flexbox or grid (Outlook renders through Word)
 *   - inline styles only; no <style> block, no classes
 *   - no remote images — the charts ride as inline CID attachments
 *   - a real plain-text alternative, since some clients show only that
 *
 * Rows whose token renders empty are dropped by `pruneEmptyRows` before send,
 * so an asset with no AP, no serial and no CPU history doesn't email a column
 * of blank cells.
 */

export const DEFAULT_ALERT_SUBJECT = "[{severity.upper}] {asset} — {rule}";

/**
 * Plain-text alternative. Not a stripped copy of the HTML: it is the version
 * a pager gateway or a text-only client shows, so the links are spelled out
 * rather than hidden behind anchors.
 */
export const DEFAULT_ALERT_TEXT = [
  "{message}",
  "",
  "Device:     {asset}",
  "IP:         {asset.ip}",
  "Switch:     {asset.connectedSwitch}",
  "AP:         {asset.connectedAp}",
  "Location:   {asset.location}",
  "Severity:   {severity}",
  "Raised:     {time}",
  "",
  "{chart.cpu}",
  "{chart.memory}",
  "{chart.responseTime}",
  "",
  "Open device:      {asset.link}",
  "Acknowledge:      {ack}",
].join("\n");

/**
 * HTML body. The two buttons are bulletproof-ish table buttons rather than
 * styled anchors so Outlook renders them as buttons and not as underlined
 * text; both degrade to plain links everywhere else.
 */
export const DEFAULT_ALERT_HTML = [
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f8;padding:16px 0;font-family:-apple-system,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif">',
  '<tr><td align="center">',
  '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden">',
  // Severity bar + headline
  '<tr><td style="background:{severity.color};height:5px;line-height:5px;font-size:0">&nbsp;</td></tr>',
  '<tr><td style="padding:18px 22px 6px">',
  '<div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:{severity.color};font-weight:700">{severity} alert</div>',
  '<div style="font-size:19px;font-weight:600;color:#1f2430;margin-top:4px">{asset}</div>',
  '<div style="font-size:15px;color:#374151;margin-top:8px">{message}</div>',
  "</td></tr>",
  // Facts
  '<tr><td style="padding:10px 22px 0">',
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#374151;border-collapse:collapse">',
  '<tr><td style="padding:3px 12px 3px 0;color:#6b7280;white-space:nowrap">IP address</td><td style="padding:3px 0">{asset.ip}</td></tr>',
  '<tr><td style="padding:3px 12px 3px 0;color:#6b7280;white-space:nowrap">Connected switch</td><td style="padding:3px 0">{asset.connectedSwitch}</td></tr>',
  '<tr><td style="padding:3px 12px 3px 0;color:#6b7280;white-space:nowrap">Connected AP</td><td style="padding:3px 0">{asset.connectedAp}</td></tr>',
  '<tr><td style="padding:3px 12px 3px 0;color:#6b7280;white-space:nowrap">Location</td><td style="padding:3px 0">{asset.location}</td></tr>',
  '<tr><td style="padding:3px 12px 3px 0;color:#6b7280;white-space:nowrap">Model</td><td style="padding:3px 0">{asset.manufacturer} {asset.model}</td></tr>',
  '<tr><td style="padding:3px 12px 3px 0;color:#6b7280;white-space:nowrap">Automation</td><td style="padding:3px 0">{rule}</td></tr>',
  '<tr><td style="padding:3px 12px 3px 0;color:#6b7280;white-space:nowrap">Raised</td><td style="padding:3px 0">{time}</td></tr>',
  "</table>",
  "</td></tr>",
  // Charts — the last hour of the three metrics that explain most alerts.
  '<tr><td style="padding:14px 22px 0">',
  '<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;font-weight:700;margin-bottom:2px">Last hour</div>',
  "{chart.cpu}",
  "{chart.memory}",
  "{chart.responseTime}",
  "</td></tr>",
  // Actions
  '<tr><td style="padding:16px 22px 22px">',
  '<table role="presentation" cellpadding="0" cellspacing="0"><tr>',
  '<td style="border-radius:6px;background:{severity.color}"><a href="{ack}" style="display:inline-block;padding:11px 18px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none">Acknowledge alert</a></td>',
  '<td style="width:10px">&nbsp;</td>',
  '<td style="border-radius:6px;border:1px solid #d1d5db"><a href="{asset.link}" style="display:inline-block;padding:10px 17px;font-size:14px;font-weight:600;color:#374151;text-decoration:none">Open device</a></td>',
  "</tr></table>",
  "</td></tr>",
  "</table>",
  '<div style="font-size:11px;color:#9ca3af;margin-top:10px">Sent by Polaris · automation "{rule}"</div>',
  "</td></tr></table>",
].join("\n");

export interface AlertEmailTemplate {
  subjectTemplate: string;
  bodyTextTemplate: string;
  bodyHtmlTemplate: string;
}

export function defaultAlertEmailTemplate(): AlertEmailTemplate {
  return {
    subjectTemplate: DEFAULT_ALERT_SUBJECT,
    bodyTextTemplate: DEFAULT_ALERT_TEXT,
    bodyHtmlTemplate: DEFAULT_ALERT_HTML,
  };
}

/**
 * Drop rows / lines whose value came out empty.
 *
 * Every `{asset.*}` token renders "" when the field is unset, so a workstation
 * with no AP, no model and no location would otherwise mail a facts table of
 * blank cells — which reads as broken rather than as "not applicable".
 *
 * HTML: a `<tr>` whose SECOND cell has no text content is removed. Text: a
 * "Label: <nothing>" line is removed. Both operate on the RENDERED body, so
 * an operator's own rows get the same treatment as ours.
 */
export function pruneEmptyRows(html: string): string {
  return html.replace(/<tr>(?:(?!<\/tr>).)*<\/tr>/gs, (row) => {
    const cells = Array.from(row.matchAll(/<td[^>]*>(.*?)<\/td>/gs), (m) => m[1] ?? "");
    // Only touch two-cell label/value rows — never the layout scaffolding,
    // the severity bar, or the button row.
    if (cells.length !== 2) return row;
    const value = cells[1]!.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
    return value.length === 0 ? "" : row;
  });
}

/**
 * Drop a button whose link came out empty.
 *
 * {ack} is blank for a recipient who can't acknowledge (a contact, a typed
 * address) and {asset.link} is blank on an install with no POLARIS_PUBLIC_URL.
 * Left alone, those render as `<a href="">` — a button that reloads whatever
 * page the reader is on, which is worse than no button. The spacer cell
 * between the two buttons goes with them when it ends up on an edge.
 */
export function pruneDeadLinks(html: string): string {
  return html
    .replace(/<td[^>]*>\s*<a\s+href=""[^>]*>.*?<\/a>\s*<\/td>/gs, "")
    // A spacer left at the start or end of its row after the drop.
    .replace(/(<tr>)\s*<td style="width:10px">&nbsp;<\/td>/g, "$1")
    .replace(/<td style="width:10px">&nbsp;<\/td>\s*(<\/tr>)/g, "$1");
}

/** Text-body counterpart: drop "Label:" lines with nothing after the colon. */
export function pruneEmptyTextLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const m = /^([A-Za-z][\w .]*):\s*(.*)$/.exec(line);
      if (!m) return true;
      return m[2]!.trim().length > 0;
    })
    .join("\n")
    // Collapse the runs of blank lines the drops leave behind.
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

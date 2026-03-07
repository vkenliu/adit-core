/**
 * Shared terminal formatting utilities.
 *
 * Provides consistent styled output primitives for CLI commands:
 * padding, time formatting, horizontal rules, and section headers.
 */

import pc from "picocolors";

/** Pad a string to the right with spaces */
export function padRight(s: string, len: number): string {
  return s.length >= len ? s.substring(0, len) : s + " ".repeat(len - s.length);
}

/** Pad a string to the left with spaces */
export function padLeft(s: string, len: number): string {
  return s.length >= len ? s : " ".repeat(len - s.length) + s;
}

/** Format a duration into a human-readable "time ago" string */
export function timeAgo(isoOrDate: string | Date): string {
  const date = typeof isoOrDate === "string" ? new Date(isoOrDate) : isoOrDate;
  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffMin < 1) return "just now";
  if (diffHour < 1) return `${diffMin}m ago`;
  if (diffDay < 1) return `${diffHour}h ago`;
  return `${diffDay}d ago`;
}

/** Format a date as a compact date-time string (e.g., "03/08 14:32:01") */
export function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const time = d.toLocaleTimeString("en-US", { hour12: false });
    return `${month}/${day} ${time}`;
  } catch {
    return iso.substring(5, 19).replace("T", " ");
  }
}

/** Render a dimmed horizontal rule */
export function horizontalRule(width = 50): string {
  return pc.dim("\u2500".repeat(width));
}

/** Render a dimmed section header with trailing rule fill */
export function sectionHeader(label: string, width = 50): string {
  const prefix = "\u2500\u2500 ";
  const suffix = " ";
  const remaining = width - prefix.length - label.length - suffix.length;
  const fill = remaining > 0 ? "\u2500".repeat(remaining) : "";
  return pc.dim(`${prefix}${label}${suffix}${fill}`);
}

/** Render a styled status dot: green filled when active, red outline when inactive */
export function statusDot(active: boolean): string {
  return active ? pc.green("\u25cf") : pc.red("\u25cb");
}

/** Join non-empty segments with a dimmed separator */
export function joinDim(parts: (string | null | undefined | false)[], separator = " \u00b7 "): string {
  return parts.filter(Boolean).join(pc.dim(separator));
}

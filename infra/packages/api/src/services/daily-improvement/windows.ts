import { londonParts } from "../quality-loop/cadence";
import {
  DAILY_IMPROVEMENT_TIMEZONE,
  ENGINEERING_HOUR,
  ENGINEERING_MINUTE,
  QA_HOUR,
  QA_MINUTE,
  REPORT_HOUR,
  REPORT_MINUTE,
} from "./constants";
import type { DailyImprovementRunKind } from "./types";

export type WindowDecision = {
  kind: DailyImprovementRunKind;
  due: boolean;
  londonDate: string;
};

export function londonDateOf(at: Date | string | number = new Date()): string {
  return londonParts(at).isoDate;
}

export function decideDailyImprovementWindow(
  at: Date | string | number = new Date(),
): WindowDecision[] {
  const parts = londonParts(at);
  const decisions: WindowDecision[] = [];
  if (parts.hour === QA_HOUR && parts.minute === QA_MINUTE) {
    decisions.push({ kind: "QA", due: true, londonDate: parts.isoDate });
  }
  if (parts.hour === REPORT_HOUR && parts.minute === REPORT_MINUTE) {
    decisions.push({ kind: "REPORT", due: true, londonDate: parts.isoDate });
  }
  if (parts.hour === ENGINEERING_HOUR && parts.minute === ENGINEERING_MINUTE) {
    decisions.push({ kind: "ENGINEERING", due: true, londonDate: parts.isoDate });
  }
  return decisions;
}

export function previousCompletedQaWindow(now: Date | string | number = new Date()): {
  from: string;
  to: string;
} {
  const to = now instanceof Date ? now : new Date(now);
  const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function reportSubject(date: string): string {
  return `INFRA — Daily AI Quality & Improvement Report — ${date}`;
}

export function correctedReportSubject(date: string): string {
  return `INFRA — Corrected Daily AI Quality & Improvement Report — ${date}`;
}

export function timezoneLabel(): string {
  return DAILY_IMPROVEMENT_TIMEZONE;
}

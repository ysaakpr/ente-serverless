/**
 * Museum timestamps are epoch MICROSECONDS everywhere (pkg/utils/time).
 * Never truncate to millis in anything that feeds a diff.
 */

export type Micros = number;

export const microsNow = (): Micros => Date.now() * 1000;

export const MICROS_PER_SECOND = 1_000_000;
export const MICROS_PER_MINUTE = 60 * MICROS_PER_SECOND;
export const MICROS_PER_HOUR = 60 * MICROS_PER_MINUTE;
export const MICROS_PER_DAY = 24 * MICROS_PER_HOUR;

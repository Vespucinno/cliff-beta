import { z } from "zod";

export const SeverityLevelSchema = z.enum(["low", "medium", "high", "critical"]);
export type SeverityLevel = z.infer<typeof SeverityLevelSchema>;

export const FindingCategorySchema = z.enum([
  "security",
  "correctness",
  "performance",
  "maintainability",
  "testing",
]);
export type FindingCategory = z.infer<typeof FindingCategorySchema>;

export const ConfidenceLevelSchema = z.enum(["low", "medium", "high"]);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevelSchema>;

export const FindingSchema = z.object({
  severity: SeverityLevelSchema.catch("low"),
  category: FindingCategorySchema.catch("correctness"),
  title: z.string().default("Issue identified"),
  file: z.string().nullable().default(null),
  line: z.number().int().positive().nullable().default(null),
  location: z.string().nullable().optional().default(null),
  description: z.string().default("Potential issue in PR diff"),
  evidence: z.array(z.string()).default([]),
  why_it_matters: z.string().default("May cause runtime errors or security vulnerabilities."),
  suggested_fix: z.string().default("Review and update implementation."),
  confidence: ConfidenceLevelSchema.catch("medium"),
});
export type Finding = z.infer<typeof FindingSchema>;

export const ReviewResultSchema = z.object({
  summary: z.string().default(""),
  risk_level: SeverityLevelSchema.catch("low"),
  breaking_changes: z.array(z.string()).default([]),
  suggestions: z.array(z.string()).optional(),
  findings: z.array(FindingSchema).default([]),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;



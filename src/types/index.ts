export type SeverityLevel = "low" | "medium" | "high" | "critical";
export type FindingCategory =
  | "security"
  | "correctness"
  | "performance"
  | "maintainability"
  | "testing";
export type ConfidenceLevel = "low" | "medium" | "high";

export interface Finding {
  severity: SeverityLevel;
  category: FindingCategory;
  title: string;
  file: string | null;
  line: number | null;
  description: string;
  evidence: string[];
  why_it_matters: string;
  suggested_fix: string;
  confidence: ConfidenceLevel;
}

export interface ReviewResult {
  summary: string;
  risk_level: SeverityLevel;
  breaking_changes: string[];
  suggestions?: string[];
  findings: Finding[];
}


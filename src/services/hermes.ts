import axios from "axios";
import { ReviewResult } from "../types";
import { CallSite } from "./ast";

const OLLAMA_URL = "http://localhost:11434/api/generate";

export async function runHermesAnalysis(
  diffText: string,
  prTitle: string,
  dominoSites: CallSite[] = [],
): Promise<ReviewResult> {
  const dominoContext = dominoSites.length
    ? dominoSites
        .map(
          (site) =>
            `- File: ${site.callerFile} (Line ${site.line})\n  Call Site: \`${site.snippet}\``,
        )
        .join("\n")
    : "No downstream call sites detected.";

  const prompt = `You are CLIFF AI Agent. Analyze this PR diff for bugs AND potential DOMINO EFFECTS on downstream code.

PR Title: ${prTitle}

=== PRIMARY PR DIFF ===
${diffText}

=== POTENTIAL DOWNSTREAM CALL SITES AT RISK ===
${dominoContext}

Instructions:
1. Check if the PR Diff introduces breaking changes, parameter mismatches, or logic bugs in the downstream call sites.
2. Return ONLY a valid JSON object matching this schema:
{
  "summary": "Short explanation of changes and potential domino impacts",
  "risk_level": "HIGH/MEDIUM/LOW",
  "breaking_changes": ["affected_file_1 or function_1"],
  "suggestions": ["suggestion_1", "suggestion_2"]
}`;

  const response = await axios.post(
    OLLAMA_URL,
    {
      model: "hermes3",
      prompt,
      stream: false,
      format: "json",
    },
    { timeout: 120000 },
  );

  const parsed: ReviewResult = JSON.parse(response.data.response);
  return parsed;
}

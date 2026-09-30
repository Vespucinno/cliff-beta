import axios from "axios";
import dotenv from "dotenv";
import { getPrDiff, publishGithubReview, extractFileContentsFromDiff } from "./services/github";
import { runGeminiAnalysis } from "./services/gemini";

dotenv.config();

// Serverless entry point — designed to run in GitHub Actions (ephemeral runner),
// with zero persistent infrastructure. Requires the following env vars:
//   GITHUB_TOKEN, REPO_NAME, PR_NUMBER  (and optionally GEMINI_MODEL/GEMINI_API_KEY)
function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`[CLIFF Serverless] Missing required environment variable: ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const token = getEnv("GITHUB_TOKEN");
  const repoName = getEnv("REPO_NAME");
  const prNumberRaw = getEnv("PR_NUMBER");

  const prNumber = parseInt(prNumberRaw, 10);
  if (Number.isNaN(prNumber)) {
    throw new Error(`[CLIFF Serverless] Invalid PR_NUMBER: "${prNumberRaw}"`);
  }

  console.log(`[CLIFF Serverless] Fetching PR #${prNumber} from ${repoName}...`);

  const prRes = await axios.get(`https://api.github.com/repos/${repoName}/pulls/${prNumber}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });

  const prTitle = prRes.data?.title || `PR #${prNumber}`;
  const diffUrl = prRes.data?.diff_url;

  if (!diffUrl) {
    throw new Error(`[CLIFF Serverless] Could not determine diff_url for PR #${prNumber}`);
  }

  const diffText = await getPrDiff(diffUrl, token);
  const fileContentMap = extractFileContentsFromDiff(diffText);
  const fileCount = Object.keys(fileContentMap).length;
  console.log(`[CLIFF Serverless] Diff length: ${diffText.length}, ${fileCount} changed file(s).`);

  const reviewData = await runGeminiAnalysis(diffText, prTitle, [], fileContentMap);

  const currentModel = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  console.log(`[CLIFF Serverless] Publishing review (model: ${currentModel}) for PR #${prNumber}...`);
  await publishGithubReview(repoName, prNumber, reviewData, token, diffText);

  console.log(`[CLIFF Serverless] Done. Review published for PR #${prNumber}.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[CLIFF Serverless] Fatal error:", error);
    process.exit(1);
  });
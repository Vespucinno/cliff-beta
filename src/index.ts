import express, { Request, Response } from "express";
import dotenv from "dotenv";
import { getPrDiff, publishGithubReview } from "./services/github";
import { runHermesAnalysis } from "./services/hermes";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

app.use(express.json());

async function processPrWorkflow(payload: any) {
  try {
    const prTitle = payload.pull_request.title;
    const prNumber = payload.pull_request.number;
    const repoName = payload.repository.full_name;
    const diffUrl = payload.pull_request.diff_url;

    console.log(`[CLIFF] Processing PR #${prNumber} for ${repoName}...`);

    const diffText = await getPrDiff(diffUrl, GITHUB_TOKEN);
    const reviewData = await runHermesAnalysis(diffText, prTitle);

    if (GITHUB_TOKEN) {
      await publishGithubReview(repoName, prNumber, reviewData, GITHUB_TOKEN);
      console.log(`[CLIFF] Successfully published review for PR #${prNumber}`);
    } else {
      console.warn("[CLIFF] GITHUB_TOKEN missing. Skipping review publish.");
    }
  } catch (error) {
    console.error("[CLIFF] Workflow error:", error);
  }
}


app.post("/webhook/github", (req: Request, res: Response) => {
  const payload = req.body;
  const action = payload?.action;

  if (["opened", "synchronize"].includes(action)) {
    // Fire-and-forget asynchronous execution
    processPrWorkflow(payload);
  }

  res.status(200).json({ status: "processing" });
});

app.listen(PORT, () => {
  console.log(`[CLIFF] TypeScript Backend active on http://localhost:${PORT}`);
});

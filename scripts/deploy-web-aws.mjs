import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const appId = process.env.AMPLIFY_APP_ID ?? "d21bivg674x6ke";
const branch = process.env.AMPLIFY_BRANCH ?? "main";
const region = process.env.AWS_REGION ?? "us-east-1";
function aws(...args) {
  return JSON.parse(
    execFileSync(
      "aws",
      ["amplify", ...args, "--region", region, "--output", "json"],
      { encoding: "utf8" },
    ),
  );
}
const folder = mkdtempSync(join(tmpdir(), "suica-web-"));
try {
  const zip = join(folder, "site.zip");
  execFileSync("python3", [
    "-c",
    'from pathlib import Path; import zipfile,sys; root=Path("apps/web/dist"); assert (root/"index.html").is_file(), "Build the web app first"; z=zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED); [z.write(p,p.relative_to(root)) for p in root.rglob("*") if p.is_file()]; z.close()',
    zip,
  ]);
  const job = aws(
    "create-deployment",
    "--app-id",
    appId,
    "--branch-name",
    branch,
  );
  const upload = await fetch(job.zipUploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/zip" },
    body: readFileSync(zip),
  });
  if (!upload.ok) throw new Error(`Asset upload failed: HTTP ${upload.status}`);
  const result = aws(
    "start-deployment",
    "--app-id",
    appId,
    "--branch-name",
    branch,
    "--job-id",
    job.jobId,
  );
  console.log(
    JSON.stringify({
      appId,
      branch,
      jobId: job.jobId,
      status: result.jobSummary.status,
    }),
  );
  console.log(
    `Inspect status: aws amplify get-job --region ${region} --app-id ${appId} --branch-name ${branch} --job-id ${job.jobId}`,
  );
} finally {
  rmSync(folder, { recursive: true, force: true });
}

# run-task.ps1 - Usage: .\run-task.ps1 P0-07
param([string]$TaskId)

if (-not $TaskId) {
    Write-Host "Usage: .\run-task.ps1 <TASK_ID>"
    exit 1
}

Write-Host "=== Starting task $TaskId ==="

# Setup branch
git checkout main
git pull
git checkout -b "agent/$($TaskId.ToLower())"

# Agent 1: Build
Write-Host "=== BUILDER AGENT ==="
claude -p "Read PHASE0_TASKS.txt. Complete task $TaskId. Follow the description and acceptance criteria exactly. Commit your changes when done." --allowedTools "Edit" --allowedTools "Write" --allowedTools "Bash"

# Agent 2: Review
Write-Host "=== REVIEWER AGENT ==="
claude -p "Read PHASE0_TASKS.txt, specifically task $TaskId and its acceptance criteria. Now review the code changes on the current branch (use git diff main). Check: 1) Does the code meet all acceptance criteria? 2) Are there any bugs or security issues? 3) Is error handling consistent with the AppError patterns from P0-03? Write your review to REVIEW_$TaskId.txt. If there are critical issues, list them clearly." --allowedTools "Edit" --allowedTools "Write" --allowedTools "Bash"

Write-Host "=== Done. Check REVIEW_$TaskId.txt for the review. ==="
#!/bin/bash
# run-task.sh - Usage: ./run-task.sh P0-06

TASK_ID=$1
BRANCH_NAME=$(grep -A2 "^$TASK_ID:" PHASE0_TASKS.txt | grep "Branch:" | awk '{print $2}')

# If branch name extraction doesn't work, fall back to manual naming
if [ -z "$BRANCH_NAME" ]; then
  BRANCH_NAME="agent/${TASK_ID,,}"
fi

echo "=== Starting task $TASK_ID on branch $BRANCH_NAME ==="

# Setup branch
git checkout main
git pull
git checkout -b $BRANCH_NAME

# Agent 1: Build
echo "=== BUILDER AGENT ==="
claude -p "Read PHASE0_TASKS.txt. Complete task $TASK_ID. Follow the description and acceptance criteria exactly. Commit your changes when done." --allowedTools "Edit,Write,Bash"

# Agent 2: Review
echo "=== REVIEWER AGENT ==="
claude -p "Read PHASE0_TASKS.txt, specifically task $TASK_ID and its acceptance criteria. Now review the code changes on the current branch (use git diff main). Check: 1) Does the code meet all acceptance criteria? 2) Are there any bugs or security issues? 3) Is error handling consistent with the AppError patterns from P0-03? Write your review to REVIEW_$TASK_ID.txt. If there are critical issues, list them clearly." --allowedTools "Edit,Write,Bash"

echo "=== Done. Check REVIEW_$TASK_ID.txt for the review. ==="
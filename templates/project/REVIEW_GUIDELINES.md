# Project Review Guidelines

Use this file as project-local review policy for Pi `/review` or piagent review prompts.

## Review priorities

1. Correctness and data integrity.
2. Security and secret handling.
3. Contract compatibility with upstream/downstream consumers.
4. Minimal, maintainable diff.
5. Tests and verification evidence.

## Required review output

- Findings with severity.
- File/line references when possible.
- Missing verification.
- Risk of regression.
- Recommendation: approve / request changes / block.

## Project-specific additions

Add domain rules here after linking the project.

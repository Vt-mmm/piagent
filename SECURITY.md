# Security policy

## Supported versions

Security fixes are provided for the latest published release only. Older releases and moving development sources do not receive a long-term support guarantee. Team deployments should use an exact release tag or reviewed commit and upgrade after reviewing the changelog and compatibility matrix.

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability. Use [GitHub private vulnerability reporting](https://github.com/Vt-mmm/piagent/security/advisories/new) so maintainers can investigate before details are disclosed.

Include:

- the affected release tag or commit SHA;
- operating system, shell, Node.js version, Pi version, permission profile, and relevant tool name;
- a minimal reproduction using synthetic credentials or files only;
- the observed impact and the result you expected;
- any proposed mitigation or regression test.

Never include real tokens, OAuth sessions, `auth.json`, `.env` contents, customer data, or production credentials. Revoke any credential that may have been exposed before submitting the report.

Maintainers handle reports on a best-effort basis and will coordinate validation, remediation, release notes, and disclosure with the reporter. Accepted reports may use a GitHub Security Advisory and CVE request when appropriate. This project does not currently promise a fixed response-time SLA or long-term support window.

## Security scope

In scope:

- protected-path, path-scope, read-only, confirmation, and secret-redaction bypasses in controlled Pi tool calls;
- capability-lock or policy-integrity bypasses;
- installer, release identity, packaged-artifact, or dependency provenance issues;
- unintended publication of credentials or local runtime state by project templates or package output.

The Piagent guard is an application-level policy enforcement layer, not an operating-system security boundary. Pi packages and trusted repository code run with the operator's OS permissions. A process, dependency, interpreter payload, or tool path outside the guard's observation can access anything allowed by those permissions. Untrusted repositories, prompts, and workloads require a separate container or VM with filesystem, process, network, and credential isolation.

Reports that apply only to an upstream dependency should also be coordinated with that upstream maintainer. Public feature requests, documentation corrections without security impact, and attacks that already require full control of the trusted operating-system account are normally outside this policy.

## Disclosure

Please allow maintainers a reasonable opportunity to reproduce and release a fix before public disclosure. Security fixes will describe affected versions, impact, mitigation, verification, and remaining limitations without publishing live secrets or exploit material that creates unnecessary risk.

# Security

Report a vulnerability privately through GitHub: open the **Security** tab of this repository and choose **Report a vulnerability**. Do not open a public issue.

In scope:
- Code that writes outside the documented agent instruction files, or without a backup and receipt.
- A pack or shared setup that passes validation but injects instructions to fetch remote content, send data, install tools, skip approvals, or override the base policy.
- Secrets or browser session data written to tracked files or logs.

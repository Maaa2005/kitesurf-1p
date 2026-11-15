# kitesurf-1p

[日本語](README.md)

An MCP server for AI browser work. When the AI asks to log in to a site and you approve the request in 1Password, this tool types the username and password straight into the form fields of Kitesurf (Cloudflare's experimental browser for AI). The AI never sees the password. Everything runs on your own PC (Windows + WSL2, free).

What it does: fills in only the logins you approve, and only on the sites you list. The AI gets back only the outcome (submitted, denied, and so on), plus the URL and title of the page after submitting.
What it does not do: fully stop an AI that has free access to your terminal and is determined to extract the password (see "Limitations").

This is a prototype. The author has tested the safety measures but cannot promise there are no holes. Use it at your own risk (no warranty, as stated in Apache-2.0). This is a personal project, not affiliated with Cloudflare or 1Password (AgileBits).

## How it fits together

```
AI ─(MCP)─▶ gate (Node 24 on Windows) ─(CDP)─▶ Kitesurf (127.0.0.1:8787 in WSL)
               │
               └─ a fresh child process per login ── op.exe ──▶ 1Password app (you approve)
```

- Only the gate talks to Kitesurf. The AI gets exactly eight tools: `open`, `snapshot`, `click`, `type`, `press`, `screenshot`, `login_sites`, `login`. There is no tool that runs arbitrary JavaScript.
- On Windows, the 1Password CLI asks for approval per calling process. The gate calls it from a new child process for every login, so the approval prompt appears every time (confirmed on the author's PC).

## Requirements

- Windows 11 with WSL2 running Ubuntu 24.04 (the only combination the author has tested)
- [Kitesurf](https://github.com/cloudflare/kitesurf) built inside WSL (tested at commit 4a29038; the build takes about 15 minutes; building directly on Windows failed)
- Node.js 24 on Windows
- The 1Password desktop app for Windows and 1Password CLI 2.x (tested with 2.41.1; `winget install AgileBits.1Password.CLI`), with CLI integration turned on in the app settings

## Setup

1. Put this repository on Windows and run `npm.cmd ci` (in PowerShell, `npm` may be blocked by the execution policy, so use `npm.cmd`).
2. Start Kitesurf in WSL: `wsl.exe -d Ubuntu-24.04 -u root -- bash <repo path inside WSL>/scripts/kitesurf-dev.sh`. It is running when `http://127.0.0.1:8787/health` returns `kitesurf: OK`.
   If another Windows app already uses port 8787, start Kitesurf with `KITESURF_PORT=8797` and set `KS1P_KITESURF_WS=ws://127.0.0.1:8797/devtools/browser` for the gate.
3. Create the list of sites allowed for login (for example, `%APPDATA%\kitesurf-1p\sites.json`). `item` is the name or ID of the 1Password item.

   ```json
   [{ "name": "github", "origin": "https://github.com",
      "op": { "item": "GitHub", "vault": "Private" } }]
   ```

4. Register it with your AI as an MCP server. For Claude Code, it looks like this (the author has not used it this way yet; untested):

   ```
   claude mcp add kitesurf-1p -e KS1P_SITES=C:\path\to\sites.json -- node C:\path\to\kitesurf-1p\src\server.mjs
   ```

The environment variables (Kitesurf address, log folder, approval timeout, and so on) are listed in the table in [docs/impl-spec.md](docs/impl-spec.md) (in Japanese).

## What `login` does

1. Before touching 1Password, it checks that the top-level page is https, its origin matches the listed origin, there is exactly one password field, the form submits to the same origin, and the form does not use GET. Otherwise, it refuses.
2. It shows a Windows notification with the site and item name, then asks 1Password for the values. You approve the request in the 1Password prompt. If you do not respond within 4 minutes, it gives up.
3. After approval, it runs the checks again. If the page changed while waiting, it discards the values and refuses.
4. It types the values into the fields, submits, and then clears the fields. Other AI tools wait until this finishes.
5. The AI gets only the outcome (`submitted`, `denied`, `timeout`, `mismatch`, `not_found`, `changed`, `error`), the reason, and the URL and title after submitting.

## Keeping the values away from the AI

Kitesurf does not mask password fields. The accessibility tree carries the value as is, and screenshots show it in plain text (confirmed on the author's PC). So the gate does the following:

- It rebuilds the page listing (`snapshot`) and removes the values of password fields and of fields it filled.
- It searches everything returned to the AI for the filled value and its encoded forms (URL, JSON, HTML, base64, hex, and so on). If anything is found, it drops the whole reply.
- URLs are returned without the part after `?` or `#`.
- Screenshots are taken only when no value remains in the fields or page text, and password field text is made transparent during capture.
- It also searches the original text before shortening. It refuses to type passwords shorter than 4 characters because it cannot watch for them.
- In text replies, the username the gate filled in is replaced with `(ID)`.
- It looks for the 1Password CLI only in absolute paths on PATH, never in the working folder. It does not pass environment variables starting with `OP_` to the child process (so settings that return values without an approval prompt are not used).
- If `NODE_DEBUG` is set, data the gate sends to the browser would appear in the logs, so the gate refuses to start.

See section 4 of [docs/design.md](docs/design.md) (in Japanese) for details.

## Tests

- `npm.cmd run test:unit`: unit tests (163; no Kitesurf needed; also run in CI)
- `npm.cmd run test:leak -- --runs 3`: leak test using a fake CLI that returns made-up values instead of 1Password. Needs Kitesurf and WSL. On the author's PC, it passed all three runs with fresh values. It searches seven places (the AI conversation record, the gate's logs, Kitesurf's log, temp folders, and so on); it first confirmed that a planted value is found in each place, and then found zero leaks. If any file cannot be searched, the run fails as inconclusive. A folder that cannot be opened is only counted, not failed, if its own timestamp is still from before the test. Creating, deleting, or renaming anything inside a folder changes the folder's timestamp, so an unchanged timestamp means nothing new was created in it during the test. However, appending to a file that was already inside it cannot be detected.
- `npm.cmd run check:real`: a one-time check with the real 1Password. Create a test item in 1Password first (instructions at the top of `scripts/real-op-check.mjs`). On the author's PC, the approval prompt appeared for both logins, the values matched, and the third attempt was refused after pressing Cancel.

## Limitations

- Resistance to hostile pages has not been tested yet. This version does not run tests with pages that copy the value to the screen or to another site, lure the AI to a fake login page, or make it reveal the password.
- The AI runs with your privileges. This tool guards against the AI seeing the password by accident and against an AI steered by page text pulling it out through the tools. It cannot fully stop a determined AI with free access to your terminal.
- If the AI calls the 1Password CLI itself, an approval prompt also appears. The prompt shows only the name of the calling process, so it is hard to tell apart from the gate's request. Approve only right after you ask for a login and the gate's notification appears.
- Even with the URL checked right before typing, a page that navigates away at that exact moment could receive the value.
- Kitesurf's CDP endpoint (127.0.0.1:8787) has no authentication. A second connection gets a separate browser and could not see the gate's page, but this is not guaranteed.
- The site you log in to receives the value. If it draws the value as an image (canvas), the text search cannot find it.
- Passkeys and two-factor authentication are up to you (Kitesurf does not support passkeys).
- If a page shows only part of the value (for example, the first half) on screen or in text, the gate cannot detect it. It only searches for the full value and its encoded forms.
- Usernames are not hidden in screenshots or on the page after login. This tool protects the password; the AI may see the username.
- Any program with your privileges can show a notification that looks the same as the gate's. The notification and approval prompt alone cannot fully distinguish a real request from a fake one.
- By checking whether a reply is blocked with "contains a protected value", the AI can test whether a guessed string matches the password. Do not use this tool with easy-to-guess passwords.
- Some of the gate's steps (clearing a field, reading a value's length, getting the title) run inside the page, so the page can fake their results.
- Even on the right site, other scripts loaded by the page can read the value between typing and submission. The gate cannot restrict where the page itself sends data.
- The settings (environment variables and `sites.json`) are trusted. If an AI with your privileges edits them, it can weaken the protection. The last line of defense is checking that the 1Password item's URL matches the listed origin.
- The gate's log (`%LOCALAPPDATA%\kitesurf-1p\logs`) records the origin and path of pages it opens. There is no size limit.
- The author ran Kitesurf as root in WSL. Kitesurf's dev server (wrangler 4.131.2) listens only on localhost on Linux.
- Tested only on Windows with WSL2. Not run on Mac or Linux.

Rejected alternatives and the reasons are in section 6 of [docs/design.md](docs/design.md) (in Japanese).

## License

Apache-2.0 ([LICENSE](LICENSE)). See [SECURITY.md](SECURITY.md) for reporting security problems.

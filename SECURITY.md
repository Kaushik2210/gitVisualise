# Security Policy

## Supported versions

The latest release on `main` is supported.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**
(private vulnerability reporting). Include a description, steps to reproduce, and the impact you foresee.

You can expect an acknowledgement within a few days. Confirmed issues are fixed as quickly as possible and credited
in the release notes unless you prefer otherwise.

## What is in scope

gitvisualise analyses **untrusted repositories**, so the areas we care most about are:

- Script injection through repository content (file names, comments, dependency names) reaching the website or a
  generated tour. Repo text must only ever be inserted with `textContent` or HTML-escaped, and generated JSON must
  be safe inside `<script>` tags.
- The sandbox around the tour frame on the website, and any way for repository content to reach the page or a
  user's GitHub token.
- Path handling in the CLI (for example reading or writing outside the target repository or output folder).
- The GitHub Action's handling of its inputs.

## Handling of GitHub tokens

A token entered on the website is sent only to `api.github.com` from the visitor's browser. It is held in memory
unless the visitor ticks "Remember on this device". The project has no server that receives tokens.

# Prompts to paste into Claude Opus 5.5

Fill in nothing: both prompts are self-contained. Real facts are included so the model cannot invent features.

---

## Prompt 1: cinematic motion graphics sequence

```
You are a motion-design director and creative technologist. Produce a complete,
shot-by-shot production plan AND working code for a 45-second cinematic motion
graphics sequence that explains an open-source developer tool, for LinkedIn
(1080x1350 vertical or 1920x1080) and the top of a GitHub README (looping GIF/MP4).

PRODUCT (use only these facts, invent nothing):
- Name: gitvisualise. Tagline: "Paste a GitHub link. Get an animated, narrated,
  click-through map of how the repo works."
- Problem: onboarding onto a codebase means reading a hundred files to answer
  "what talks to what, and where do I start?" Hand-drawn diagrams go stale.
- How it works: scans the repo (import graphs for 13 languages), builds components
  and relationships, generates narrated step-by-step tours. Every box and arrow
  links to a real file and line; a validator rejects anything it cannot point to.
- Runs entirely in the browser: no sign-up, no server, no API keys. Zero dependencies. MIT.
- Features to show: guided tour with camera that zooms to each step; request
  tracing (client fetch -> server route); compare two revisions (green added,
  red removed, amber changed); Docker Compose + SQL data-model views; search,
  swimlanes, export SVG/PNG/Mermaid, print to PDF; colour-blind-safe palette.
- URL: kaushik2210.github.io/gitVisualise

VISUAL LANGUAGE:
- Dark, deep navy (#0f1420) with soft grain; accents green #1faa6b, blue #3b82f6,
  violet #8b5cf6 (the site's gradient). Type: Inter or similar, heavy headline weight.
- The hero metaphor is a node graph: a chaotic cloud of dots (a messy codebase)
  that resolves into an ordered left-to-right architecture, then a spotlight
  travels edge by edge while captions appear.

STRUCTURE (beats with timecodes):
1. 0-4 s  Chaos: hundreds of drifting file nodes, cursor-reactive, text "Where do I even start?"
2. 4-8 s  A GitHub URL types into a search box; "Visualise" pulses.
3. 8-16 s Order emerges: nodes snap into layers, edges draw on with easing; camera pushes in.
4. 16-26 s The tour: highlight travels step to step; narration card slides in; a code
   snippet chip with file:line pops up. Show a "validator" stamp rejecting an invented box.
5. 26-34 s Compare: two graphs merge, additions glow green, removal collapses red, change pulses amber.
6. 34-40 s Rapid montage of features (request tracing arrow, data-model tables, PDF page, palette switch).
7. 40-45 s Logo + tagline + URL + "Free. Open source. Runs in your browser."

DELIVERABLES:
A. Shot list table: time, visual, camera move, easing curve, caption text, sound cue.
B. A complete single-file HTML/JS implementation using GSAP and three.js (CDN),
   deterministic and scrubbable by a master timeline so I can capture it
   frame-by-frame with a headless browser at 60 fps.
C. A Node script (Chrome DevTools Protocol, no dependencies) that steps the
   timeline, captures PNG frames, and an ffmpeg command to produce MP4 (H.264,
   yuv420p, +faststart) and a palette-optimised GIF under 8 MB.
D. A music/sound-design brief (tempo, riser, hits on each beat) and caption file (SRT).
E. Accessibility: captions burned in, no flashing above 3 Hz, readable on a phone muted.

Constraints: no stock footage, no invented statistics, no logos of other companies.
Explain any assumption before using it.
```

---

## Prompt 2: make the project the best it can be on GitHub and LinkedIn

```
You are a developer-relations lead and open-source growth strategist. Audit and
upgrade the launch presence of this project for GitHub and LinkedIn. Be specific,
ruthless, and honest: say what is weak, then fix it.

PROJECT: gitvisualise (github.com/Kaushik2210/gitVisualise), site
kaushik2210.github.io/gitVisualise. Turns any GitHub repo into an animated,
narrated architecture tour; every box/arrow links to real file+line; runs in the
browser; 13 languages; zero dependencies; MIT. Also: CLI, GitHub Action, Claude
Code skill, VS Code extension. Open issues labelled good-first-issue exist.

I will paste: (1) README.md, (2) the repo's About/topics, (3) CONTRIBUTING.md,
(4) my current LinkedIn profile headline/about. Review them and return:

1. GITHUB (rank every item by impact, effort S/M/L)
   - README above-the-fold teardown: first 5 seconds, hero asset, one-line value
     prop, badges worth keeping, install-in-one-command. Rewrite the top 40 lines.
   - Repo About text (<=350 chars) and 15 topics, optimised for GitHub search.
   - Social preview image (1280x640) brief.
   - Issue/PR templates, labels, "good first issue" quality, Discussions setup,
     release notes style, a CHANGELOG highlight for the next release.
   - Distribution: which awesome-lists to PR (exact repo names), Show HN title +
     first comment, Product Hunt tagline + gallery order, relevant subreddits
     with their self-promotion rules, dev.to/Hashnode article outline.
2. LINKEDIN
   - Profile headline + About rewrite that positions me as the maker.
   - 3 post drafts (story, demo, technical deep dive), each with a hook under 140
     characters, native-video guidance, hashtags (max 5), best posting time.
   - A 14-day posting calendar tied to real milestones (release, new language,
     contributor shout-out), plus a comment-reply playbook for the first hour.
3. METRICS: what to track weekly (stars, unique visitors, clones, tours generated,
   contributors) and what a good first month looks like for a project this size.
4. ANTI-PATTERNS: anything that looks like fake growth (star-for-star, bots,
   spam) that I must NOT do, and why.

Rules: use only facts I give you; flag anything you could not verify; no
invented numbers or testimonials; keep every suggested claim defensible.
Output as a prioritised checklist first, then the rewritten copy.
```

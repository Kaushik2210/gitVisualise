# LinkedIn video: gitvisualise

`gitvisualise-linkedin.mp4` (same folder) is the finished 36 s, 1920x1080, 30 fps video with sound and captions burned in. It opens in a 3D node cloud (three.js) that assembles into commander.js's real modules as glowing 3D blocks with a travelling camera, then shows the real tour in a browser-window frame that flies in with perspective, the version comparison, and an end card with the URL. Audio is a synthesized ambient pad, arpeggio, riser and low hits that duck under a text-to-speech voice-over (Windows voice "David", so it sounds synthetic: re-record the lines below yourself for a more human feel and replace the audio in any editor).

## What is on screen (timings match the video)

| Time | On screen | Caption (large, bottom third) |
|---|---|---|
| 0-3 s | Website hero, cursor typing `tj/commander.js` | **Onboarding onto a new codebase takes days.** |
| 3-6 s | Click Visualise, tour appears | **Paste a GitHub link. Get a narrated tour.** |
| 6-15 s | Tour stepping through steps with zoom-to-step | **Every box and arrow links to a real file and line.** |
| 15-20 s | Click a component, source link opens | **Nothing is invented. A validator rejects what it cannot point to.** |
| 20-24 s | Diff view (green / red / amber) | **Compare two versions: what was added, removed, changed.** |
| 24-30 s | Hero + URL | **Free. Open source. Runs in your browser. 14 languages, zero dependencies.** `kaushik2210.github.io/gitVisualise` |

Voice-over (optional, ~75 words): "Onboarding onto a new codebase means reading a hundred files to answer one question: what talks to what? gitvisualise answers it. Paste any GitHub link and get an animated, narrated tour. Every box and arrow points at real code, and a validator rejects anything it can't prove. You can even compare two versions of a repo. It's free, open source, and runs entirely in your browser."

## Post copy (paste under the video)

> I got tired of opening an unfamiliar repo and spending two days just working out where things live.
>
> So I built **gitvisualise**: paste a GitHub link and get an animated, narrated, click-through map of how the project works.
>
> What makes it different from yet another diagram generator:
> - Every box and arrow links to a real file and line. A validator rejects anything it can't point to, so nothing is made up.
> - It runs 100% in your browser. No sign-up, no server, no API keys.
> - 14 languages, zero dependencies, MIT licensed.
> - Compare two versions (`owner/repo@v5...v11`) to see what was added, removed, or changed.
> - Add it to your own repo with one command: `gitvisualise init` (tour + GitHub Action + README badge)
>
> Try it on a repo you know: https://kaushik2210.github.io/gitVisualise/
> Code: https://github.com/Kaushik2210/gitVisualise
>
> It's my open-source project and there are good-first-issues open if you want to contribute a language or a view. A star helps others find it.
>
> #opensource #developertools #softwarearchitecture #github #javascript


## Posting notes

- Upload the MP4 natively (not a YouTube link): native video gets far more reach.
- First line must work on its own; LinkedIn truncates after ~2 lines.
- Post Tuesday-Thursday morning in your timezone, and reply to every comment in the first hour.
- Put the links in the post body, not only in the first comment, or say "link in first comment" and actually add it immediately.
- Tag the maintainers of repos you showcase (e.g. tj/commander.js) only if you are comfortable with it; ask first.

## About "Paperclip"

The "Paperclip" I found is an open-source **AI agent orchestrator** (paperclipai/paperclip), not a promotion tool. If you meant something else (a launch platform, a newsletter, a growth tool), tell me its name or link and I will research it. Channels that are known to work for open-source dev tools: Show HN, Product Hunt, r/programming + r/opensource + r/webdev (follow each sub's self-promo rules), dev.to / Hashnode write-up, "awesome-*" list PRs, GitHub topics + a good social-preview image, and a short demo video in the README.

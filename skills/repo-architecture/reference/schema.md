# architecture.json schema (version 1)

Lives at `docs/architecture/architecture.json`. Paths in `sources` are relative to the repository root, use `/`, and
must match exact case. `node scripts/gitvisualise.mjs validate` enforces everything below.

```jsonc
{
  "schemaVersion": 1,
  "project": {
    "name": "my-app",                       // required
    "description": "One or two sentences.", // shown in the header and overview step
    "repoUrl": "https://github.com/o/r",    // enables "Open Source" links (github.com only)
    "branch": "main", "commit": "abc123...",// links pin to commit when present
    "generatedBy": "heuristic | claude",
    "notes": ["Anything out of scope or approximate."],
    "locked": ["description"]               // optional: project fields the generator must not overwrite
  },
  "nodes": [
    {
      "id": "events-api",                   // unique, [A-Za-z0-9_.:-]
      "label": "events.js",                 // shown on the diagram (long labels are truncated)
      "kind": "api",                        // entry | ui | api | service | data | util | config | external | module | <any>
      "summary": "What it does, 1-3 sentences.",
      "tech": ["JavaScript", "axios"],      // optional chips
      "group": "Backend",                   // optional swimlane; the viewer offers "By group" when any node has one
      "external": false,                    // true for third-party systems/libraries (sources optional)
      "origin": "auto | claude | manual",   // who owns it (see merge rules)
      "locked": true,                       // or ["summary", "label"]: fields kept on regeneration
      "position": { "x": 320, "y": 80 },    // optional hand-placed layout (otherwise auto layered layout)
      "sources": [                          // REQUIRED (except external): evidence in the repo
        { "path": "src/api/events.js", "lines": [1, 16], "note": "optional" }   // lines optional; dirs allowed without lines; "commit" pins evidence to another revision (comparisons)
      ]
    }
  ],
  "edges": [
    {
      "id": "e-app--events-api",
      "from": "app", "to": "events-api",    // node ids; direction = "depends on / calls"
      "kind": "imports",                    // imports | uses | calls | http | depends | builds | references | reads | writes | <any>
      "label": "fetchEvents",               // shown when active/hovered
      "summary": "Optional longer text.",
      "origin": "auto",
      "sources": [{ "path": "src/App.jsx", "lines": [4, 4] }]   // strongly recommended; imports edges are checked
    }
  ],
  "flows": [
    {
      "id": "startup", "title": "How the app starts", "description": "Optional.", "origin": "claude",
      "steps": [
        {
          "id": "s1",
          "title": "Browser loads the page",
          "nodes": ["index-html"],           // highlighted; at least one node or edge is required
          "edges": ["e-index-html--main"],   // animated; their endpoints highlight too
          "narration": "Spoken and captioned text, 1-3 sentences.",   // REQUIRED
          "sources": [{ "path": "index.html", "lines": [10, 10] }],   // shown as "</> path:line" chips
          "origin": "claude"
        }
      ]
    }
  ]
}
```

## Ownership (`origin`, `locked`)

| Marker | Meaning |
|---|---|
| `origin: "auto"` (default) | Produced by the heuristic generator; refreshed or dropped on regeneration |
| `origin: "claude"` | Written or curated by Claude; kept verbatim |
| `origin: "manual"` | Written by a human; kept verbatim |
| `locked: true` | Kept verbatim regardless of origin |
| `locked: ["summary"]` | Item regenerates but keeps those fields |

## Comparisons (`diff`)

`gitvisualise diff <older> <newer>` and the website's `owner/repo@base...head` produce an architecture in which every node and edge carries an optional
`diff` of `added | removed | changed | same` (matched by id, so a moved file is a removal plus an addition). Nodes that changed also carry a
`diffNote` (what the description used to say). Evidence for a **removed** item lives in the older tree, so its sources carry a `commit`;
the validator only checks their shape, and the viewer links them to that commit. `project.compare` records `{ base: { ref, commit }, head: { ref, commit } }`,
and a generated **What changed** flow comes first.

## Validation errors you will actually see

- `"src/x.js" does not exist in the repository` — wrong path, wrong case, or the file was moved.
- `lines 10-99 exceed "src/x.js" (40 lines)` — stale line numbers after the file shrank.
- `step ... node "foo" does not exist` — step references an id that is not in `nodes`.
- `mentions \`src/y.js\` but that path does not exist` — a backticked path in narration/summary is not real.
- `narration is required` — every step needs text.

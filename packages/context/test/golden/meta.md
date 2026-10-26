# Golden prompt: meta

a metadata tool: system, project summary and task only.

Prompt: 295 tokens against a total budget of 12000; over budget: no.

| layer | included | base | budget | tokens | kept | dropped |
|---|---|---|---|---|---|---|
| L0 | yes | - | - | 197 | 0 | 0 |
| LI | no | 1500 | - | 0 | 0 | 0 |
| L1 | yes | 1500 | 1500 | 79 | 0 | 0 |
| L2 | no | - | - | 0 | 0 | 0 |
| L3 | no | - | - | 0 | 0 | 0 |
| L4 | no | - | - | 0 | 0 | 0 |
| L5 | no | - | - | 0 | 0 | 0 |
| L6 | no | - | - | 0 | 0 | 0 |
| L7 | yes | - | - | 19 | 0 | 0 |

## System message

```text
Caotang writing agent, system prompt v1.

You act on one open project through the tools listed below. Each call runs through the app's command bus, so every change is recorded and can be undone as one undo group. Work from the context you are given. If the context does not say a fact, say so; do not invent it.

Plans: for multi-step work, propose ordered steps. Each step is one tool call with its parameters and the effect you expect. The writer approves a plan once, and confirm-class tools run only after that approval.

Errors: a tool error names the corrective tool. Follow it, and do not repeat a failed call unchanged.

Tools:
- project.overview()
- doc.read(doc, range?, response_format?)
- scene.draft(doc, instruction, mode?, target_words?, selection?)
- codex.write(entries)
```

## User message

```text
# Project
Title: Harbor Notes
Documents: 6. Words: 930.
Session: 412 words today, target 1,000.
Statuses: draft (Draft), revised (Revised), final (Final).
Labels: none.
Saved filters: 0. Goals: 0.
Binder:
- Manuscript (folder)
  - Act I (folder)
  - Act II (folder)
- Research (folder)
  - Research notes (document)

# Task

Summarise the project in two sentences.

Tool: meta
Parameters: {}
```

# Golden prompt: synopsis-fill

synopsis.fill, the whole focus document, structure, no codex.

Prompt: 1297 tokens against a total budget of 29700; over budget: no.

| layer | included | base | budget | tokens | kept | dropped |
|---|---|---|---|---|---|---|
| L0 | yes | - | - | 197 | 0 | 0 |
| LI | no | 1500 | - | 0 | 0 | 0 |
| L1 | yes | 1500 | 1500 | 79 | 0 | 0 |
| L2 | no | - | - | 0 | 0 | 0 |
| L3 | yes | 1200 | 1200 | 72 | 4 | 0 |
| L4 | no | - | - | 0 | 0 | 0 |
| L5 | yes | 25000 | 26128 | 925 | 1 | 0 |
| L6 | no | - | - | 0 | 0 | 0 |
| L7 | yes | - | - | 24 | 0 | 0 |

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

# Structure

## Manuscript (folder)
The whole novel: a town that keeps its secrets in the fog.

## Act I (folder)
Arrival and the first clues.

## Chapter 1 (document)
Elena reaches the harbor town and takes a room above the chandlery.

## Chapter 2 (document)
(no synopsis — Chapter 2)

# Focus

Document: Chapter 3 (full text; 3,598 of 3,598 characters)

The fog lifted off the harbor a little after dawn, and Elena watched the boats come in from the north wall. She had walked out to the breakwater before anyone was awake, because the maps disagreed about where the old channel ran, and she wanted to see the water for herself.

The lighthouse keeper was already on the gallery. He did not wave. When she reached the foot of the tower he came down the iron stair with a lantern he did not need, and looked at her map case as if it had insulted him.

Her name is Mara, the keeper said, though he did not say whether he meant it as an introduction or a warning. Mara keeps the light. Mara keeps the log. Mara does not care for people who draw things they have not measured.

Elena said that she measured everything she drew. Mara laughed, once, the way a gull does when it is not pleased with the weather. Then she asked which map had put the old channel on the east side of the breakwater, and Elena showed her.

The keeper’s cottage stood a little back from the tower, with a garden of salt-burnt cabbages and a bench nobody had sat on in years. Mara did not invite her in. She made tea on a spirit stove in the open doorway and handed Elena a cup without a saucer, as though the cup were a test of something.

Elena asked about the log. Mara said that it recorded the lamp, the weather, and the boats that passed within sight of the light, and that it had never once recorded a boat that was not there. She said this with a flatness that made Elena want to ask a second question, and she did not.

Overhead the gulls were working the wind above the sheds, and below them the tide had turned. Mara checked her watch against the bell in the tower, wrote something in a small black book, and said that the channel would be passable by noon if the fog held off.

Elena had heard the same thing from three people already that morning. Each of them had given a different hour, and each of them had looked at the sea before they gave it.

They walked the tide line together for an hour. Mara knew the sandbars by their colour and the wrecks by their names. She had been keeping the log since her father died, and she had never once written down a guess.

At the seaward end of the breakwater the water was clear enough to see the stones of the old wall, running out under the surface in a straight line that no current would have made. Mara crouched beside it and put her palm flat on the wet granite.

This is the wall the fog law was written for, she said. Nobody built it to stop the sea. They built it to keep the town from sailing out of sight of the light, so that the fog could never hide a boat from the people who were paid to watch for it.

Elena asked who had been paid to watch. Mara did not answer that. She stood, brushed her hands on her coat, and looked back at the harbor, where Captain Hale was shouting at a boy about a rope.

Hale has been asking about you, Mara said. He thinks the cartographer is working for the ferry company. He thinks the ferry company wants the channel closed so the wolf can be sold to the rich men on the far shore.

The wolf is a dog, Elena said. A grey one, with a limp. I saw it sleeping in the chandler yard.

Mara looked at her for a long time. Then she said that Elena should go back to the town and draw the channel exactly as the water showed it, and that she should not show the drawing to Hale, or to the Silver Gull, or to anyone who asked for a copy.

Elena went back along the breakwater with the wind in her face. The light came on behind her, a little late, and she did not turn round to watch it.

<<< current text ends here >>>

# Task

Write a synopsis of this chapter in one paragraph.

Tool: synopsis.fill
Parameters: {}
```

# Fixtures

Real `SKILL.md` files from public repositories, kept byte for byte so the reader is held to what skills look like in the wild.

| File | Source | Licence |
|---|---|---|
| `openai-linear.SKILL.md` | openai/skills, `skills/.curated/linear` | Apache-2.0 |
| `openai-gh-fix-ci.SKILL.md` | openai/skills, `skills/.curated/gh-fix-ci` | Apache-2.0 |
| `openai-yeet.SKILL.md` | openai/skills, `skills/.curated/yeet` | Apache-2.0 |
| `openai-notion-knowledge-capture.SKILL.md` | openai/skills, `skills/.curated/notion-knowledge-capture` | MIT |
| `anthropics-mcp-builder.SKILL.md` | anthropics/skills, `skills/mcp-builder` | Apache-2.0 |

They cover a plain description, a double-quoted name and description, and a `metadata:` map. The folded (`>`), literal (`|`) and
multi-line quoted shapes, which the public skills that carry them do not licence for copying, are written out in `frontmatter.test.ts`.

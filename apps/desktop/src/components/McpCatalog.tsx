/**
 * What a connected server lists beyond its tools (extensibility §3.5): prompts, resource templates and resources. Read-only here: the
 * rows say what the server wrote, in full, and whether the writer has reviewed it. Nothing on this card attaches a resource or runs a
 * prompt.
 */

import { UserText } from '../i18n/UserText.js';
import { accessibleText } from '../i18n/accessible-text.js';
import { isolate } from '@caotang/i18n';
import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import type { ReactNode } from 'react';
import type { CatalogStatus, ExternalPromptDescriptor, ExternalResourceDescriptor, ReviewCard } from '@caotang/mcp-client';

import { toolStatusLabel } from '../app/mcp-model.js';


/* lingui-set comment="The MCP catalog. Interpolated values: name and names are text a server supplied; reason is a failure message the server gave; the count is a number." */
type Argument = { readonly name: string; readonly description: string; readonly required: boolean };

function Arguments({ items, label }: { items: readonly Argument[]; label: string }): ReactNode {
  if (items.length === 0) return null;
  return (
    <ul className="mcp-arguments" aria-label={accessibleText(label)}>
      {items.map((argument) => (
        <li key={argument.name}>
          <code>{argument.name}</code>
          {argument.required ? ' (required)' : ''}
          {argument.description === '' ? '' : `: ${argument.description}`}
        </li>
      ))}
    </ul>
  );
}

function Described({ label, text }: { label: string; text: string }): ReactNode {
  useLingui();
  return (
    <pre className="mcp-description" aria-label={accessibleText(label)}>
      {text === '' ? t`(no description from the server)` : text}
    </pre>
  );
}

/** The prompts and resource templates of a review, each in full with its status, and what is gone since the last review. */
export function CatalogReview({ review }: { review: ReviewCard }): ReactNode {
  useLingui();
  if (review.prompts.length + review.resourceTemplates.length + review.removedPrompts.length + review.removedTemplates.length === 0) return null;
  return (
    <>
      {review.prompts.length > 0 ? (
        <>
          <h6><Trans>Prompts</Trans></h6>
          <ul className="mcp-review-tools" aria-label={t`Prompts of this server`}>
            {review.prompts.map((prompt) => (
              <li key={prompt.name} data-prompt-review={prompt.name}>
                <p>
                  <code>{prompt.name}</code> <span className={`mcp-pin is-${prompt.status}`}>{toolStatusLabel(prompt.status)}</span>
                </p>
                <Described label={accessibleText(t`Full description of prompt ${{ name: isolate(prompt.name) }}`)} text={prompt.description} />
                <Arguments items={prompt.arguments} label={accessibleText(t`Arguments of ${{ name: isolate(prompt.name) }}`)} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {review.resourceTemplates.length > 0 ? (
        <>
          <h6><Trans>Resource templates</Trans></h6>
          <ul className="mcp-review-tools" aria-label={t`Resource templates of this server`}>
            {review.resourceTemplates.map((template) => (
              <li key={template.uriTemplate} data-template-review={template.uriTemplate}>
                <p>
                  <code>{template.uriTemplate}</code> <span className={`mcp-pin is-${template.status}`}>{toolStatusLabel(template.status)}</span>
                </p>
                <Described label={accessibleText(t`Full description of template ${{ name: isolate(template.uriTemplate) }}`)} text={template.description} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {review.removedPrompts.length > 0 ? <p className="field-note">{t`Prompts removed since the last review: ${{ names: isolate(review.removedPrompts.join(', ')) }}.`}</p> : null}
      {review.removedTemplates.length > 0 ? (
        <p className="field-note">{t`Resource templates removed since the last review: ${{ names: isolate(review.removedTemplates.join(', ')) }}.`}</p>
      ) : null}
    </>
  );
}

/**
 * The card's standing listing, once there is no review open: what the server offers beyond tools, its pin state, and why a list is
 * missing. A list that failed is told in the server's words and never changes the server's state.
 */
export function CatalogRows({
  status,
  prompts,
  resources,
  showLists,
}: {
  status: CatalogStatus;
  prompts: readonly ExternalPromptDescriptor[];
  resources: readonly ExternalResourceDescriptor[];
  showLists: boolean;
}): ReactNode {
  useLingui();
  const templates = resources.filter((resource) => resource.template);
  const plain = resources.filter((resource) => !resource.template);
  const plainCount = plain.length;
  const lists = showLists && prompts.length + templates.length > 0;
  if (!lists && plain.length === 0 && status.resourcesUnavailable === undefined && status.promptsUnavailable === undefined && !status.cut) return null;
  return (
    <section className="mcp-catalog" aria-label={t`Prompts and resources`} data-testid="mcp-catalog">
      {status.resourcesUnavailable === undefined ? null : (
        <p className="field-note" role="status" data-testid="mcp-resources-unavailable">
          {t`resources unavailable: ${{ reason: status.resourcesUnavailable }}`}
        </p>
      )}
      {status.promptsUnavailable === undefined ? null : (
        <p className="field-note" role="status" data-testid="mcp-prompts-unavailable">
          {t`prompts unavailable: ${{ reason: status.promptsUnavailable }}`}
        </p>
      )}
      {status.cut ? <p className="field-note"><Trans>This server lists more than Caotang keeps. Only the first part of each list is shown.</Trans></p> : null}
      {plain.length > 0 ? (
        <p className="field-note" data-testid="mcp-resource-count">
          {plural(plainCount, { one: '# resource listed by this server.', other: '# resources listed by this server.' })}
        </p>
      ) : null}
      {lists ? (
        <ul className="mcp-review-tools" aria-label={t`Prompts and resource templates`}>
          {prompts.map((prompt) => (
            <li key={`prompt:${prompt.name}`} data-prompt={prompt.name}>
              <p>
                <Trans>Prompt <code><UserText value={prompt.name} /></code></Trans> <span className={`mcp-pin is-${prompt.pinState}`}>{toolStatusLabel(prompt.pinState)}</span>
              </p>
              <Described label={accessibleText(t`Full description of prompt ${{ name: isolate(prompt.name) }}`)} text={prompt.description} />
              <Arguments items={prompt.arguments} label={accessibleText(t`Arguments of ${{ name: isolate(prompt.name) }}`)} />
            </li>
          ))}
          {templates.map((template) => (
            <li key={`template:${template.uri}`} data-template={template.uri}>
              <p>
                <Trans>Resource template <code><UserText value={template.uri} /></code></Trans> <span className={`mcp-pin is-${template.pinState}`}>{toolStatusLabel(template.pinState)}</span>
              </p>
              <Described label={accessibleText(t`Full description of template ${{ name: isolate(template.uri) }}`)} text={template.description} />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

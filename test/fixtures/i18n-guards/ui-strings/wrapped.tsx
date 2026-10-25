import { defineMessage, msg, plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';

/** Everything here is already a message, so the ratchet must count nothing. */
export function Wrapped({ name, count }: { name: string; count: number }) {
  const save = t`Save changes`;
  const greeting = msg({ message: 'Hello {name}', comment: 'Greets the writer.' });
  const defined = defineMessage({ message: 'Saved', comment: 'Names the completed save.' });
  const pages = plural(count, { one: '# page', other: '# pages' });
  const reference = { id: 'home.empty', message: 'No projects here yet' };
  return (
    <div title={save}>
      <Trans>Settings</Trans>
      <Trans>
        Delete <strong>{name}</strong>?
      </Trans>
      <span>{greeting}</span>
      <span>{defined.message}</span>
      <span>{pages}</span>
      <span>{reference.message}</span>
    </div>
  );
}

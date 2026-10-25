import { msg, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';

/** Everything here is already a message, so the ratchet must count nothing. */
export function Wrapped({ name }: { name: string }) {
  const save = t`Save changes`;
  const greeting = msg({ message: 'Hello {name}', comment: 'Greets the writer.' });
  const reference = { id: 'home.empty', message: 'No projects here yet' };
  return (
    <div title={save}>
      <Trans>Settings</Trans>
      <Trans>
        Delete <strong>{name}</strong>?
      </Trans>
      <span>{greeting}</span>
      <span>{reference.message}</span>
    </div>
  );
}

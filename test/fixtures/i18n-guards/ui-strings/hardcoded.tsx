import { useEffect, useRef } from 'react';
import { Trans } from '@lingui/react/macro';

/** A deliberately unwrapped surface for the ratchet test (I8). */
export function Hardcoded({ count, onClose }: { count: number; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.textContent = 'No projects here yet';
  }, []);
  const summary = `${count} projects selected`;
  return (
    <div ref={ref} className="dialog" data-testid="dialog" title="Close dialog">
      <button type="button" aria-label="Close dialog" onClick={onClose}>
        ×
      </button>
      <p>Choose a project to begin.</p>
      <span>{summary}</span>
      <Trans>Settings</Trans>
      <input type="text" placeholder="Search projects" />
      <span>{'application/json'}</span>
    </div>
  );
}

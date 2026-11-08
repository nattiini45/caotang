import { createContext, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const ModeTarget = createContext<HTMLElement | null | undefined>(undefined);
const SetModeTarget = createContext<((target: HTMLDivElement | null) => void) | null>(null);

export function DocumentModeProvider({ children }: { children: ReactNode }): ReactNode {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  return (
    <SetModeTarget value={setTarget}>
      <ModeTarget value={target}>{children}</ModeTarget>
    </SetModeTarget>
  );
}

export function DocumentModeOutlet(): ReactNode {
  const setTarget = useContext(SetModeTarget);
  return <div className="document-mode-outlet" ref={setTarget} />;
}

export function useSeparateDocumentModes(): boolean {
  return useContext(ModeTarget) !== undefined;
}

export function DocumentModes({ children }: { children: ReactNode }): ReactNode {
  const target = useContext(ModeTarget);
  if (target === undefined) return children;
  return target === null ? null : createPortal(children, target);
}

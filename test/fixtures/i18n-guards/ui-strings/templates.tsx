/** Prose templates count; path and class-name templates do not. */
export function Templates({ count, id }: { count: number; id: string }) {
  const selected = `${count} items selected`;
  const path = `/api/projects/${id}`;
  const className = `project-${id}`;
  const storage = 'caotang.pending.';
  const dotted = `prompt.${id}`;
  const media = '(prefers-color-scheme: dark)';
  const mime = 'image/png,image/jpeg,image/webp';
  const font = `400 ${id} "Comic Neue", "Comic Sans MS", sans-serif`;
  const regex = `\\bline ${id}\\b`;
  const classes = `sp-line sp-line-${id}`;
  const filename = `${id}.zip`;
  const empty = '';
  const technical = [storage, dotted, media, mime, font, regex, classes, filename].join('|');
  return (
    <span data-path={path} data-class={className} data-empty={empty} data-technical={technical}>
      {selected}
    </span>
  );
}

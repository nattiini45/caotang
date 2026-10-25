/** Prose templates count; path and class-name templates do not. */
export function Templates({ count, id }: { count: number; id: string }) {
  const selected = `${count} items selected`;
  const path = `/api/projects/${id}`;
  const className = `project-${id}`;
  const empty = '';
  return (
    <span data-path={path} data-class={className} data-empty={empty}>
      {selected}
    </span>
  );
}

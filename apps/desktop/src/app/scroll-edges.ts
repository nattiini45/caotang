import '../scroll-edges.css';

const SURFACES = 'dialog[open]:not(.settings, .modern-palette), .settings-body, .settings-nav, .rail-panel, .modern-sidebar-panel, .modern-drawer-panel';

export function scrollEdges(element: Pick<HTMLElement, 'scrollTop' | 'scrollLeft' | 'scrollHeight' | 'scrollWidth' | 'clientHeight' | 'clientWidth'>): string {
  const edges: string[] = [];
  if (element.clientHeight > 0 && element.scrollHeight > element.clientHeight + 1) {
    if (element.scrollTop > 1) edges.push('top');
    if (element.scrollTop < element.scrollHeight - element.clientHeight - 1) edges.push('bottom');
  }
  if (element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1) {
    if (element.scrollLeft < -1 || element.scrollLeft > 1) edges.push('start');
    if (Math.abs(element.scrollLeft) < element.scrollWidth - element.clientWidth - 1) edges.push('end');
  }
  return edges.join(' ');
}

export function installScrollEdges(root: HTMLElement): () => void {
  let frame = 0;
  const watched = new Set<HTMLElement>();
  let observed = new Set<Element>();
  const refresh = (): void => {
    frame = 0;
    const surfaces = new Set(root.querySelectorAll<HTMLElement>(SURFACES));
    const sizes = new Set<Element>([...surfaces].flatMap((element) => [element, ...element.children]));
    for (const element of observed) if (!sizes.has(element)) resize.unobserve(element);
    for (const element of sizes) if (!observed.has(element)) resize.observe(element);
    observed = sizes;
    for (const element of watched) {
      if (surfaces.has(element)) continue;
      watched.delete(element);
    }
    const states = [...surfaces].map((element) => [element, scrollEdges(element)] as const);
    for (const [element, edges] of states) {
      watched.add(element);
      if (element.dataset['scrollEdges'] !== edges) element.dataset['scrollEdges'] = edges;
    }
  };
  const schedule = (): void => {
    if (frame === 0) frame = requestAnimationFrame(refresh);
  };
  const resize = new ResizeObserver(schedule);
  const mutations = new MutationObserver((records) => {
    if (records.some((record) =>
      record.attributeName === 'open' || record.target instanceof Element && record.target.closest(SURFACES) !== null ||
      [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof Element && (node.matches(SURFACES) || node.querySelector(SURFACES) !== null)),
    )) schedule();
  });
  const scroll = (event: Event): void => {
    if (event.target instanceof HTMLElement && watched.has(event.target)) schedule();
  };
  mutations.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['open', 'class', 'hidden'] });
  root.addEventListener('scroll', scroll, true);
  refresh();
  return () => {
    cancelAnimationFrame(frame);
    mutations.disconnect();
    resize.disconnect();
    root.removeEventListener('scroll', scroll, true);
  };
}

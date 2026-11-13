import { createAgent } from '@ui-sdk/react/agent';

export let approved = false;
export const agent = createAgent({ allow: (step) => !step.confirm || approved });
export function approve(): void { approved = true; }

import { createHostedProjectReceiver } from '../src/app/hosted-receiver.js';
import { hostedProject } from '../src/app/studio-host.js';
import { storageScope } from '../src/app/storage-scope.js';
import { projectKey } from './hosted-project-key-fixture.js';

const root = document.querySelector<HTMLElement>('#root')!;
const params = new URLSearchParams(location.search);
let editorBoots = 0;
const receiver = createHostedProjectReceiver({
  root,
  origin: 'https://account.example',
  ...(params.get('language') === 'de' ? { language: 'de' } : {}),
  bootEditor() { editorBoots += 1; },
});

const fixture = {
  ...receiver,
  projectKey: (bytes: number[]) => projectKey(new Uint8Array(bytes)),
  editorState: () => {
    const source = hostedProject();
    return {
      boots: editorBoots,
      scope: storageScope(),
      project: source && {
        id: source.projectId, origin: source.origin, device: source.device, extractable: source.key.extractable,
      },
    };
  },
};
Object.assign(window, { testHostedReceiver: fixture });

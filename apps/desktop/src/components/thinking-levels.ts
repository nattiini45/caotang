/** The thinking levels as the writer reads them, in one place for the roles panel and the chat window's picker (provider-gateway §6). */

import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { ThinkingLevel } from '@caotang/gateway';

export const THINKING_LEVEL_NAMES: Readonly<Record<ThinkingLevel, MessageDescriptor>> = {
  off: msg`Off`,
  low: msg`Low`,
  medium: msg`Medium`,
  high: msg`High`,
  xhigh: msg`Extra high`,
  max: msg`Max`,
};

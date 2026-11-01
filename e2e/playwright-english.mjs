/**
 * Playwright's pure-model specs import app modules whose `t`/`msg` macros compile to `i18n._`
 * calls. Lingui refuses to translate until a locale is active, and Playwright does not run the
 * app's runtime that activates English. An empty English catalogue is the exact fallback the app
 * uses for a message with no entry: `i18n._` returns the message id, which is the English ICU
 * source, with its values formatted.
 */
import { i18n } from '@lingui/core';

i18n.loadAndActivate({ locale: 'en', messages: {} });

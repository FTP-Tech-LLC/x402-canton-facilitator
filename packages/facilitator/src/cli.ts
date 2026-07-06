#!/usr/bin/env node
/**
 * CLI entrypoint for `@ftptech/x402-canton-facilitator`. Same code path
 * as running `node dist/server.js` directly; this file exists so the
 * package's `bin` field can map `canton-x402-facilitator` onto a
 * file that begins with a shebang. The published package's
 * `dist/cli.js` is what `npm install -g @ftptech/x402-canton-facilitator`
 * links into PATH.
 */
import "./server.js";

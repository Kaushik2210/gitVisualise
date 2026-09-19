// Cloudflare Worker entry point. Deploy with `wrangler deploy`; see README.md in this folder.
import { handle } from './exchange.mjs';

export default {
  fetch: (request, env) => handle(request, env),
};

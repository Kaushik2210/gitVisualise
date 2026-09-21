import { handle } from './exchange.mjs';

export default {
  async fetch(request, env) {
    return handle(request, env);
  },
};
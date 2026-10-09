import {handler} from './handler.mjs';
Deno.serve(handler({
 url:Deno.env.get('SUPABASE_URL'),
 key:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
}));

import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {nativeBotOAuthClient,NATIVE_WHATSAPP_BOT_CLIENT_ID} from '../oauth/nativeBotClient.js';

const read=(name:string)=>JSON.parse(readFileSync(new URL('../../'+name,import.meta.url),'utf8'));
describe('isolated Premium WhatsApp development host',()=>{
 it('uses its own Worker, domain and durable namespaces',()=>{
  const config=read('wrangler.premium-dev.jsonc'),pilot=read('wrangler.mcp.jsonc');
  expect(config.name).toBe('morning-whatsapp-premium-dev');expect(config.name).not.toBe(pilot.name);
  expect(config.main).toBe(pilot.main);expect(config.workers_dev).toBe(false);expect(config.preview_urls).toBe(false);
  expect(config.routes).toEqual([{pattern:'premium-whatsapp-dev.morningarp.com',custom_domain:true}]);
  expect(config.durable_objects).toEqual(pilot.durable_objects);expect(config.migrations).toEqual(pilot.migrations);
  expect(config.durable_objects.bindings.every((binding:Record<string,unknown>)=>!binding.script_name&&!binding.environment)).toBe(true);
  expect(config.services).toBeUndefined();expect(config.kv_namespaces).toBeUndefined();expect(config.d1_databases).toBeUndefined();
 });
 it('connects customer identity to Premium dev and enables exact native pairing',()=>{
  const {vars}=read('wrangler.premium-dev.jsonc');
  expect(vars.PUBLIC_ORIGIN).toBe('https://premium-whatsapp-dev.morningarp.com');
  expect(vars.MORNING_ISSUER).toBe('https://premium-dev.morningarp.com');
  expect(vars.MORNING_CUSTOMER_CLIENT_ID).toBe('whatsapp-customer');
  expect(nativeBotOAuthClient(vars.BOT_OAUTH_REDIRECT_URI)).toEqual({clientId:NATIVE_WHATSAPP_BOT_CLIENT_ID,redirectUris:['http://127.0.0.1:9468/callback']});
 });
 it('requires explicit provider credentials instead of inheriting the existing pilot',()=>{
  const {vars}=read('wrangler.premium-dev.jsonc');
  expect(Object.keys(vars).sort()).toEqual(['PUBLIC_ORIGIN','MORNING_ISSUER','MORNING_CUSTOMER_CLIENT_ID','BOT_OAUTH_REDIRECT_URI','META_GRAPH_API_VERSION','META_EMBEDDED_SIGNUP_SESSION_VERSION','OAUTH_SIGNING_KEY_ID','OAUTH_CLIENT_ID','OAUTH_REDIRECT_URI','CONVERSATION_MESSAGE_RETENTION_DAYS','CONVERSATION_INACTIVE_RETENTION_DAYS','CONVERSATION_PENDING_STATUS_RETENTION_DAYS','CONVERSATION_RETENTION_INTERVAL_HOURS'].sort());
  expect(vars.OAUTH_SIGNING_KEY_ID).toBe('premium-dev-2026-10-30');
 });
});

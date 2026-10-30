import {createCustomerRuntime} from './customerRuntime.js';
import {createPilotInstallationRegistry} from './pilotInstallationStore.js';
import {createMetaGraphClient} from './graphClient.js';
import {createDurableWhatsAppPolicyDirectory,createMetaMessagingCapability} from './messagingCapability.js';
import {readWhatsAppSandboxConfig,sandboxRecipientAllowed} from './sandboxConfig.js';
import type {PersistentWhatsAppWorkerEnv} from '../mcp/persistentWorker.js';

/** The durable alarm uses the same provider policy as incoming webhook work. */
export function createHostedCustomerRuntime(env:PersistentWhatsAppWorkerEnv){
 const registry=createPilotInstallationRegistry(env.PILOT_INSTALLATIONS),sandbox=readWhatsAppSandboxConfig(env);
 const graph=createMetaGraphClient({appId:env.META_APP_ID!,appSecret:env.META_APP_SECRET,graphVersion:env.META_GRAPH_API_VERSION!});
 const messaging=createMetaMessagingCapability({conversations:env.CONVERSATIONS,registry,graph,encryptionKey:env.INSTALLATION_ENCRYPTION_KEY!,policyDirectory:createDurableWhatsAppPolicyDirectory(env.CONVERSATIONS),
  recipientAllowed:(tenantId,recipient)=>tenantId===env.META_SANDBOX_TENANT_ID?sandboxRecipientAllowed(sandbox,tenantId,recipient):true});
 return createCustomerRuntime({conversations:env.CONVERSATIONS,registry,resource:env.PUBLIC_ORIGIN!,secret:env.CONVERSATION_REF_SECRET,messaging});
}

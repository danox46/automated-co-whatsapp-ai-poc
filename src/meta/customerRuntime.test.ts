import {describe,it,expect} from 'vitest';
import {updateCustomerRuntime,runtimeIsOffline} from './customerRuntime.js';

describe('customer offline configuration',()=>{
 it('keeps one outage identity, bounds writes and refuses stale settings',()=>{
  const report={revision:2,enabled:true,offlineMessage:'Back soon'};
  const first=updateCustomerRuntime(null,report,'owner','installation',100000);
  expect(updateCustomerRuntime(first,report,'owner','installation',110000)).toBe(first);
  const refreshed=updateCustomerRuntime(first,report,'owner','installation',160000);
  expect(refreshed.generation).toBe(first.generation);
  expect(runtimeIsOffline(refreshed,250000)).toBe(false);
  expect(runtimeIsOffline(refreshed,250001)).toBe(true);
  const reconnected=updateCustomerRuntime(refreshed,report,'owner','installation',250001);
  expect(reconnected.generation).not.toBe(first.generation);
  expect(()=>updateCustomerRuntime(first,{...report,revision:1},'owner','installation',100001)).toThrow('RUNTIME_SETTINGS_CONFLICT');
  expect(()=>updateCustomerRuntime(first,{...report,offlineMessage:'Changed at same revision'},'owner','installation',100001)).toThrow('RUNTIME_SETTINGS_CONFLICT');
 });
 it('pause and empty fallback never enable offline replies',()=>{
  for(const report of [{revision:1,enabled:false,offlineMessage:'Back soon'},{revision:1,enabled:true,offlineMessage:' '}]){
   const value=updateCustomerRuntime(null,report,'owner','installation',100000);expect(runtimeIsOffline(value,900000)).toBe(false);
  }
 });
});

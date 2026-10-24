import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestAuthMetadata } from '../lib/request-auth-metadata';
import { filteredProviderFetch } from '../lib/bounded-fetch';

test('auth metadata reports only presence/counts for a single-key request', () => {
    const metadata=requestAuthMetadata(new Request('https://unit.test/interactions/private-job?include_input=false', {headers:{'x-goog-api-key':'secret-key'}}));
    assert.deepEqual(metadata,{available:true,api_key_header_present:true,api_key_header_value_count:1,authorization_header_present:false,cookie_header_present:false,cookie_header_nonempty:false,credential_query_parameter_count:0,potential_credential_channel_count:1});
    assert.doesNotMatch(JSON.stringify(metadata),/secret-key|unit.test|private-job|include_input/);
});

test('auth metadata counts duplicate channels without exposing any values', () => {
    const metadata=requestAuthMetadata('https://unit.test/private?key=secret-one&key=secret-two&access_token=secret-three', {headers:[['x-goog-api-key','secret-four'],['x-goog-api-key','secret-five'],['authorization','Bearer secret-six'],['cookie','secret-seven']]});
    assert.deepEqual(metadata,{available:true,api_key_header_present:true,api_key_header_value_count:2,authorization_header_present:true,cookie_header_present:true,cookie_header_nonempty:true,credential_query_parameter_count:3,potential_credential_channel_count:4});
    assert.doesNotMatch(JSON.stringify(metadata),/secret-|Bearer|unit.test|private/);
    assert.deepEqual(requestAuthMetadata('invalid url'),{available:false});
});

test('poll wrapper observes metadata while forwarding the exact original request unchanged', async () => {
    const input=new Request('https://unit.test/interactions/private-job', {headers:{'x-goog-api-key':'old-secret'}});
    const init={method:'GET',headers:{'x-goog-api-key':'new-secret'}};
    const seen:unknown[]=[];let calls=0;
    const fetcher:typeof fetch=async(actualInput,actualInit)=>{calls++;assert.equal(actualInput,input);assert.equal(actualInit,init);return Response.json({status:'in_progress'});};
    const response=await filteredProviderFetch(1024,2048,fetcher,undefined,false,metadata=>seen.push(metadata))(input,init);
    assert.deepEqual(await response.json(),{status:'in_progress'});assert.equal(calls,1);
    assert.equal((seen[0] as ReturnType<typeof requestAuthMetadata>).api_key_header_value_count,1);
    assert.doesNotMatch(JSON.stringify(seen),/old-secret|new-secret|private-job|unit.test/);
});
